"use strict";
// 広告ダッシュボード フロントエンド (依存なし)

/* ---------------- Chrome 확장 통신 (브라우저 워커) ---------------- */
let EXT_READY = false;
let EXT_ID = null;
let RAKUTEN_SHOP_ID = null;  // 楽天 쿠키에서 자동 감지된 현재 shop_id
const _extReqMap = new Map();  // reqId → resolve
let _extReqSeq = 0;

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || typeof e.data !== 'object') return;
  if (e.data.__rpp_bridge === 'ready') {
    EXT_READY = true;
    EXT_ID = e.data.extensionId;
    console.log('[ext] ready, id=', EXT_ID);
    if (typeof _updateSessionPill === "function") _updateSessionPill();
  }
  if (e.data.__rpp_bridge === 'response') {
    const resolve = _extReqMap.get(e.data.reqId);
    if (resolve) {
      _extReqMap.delete(e.data.reqId);
      resolve(e.data.response || (e.data.error ? { error: e.data.error } : null));
    }
  }
  if (e.data.__rpp_bridge === 'event' && e.data.payload) {
    // 楽天 shop_id 자동 감지 알림
    if (e.data.payload.type === 'RAKUTEN_SHOP_ID' && e.data.payload.shopId) {
      const prev = RAKUTEN_SHOP_ID;
      RAKUTEN_SHOP_ID = e.data.payload.shopId;
      const pillShop = document.getElementById('pill-shop');
      if (pillShop) pillShop.textContent = `店舗 ${RAKUTEN_SHOP_ID}`;
      console.log(`[ext] rakuten shop_id = ${RAKUTEN_SHOP_ID} (prev=${prev})`);
      if (typeof _updateSessionPill === "function") _updateSessionPill();
      // 새 shop 잡힘 → 화면 일괄 갱신 (멀티테넌트 — config 갱신 불필요, view만 reload)
      if (prev !== RAKUTEN_SHOP_ID && typeof _autoSyncShopAndReload === "function") {
        _autoSyncShopAndReload();
      }
      // 새 shop 잡힘 → cookie 자동 저장 (가드 통과 시만)
      if (prev !== RAKUTEN_SHOP_ID && typeof _saveRakutenCookiesToCloud === "function") {
        setTimeout(() => _saveRakutenCookiesToCloud().catch(() => {}), 1500);
      }
    }
    // BACKFILL_PROGRESS 이벤트 처리
    const cbs = _extEventListeners.get(e.data.payload.type) || [];
    for (const cb of cbs) try { cb(e.data.payload); } catch (_) {}
  }
});
const _extEventListeners = new Map();
function ext_on(eventType, cb) {
  if (!_extEventListeners.has(eventType)) _extEventListeners.set(eventType, []);
  _extEventListeners.get(eventType).push(cb);
}
async function ext_call(payload) {
  if (!EXT_READY) throw new Error('拡張機能が見つかりません');
  return new Promise(resolve => {
    const reqId = ++_extReqSeq;
    _extReqMap.set(reqId, resolve);
    window.postMessage({ __rpp_bridge: 'request', reqId, payload }, '*');
    setTimeout(() => {
      if (_extReqMap.has(reqId)) {
        _extReqMap.delete(reqId);
        resolve({ error: 'timeout' });
      }
    }, 30000);
  });
}
// 페이지 로드 시 확장 ready 기다림 (1.5초)
function ensureExt(maxMs = 1500) {
  return new Promise(resolve => {
    if (EXT_READY) return resolve(true);
    const t = setInterval(() => {
      if (EXT_READY) { clearInterval(t); resolve(true); }
    }, 50);
    setTimeout(() => { clearInterval(t); resolve(EXT_READY); }, maxMs);
  });
}

/* ---------------- 인증 (Supabase Auth) ---------------- */
let AUTH_CFG = null;

async function loadAuthConfig() {
  if (AUTH_CFG) return AUTH_CFG;
  try {
    const r = await fetch("/api/auth/config");
    if (!r.ok) throw new Error("no auth config endpoint");
    const j = await r.json();
    // 응답에 supabase_url 없으면 인증 비활성화로 간주 (로컬 server.py 사용 시)
    AUTH_CFG = j.supabase_url ? j : { auth_disabled: true };
  } catch { AUTH_CFG = { auth_disabled: true }; }
  return AUTH_CFG;
}

function showLogin() {
  const m = document.getElementById("login-modal");
  if (m) m.classList.remove("hidden");
}
function hideLogin() {
  const m = document.getElementById("login-modal");
  if (m) m.classList.add("hidden");
}

function _showLoginError(html) {
  const el = document.getElementById("login-msg");
  if (!el) return;
  el.innerHTML = html;
  el.classList.remove("hidden");
}
function _hideLoginError() {
  const el = document.getElementById("login-msg");
  if (el) el.classList.add("hidden");
}
function _setLoginLoading(loading) {
  const btn = document.getElementById("btn-login");
  if (!btn) return;
  btn.disabled = loading;
  btn.querySelector(".login-btn-label").textContent = loading ? "ログイン中…" : "ログイン";
  btn.querySelector(".login-btn-spinner").classList.toggle("hidden", !loading);
}

// Supabase Auth 에러 → 사용자 친화 메시지
function _humanizeAuthError(j, status) {
  const code = j.error_code || j.code || j.error || "";
  const desc = j.error_description || j.msg || j.message || "";
  const map = {
    "invalid_credentials": "メールアドレスまたはパスワードが違います",
    "invalid_grant":       "メールアドレスまたはパスワードが違います",
    "email_not_confirmed": "メール確認が完了していません。受信メールのリンクを開いてください",
    "user_not_found":      "このメールアドレスのアカウントは存在しません",
    "too_many_requests":   "リクエストが多すぎます。しばらく待って再試行してください",
    "weak_password":       "パスワードが弱すぎます",
    "signup_disabled":     "サインアップが無効化されています",
    "over_email_send_rate_limit": "メール送信制限超過。少し待ってください",
  };
  if (map[code]) return `<b>${map[code]}</b>`;
  if (status === 400 && /credentials/i.test(desc)) return "<b>メールアドレスまたはパスワードが違います</b>";
  if (status === 422) return "<b>入力形式が正しくありません</b><br><span style='opacity:.7'>" + (desc || code) + "</span>";
  if (status === 429) return "<b>リクエストが多すぎます。1分後に再試行してください</b>";
  if (status >= 500) return "<b>Supabase サーバエラー</b><br><span style='opacity:.7'>" + (desc || "Status " + status) + "</span>";
  // フォールバック: 全部見せる (디버그용)
  return `<b>ログイン失敗 (HTTP ${status})</b><br><span style="opacity:.7">${escapeHtml(desc || code || JSON.stringify(j))}</span>`;
}

function _resolveLoginEmail(rawInput, cfg) {
  // ID 만 입력하는 흐름: LOGIN_DOMAIN 설정되어 있고 입력에 @ 없으면 자동 부착
  const raw = (rawInput || "").trim();
  if (!raw) return "";
  if (raw.includes("@")) return raw;  // 이미 이메일 형태
  const dom = (cfg.login_domain || "").trim().replace(/^@/, "");
  if (!dom) return raw;  // 도메인 미설정 → 그대로 (Supabase 가 검증 실패하면 에러)
  return `${raw}@${dom}`;
}

async function doLogin() {
  const cfg = await loadAuthConfig();
  const rawInput = document.getElementById("login-email").value.trim();
  const email = _resolveLoginEmail(rawInput, cfg);
  const pwd = document.getElementById("login-password").value;
  _hideLoginError();
  const isIdMode = !!cfg.login_domain;
  if (!rawInput) { _showLoginError(`<b>${isIdMode ? "ユーザーID" : "メールアドレス"}を入力してください</b>`); return; }
  if (!pwd)   { _showLoginError("<b>パスワードを入力してください</b>"); return; }
  if (!cfg.supabase_url) { _showLoginError("<b>サーバ設定エラー</b><br>SUPABASE_URL が未設定です"); return; }
  if (!cfg.supabase_anon_key) { _showLoginError("<b>サーバ設定エラー</b><br>SUPABASE_ANON_KEY が未設定です"); return; }
  _setLoginLoading(true);
  try {
    const r = await fetch(`${cfg.supabase_url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": cfg.supabase_anon_key },
      body: JSON.stringify({ email, password: pwd }),
    });
    let j = {};
    try { j = await r.json(); } catch { /* non-json response */ }
    if (!r.ok) {
      console.warn("[login] Supabase response:", r.status, j);
      _showLoginError(_humanizeAuthError(j, r.status));
      return;
    }
    if (!j.access_token) {
      _showLoginError("<b>ログイン応答に access_token がありません</b><br><span style='opacity:.7'>" + escapeHtml(JSON.stringify(j)) + "</span>");
      return;
    }
    sessionStorage.setItem("sb_access_token", j.access_token);
    sessionStorage.setItem("sb_refresh_token", j.refresh_token || "");
    hideLogin();
    location.reload();
  } catch (e) {
    _showLoginError("<b>通信エラー</b><br><span style='opacity:.7'>" + escapeHtml(e.message) + "</span>");
  } finally {
    _setLoginLoading(false);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  // 비번 보이기/숨기기 토글 (인증 비활성화 여부와 관계없이 작동)
  const toggle = document.getElementById("btn-pw-toggle");
  const pwd = document.getElementById("login-password");
  const email = document.getElementById("login-email");
  if (toggle && pwd) {
    toggle.addEventListener("click", () => {
      const isPwd = pwd.type === "password";
      pwd.type = isPwd ? "text" : "password";
      toggle.querySelector(".ico-eye").classList.toggle("hidden", isPwd);
      toggle.querySelector(".ico-eye-off").classList.toggle("hidden", !isPwd);
      toggle.setAttribute("aria-label", isPwd ? "パスワードを隠す" : "パスワードを表示");
      pwd.focus();
    });
  }
  // Enter 키 로그인
  [email, pwd].forEach(el => {
    if (el) el.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
  });
  // 로그인 버튼
  const btn = document.getElementById("btn-login");
  if (btn) btn.addEventListener("click", doLogin);

  // 인증 활성 여부 확인 후 모달 표시 결정
  const cfg = await loadAuthConfig();
  if (cfg.auth_disabled) return; // 로컬 server.py
  // 로그인 폼 라벨 (ID 모드 vs 이메일 모드)
  if (cfg.login_domain) {
    const lbl = document.getElementById("login-email-label");
    const inp = document.getElementById("login-email");
    const hint = document.getElementById("login-email-hint");
    if (lbl) lbl.textContent = "ユーザーID";
    if (inp) { inp.placeholder = "yourname"; inp.type = "text"; }
    if (hint) {
      hint.textContent = `※ 「ID」だけ入力してください (内部で @${cfg.login_domain} を付加します)`;
      hint.style.display = "block";
    }
  }
  const tok = sessionStorage.getItem("sb_access_token");
  if (!tok) showLogin();
  // 사이드바 사용자 pill + 로그아웃
  _updateMePill();
  const btnLogout = document.getElementById("btn-logout");
  if (btnLogout) btnLogout.onclick = async () => {
    if (!confirm("ログアウトしますか？\n\n楽天RMSのCookieも一緒にクリアします (次のログイン時に復元)")) return;
    // 1) 현재 楽天 cookies 저장 (다음 로그인 시 복원용)
    try { await _saveRakutenCookiesToCloud(); } catch (e) { console.warn("[logout] save cookies failed:", e); }
    // 2) 楽天 cookies 삭제 (다른 멤버가 우리 앱 로그인 시 옛 cookie 안 남게)
    try { await ext_call({ type: 'CLEAR_RAKUTEN_COOKIES' }); } catch {}
    // 3) 楽天 탭 새로고침 → 로그아웃된 RMS 화면이 보임
    try { await ext_call({ type: 'RELOAD_RAKUTEN_TABS' }); } catch {}
    // 4) 우리 앱 세션 끊기
    sessionStorage.removeItem("sb_access_token");
    sessionStorage.removeItem("sb_refresh_token");
    location.reload();
  };

  // 로그인된 상태면 본인 楽天 cookies 자동 복원 (페이지 진입 시 1회).
  if (tok) {
    setTimeout(() => _restoreRakutenCookiesFromCloud().catch(() => {}), 2500);
    // 자동 갱신 (cookie 만료 따라잡기): 30분마다, 안전 가드 적용 (본인 + 같은 shop 만)
    setInterval(() => _saveRakutenCookiesToCloud().catch(() => {}), 30 * 60 * 1000);
  }
});

// 楽天 cookies 백업: 확장에서 수집 → Supabase 본인 row 에 upsert.
// opts.explicit=true → 명시적 사용자 액션 (가드 X, 다른 shop 도 저장).
// opts.explicit 없음 → 자동 갱신 (안전 가드: 본인 row 있고 같은 shop 일 때만).
async function _saveRakutenCookiesToCloud(opts = {}) {
  if (!EXT_READY) return false;
  const me = _fbCurrentUser ? _fbCurrentUser() : null;
  if (!me) return false;
  const r = await ext_call({ type: 'GET_RAKUTEN_COOKIES_FULL' });
  if (!r?.ok || !r.cookies || !r.cookies.length) return false;
  const liveShop = r.shopId || null;
  // ── 자동 갱신 안전 가드 ──
  // 안전 전제: 우리 앱 로그인 직후 _restoreRakutenCookiesFromCloud 가 옛 cookie CLEAR.
  // 그 후 RAKUTEN_SHOP_ID 가 잡혔다 = 멤버가 본인 楽天 RMS 직접 로그인했음 = 본인 cookie.
  let isFirstReg = false;
  if (!opts.explicit) {
    if (!liveShop) return false;  // shop 못 잡으면 안 함
    try {
      const ex = await _sbFetch(`member_rakuten_cookies?user_id=eq.${me.id}&select=shop_id`);
      if (!ex.ok) return false;
      const rows = await ex.json();
      if (rows.length) {
        // 기존 row — 같은 shop 일 때만 갱신
        if (String(rows[0].shop_id || "") !== String(liveShop)) {
          console.log(`[cookies] 自動更新スキップ — shop 不一致 (DB ${rows[0].shop_id} / live ${liveShop}) — 別アカウントへの切替は「📌 楽天連携を保存」`);
          return false;
        }
      } else {
        isFirstReg = true;  // 첫 등록 — 옛 cookie 는 이미 CLEAR 됐으니 안전
      }
    } catch { return false; }
  }
  // ── 저장 ──
  const payload = {
    user_id: me.id,
    user_email: me.email,
    shop_id: liveShop,
    cookies: r.cookies,
  };
  try {
    await _sbFetch("member_rakuten_cookies?on_conflict=user_id", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(payload),
    });
    console.log(`[cookies] saved ${r.cookies.length} shop=${liveShop} explicit=${!!opts.explicit} firstReg=${isFirstReg}`);
    if (isFirstReg) {
      toast(`楽天連携を自動保存しました (shop ${liveShop})`, "ok");
    }
    return true;
  } catch (e) { console.warn("[cookies] save fail:", e); return false; }
}

// 楽天 cookies 복원: Supabase 본인 row 에서 가져옴 → 확장에서 chrome.cookies.set.
// 흐름:
//   - DB 에 본인 cookie 있으면 → 무조건 덮어쓰기 (다른 사람 cookie 가 남아있어도)
//   - DB 에 없으면 → 안내 토스트
async function _restoreRakutenCookiesFromCloud() {
  if (!EXT_READY) return;
  const me = _fbCurrentUser ? _fbCurrentUser() : null;
  if (!me) return;
  try {
    const r = await _sbFetch(`member_rakuten_cookies?user_id=eq.${me.id}&select=*`);
    if (!r.ok) return;
    const rows = await r.json();
    if (!rows.length || !(rows[0].cookies || []).length) {
      // 처음 사용 — 楽天 직접 로그인 안내
      const myShop = RAKUTEN_SHOP_ID || "—";
      console.log("[cookies] 保存済み cookie なし shop=", myShop);
      // 다른 사람 cookie 가 남아있으면 먼저 비움
      if (RAKUTEN_SHOP_ID) {
        await ext_call({ type: 'CLEAR_RAKUTEN_COOKIES' }).catch(() => {});
        toast("以前のユーザーの楽天 Cookie をクリアしました — 楽天 RMS にログインしてください", "ok");
      } else {
        toast("楽天 RMS にログインしてから「楽天連携を保存」を押してください", "ok");
      }
      return;
    }
    const data = rows[0];
    const cookies = data.cookies;
    // 본인이 이미 같은 shop 으로 로그인 중이면 복원 불필요
    if (RAKUTEN_SHOP_ID && String(RAKUTEN_SHOP_ID) === String(data.shop_id || "")) {
      console.log("[cookies] 既に同じ shop でログイン中 — 復元スキップ");
      return;
    }
    // 다른 사람 cookie 가 남아있으면 먼저 비움 (옛 cookie 와 새 cookie 섞이지 않게)
    await ext_call({ type: 'CLEAR_RAKUTEN_COOKIES' }).catch(() => {});
    const setRes = await ext_call({ type: 'SET_RAKUTEN_COOKIES', cookies });
    console.log("[cookies] restored", setRes);
    toast(`楽天 RMS にログイン状態を復元しました (shop ${data.shop_id || "?"})`, "ok");
    // 楽天 탭이 열려있으면 새로고침, 없으면 백그라운드 탭으로 열기
    // (cookie 만 set 해도 既存 탭은 옛 화면 그대로 — 새로고침해야 새 로그인 반영)
    await ext_call({ type: 'OPEN_RAKUTEN_TAB', background: true }).catch(() => {});
    // 복원 후 shop_id 재감지 + 화면 자동 갱신 (F5 없이)
    await _refreshAfterRakutenChange();
  } catch (e) { console.warn("[cookies] restore fail:", e); }
}

// 楽天 cookie 변경 후 (복원 / 자동 전환 등) 우리 앱 측 상태 동기화
async function _refreshAfterRakutenChange() {
  try {
    // 확장에 shop_id 재조회 (RAKUTEN_SHOP_ID 가 변수에 갱신됨)
    const r = await ext_call({ type: 'GET_RAKUTEN_SHOP_ID' });
    if (r && r.shopId) {
      RAKUTEN_SHOP_ID = r.shopId;
      const pillShop = document.getElementById('pill-shop');
      if (pillShop) pillShop.textContent = `店舗 ${RAKUTEN_SHOP_ID}`;
    } else {
      RAKUTEN_SHOP_ID = null;
    }
    if (typeof _updateSessionPill === "function") _updateSessionPill();
    // config 동기화 + 현재 view 리로드
    if (typeof _autoSyncShopAndReload === "function") await _autoSyncShopAndReload();
    else { loadStatus(); loadCoverage(); }
    // 우리 앱 측 갱신 완료 후 RMS 탭도 새로고침 (사용자 요구)
    try { await ext_call({ type: 'RELOAD_RAKUTEN_TABS' }); } catch {}
  } catch (e) { console.warn("[refreshAfterRakuten] fail:", e); }
}

// 사용자 명시적 호출: 현재 楽天 cookie 를 본인 row 에 저장
async function saveRakutenLinkExplicit() {
  if (!EXT_READY) return toast("拡張機能が見つかりません", true);
  const me = _fbCurrentUser ? _fbCurrentUser() : null;
  if (!me) return toast("ログインしてください", true);
  if (!RAKUTEN_SHOP_ID) return toast("先に楽天 RMS にログインしてください", true);
  if (!confirm(
    `現在の楽天 RMS ログイン (shop ${RAKUTEN_SHOP_ID}) を ` +
    `あなた (${me.email}) のアカウントに保存します。\n\n` +
    `次回ログイン時に自動復元されます。\n\n` +
    `※ 楽天 アカウント情報を Supabase に保存することになります。続行しますか?`
  )) return;
  try {
    await _saveRakutenCookiesToCloud({ explicit: true });
    toast(`楽天連携を保存しました (shop ${RAKUTEN_SHOP_ID})`, "ok");
    await _refreshAfterRakutenChange();
  } catch (e) { toast("保存失敗: " + e.message, true); }
}
// 외부 노출 (사이드바 버튼)
window.saveRakutenLinkExplicit = saveRakutenLinkExplicit;

function _updateMePill() {
  const pill = document.getElementById("me-pill");
  if (!pill) return;
  const tok = sessionStorage.getItem("sb_access_token");
  if (!tok) { pill.classList.add("hidden"); return; }
  try {
    const payload = JSON.parse(atob(tok.split(".")[1]));
    const email = payload.email || "";
    const adminEmail = (AUTH_CFG && AUTH_CFG.admin_email) ? AUTH_CFG.admin_email.toLowerCase() : "";
    const isAdmin = adminEmail && email.toLowerCase() === adminEmail;
    document.getElementById("me-avatar").textContent = (email.slice(0, 2) || "??").toUpperCase();
    document.getElementById("me-avatar").classList.toggle("me-avatar-admin", !!isAdmin);
    document.getElementById("me-email").textContent = email;
    pill.classList.remove("hidden");
  } catch { pill.classList.add("hidden"); }
}


const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// 인증 헤더 자동 첨부 (Supabase JWT, 로컬에선 없으면 빈 헤더)
function _authHeaders() {
  const tok = sessionStorage.getItem("sb_access_token");
  return tok ? { "Authorization": "Bearer " + tok } : {};
}
function _clearTokens() {
  sessionStorage.removeItem("sb_access_token");
  sessionStorage.removeItem("sb_refresh_token");
}
let _refreshInFlight = null;
async function _tryRefreshToken() {
  // 동시 호출 합치기 (백필 중 N개 요청이 동시에 401 → refresh 1회만)
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async () => {
    const rt = sessionStorage.getItem("sb_refresh_token");
    if (!rt) return false;
    const cfg = await loadAuthConfig();
    if (!cfg.supabase_url || !cfg.supabase_anon_key) return false;
    try {
      const r = await fetch(`${cfg.supabase_url}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": cfg.supabase_anon_key },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!r.ok) return false;
      const j = await r.json();
      if (!j.access_token) return false;
      sessionStorage.setItem("sb_access_token", j.access_token);
      if (j.refresh_token) sessionStorage.setItem("sb_refresh_token", j.refresh_token);
      return true;
    } catch { return false; }
    finally { setTimeout(() => { _refreshInFlight = null; }, 0); }
  })();
  return _refreshInFlight;
}
function _stringifyErr(j, status) {
  // FastAPI 422 → {detail: [{loc, msg, type}, ...]} (배열)
  // FastAPI 401 → {detail: "..."} (문자열)
  // 일반 → {error: "..."}
  if (typeof j === "string") return j;
  const d = j && j.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map(e => (e.loc ? e.loc.join(".") + ": " : "") + (e.msg || JSON.stringify(e))).join("; ");
  if (j && j.error) return typeof j.error === "string" ? j.error : JSON.stringify(j.error);
  return "HTTP " + status + " " + JSON.stringify(j);
}
function _withShopId(path) {
  // 楽天 자동 감지된 shop_id 를 모든 /api/ 호출에 자동 첨부 (멀티 테넌트).
  if (!RAKUTEN_SHOP_ID) return path;
  if (!path.startsWith("/api/")) return path;
  if (path.includes("shop_id=")) return path;
  const sep = path.includes("?") ? "&" : "?";
  return path + sep + "shop_id=" + encodeURIComponent(RAKUTEN_SHOP_ID);
}
async function _doFetch(method, path, body) {
  const init = { method, headers: { ..._authHeaders() } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    // POST body 에도 shop_id 자동 첨부 (서버가 body 로도 받을 수 있게)
    if (RAKUTEN_SHOP_ID && body && typeof body === "object" && !Array.isArray(body) && !body.shop_id) {
      body = { ...body, shop_id: RAKUTEN_SHOP_ID };
    }
    init.body = JSON.stringify(body);
  }
  return fetch(_withShopId(path), init);
}
async function _apiRequest(method, path, body) {
  let r = await _doFetch(method, path, body);
  if (r.status === 401) {
    // access token 만료 가능성 → refresh 후 1회 재시도
    const refreshed = await _tryRefreshToken();
    if (refreshed) {
      r = await _doFetch(method, path, body);
    }
    if (r.status === 401) {
      _clearTokens();
      if (typeof showLogin === "function") showLogin();
      throw new Error("ログインが必要です");
    }
  }
  let j; try { j = await r.json(); } catch { j = {}; }
  if (!r.ok) throw new Error(_stringifyErr(j, r.status));
  return j;
}
const api = {
  get(path) { return _apiRequest("GET", path); },
  post(path, body) { return _apiRequest("POST", path, body || {}); },
};
const fmt = n => (n === null || n === undefined) ? "—" : Number(n).toLocaleString("ko-KR");
let MONEY_UNIT = "yen"; // 'yen' | 'man'(万円)
const fmtMoney = n => {
  if (n === null || n === undefined) return "—";
  if (MONEY_UNIT === "man" && Math.abs(n) >= 10000)
    return "¥" + (n / 1e4).toLocaleString("ko-KR", { maximumFractionDigits: 1 }) + "万";
  return "¥" + Math.round(n).toLocaleString("ko-KR");
};
// 비율(0.08) → 퍼센트 표시(8%). roas는 정수%, ctr/cvr은 소수 2자리.
const fmtRoas = n => (n === null || n === undefined) ? "—" : Math.round(n * 100).toLocaleString("ko-KR") + "%";
const fmtPct = (n, d = 2) => (n === null || n === undefined) ? "—" : (n * 100).toFixed(d) + "%";
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, d) => { const t = new Date(iso); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); };

/* ---------------- カスタム日付ピッカー ---------------- */
let dpEl = null, dpInput = null, dpView = null;
function closePicker() {
  if (dpEl) { dpEl.remove(); dpEl = null; dpInput = null; document.removeEventListener("mousedown", dpOutside); }
}
function dpOutside(e) { if (dpEl && !dpEl.contains(e.target) && e.target !== dpInput) closePicker(); }
function attachPicker(input, mode) {
  if (!input || input.dataset.dpReady) return;
  input.dataset.dpReady = "1"; input.readOnly = true; input.classList.add("dp-input");
  input.addEventListener("click", () => openPicker(input, mode));
}
function openPicker(input, mode) {
  if (dpInput === input) return closePicker();
  closePicker();
  dpInput = input;
  const t = new Date(), v = input.value || "";
  const [yy, mm, dd] = v.split("-");
  dpView = { y: +yy || t.getFullYear(), m: mm ? +mm - 1 : t.getMonth(), mode, sel: v };
  dpEl = document.createElement("div"); dpEl.className = "dp-pop";
  document.body.appendChild(dpEl);
  renderPicker();
  const r = input.getBoundingClientRect();
  dpEl.style.left = Math.min(r.left + window.scrollX, window.innerWidth - 270) + "px";
  dpEl.style.top = (r.bottom + 6 + window.scrollY) + "px";
  setTimeout(() => document.addEventListener("mousedown", dpOutside), 0);
}
function renderPicker() {
  const { y, m, mode } = dpView;
  if (mode === "month") {
    const MN = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
    // 2년 cutoff: 오늘 기준 2년 전 그 달의 1일부터 (예: 2026-06-17 → 2024-06)
    const td = new Date();
    const minYM = `${td.getFullYear() - 2}-${String(td.getMonth() + 1).padStart(2, "0")}`;
    const maxYM = `${td.getFullYear()}-${String(td.getMonth() + 1).padStart(2, "0")}`;
    let h = `<div class="dp-head"><button data-nav="-1">‹</button><span>${y}年</span><button data-nav="1">›</button></div><div class="dp-months">`;
    for (let i = 0; i < 12; i++) {
      const val = `${y}-${String(i + 1).padStart(2, "0")}`;
      const disabled = val < minYM || val > maxYM;
      h += `<button class="dp-cell${dpView.sel === val ? " sel" : ""}${disabled ? " disabled" : ""}" data-val="${val}" ${disabled ? "disabled" : ""}>${MN[i]}</button>`;
    }
    dpEl.innerHTML = h + "</div>";
  } else {
    const start = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
    const t = new Date(), ts = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    let h = `<div class="dp-head"><button data-nav="-1">‹</button><span>${y}年 ${m + 1}月</span><button data-nav="1">›</button></div><div class="dp-grid">`;
    h += ["日", "月", "火", "水", "木", "金", "土"].map(w => `<div class="dp-wd">${w}</div>`).join("");
    for (let i = 0; i < start; i++) h += "<div></div>";
    for (let d = 1; d <= days; d++) { const val = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`; h += `<button class="dp-cell ${val === dpView.sel ? "sel" : ""} ${val === ts ? "today" : ""}" data-val="${val}">${d}</button>`; }
    dpEl.innerHTML = h + "</div>";
  }
  dpEl.querySelectorAll("[data-nav]").forEach(b => b.onclick = () => {
    const n = +b.dataset.nav;
    if (dpView.mode === "month") dpView.y += n;
    else { dpView.m += n; if (dpView.m < 0) { dpView.m += 12; dpView.y--; } if (dpView.m > 11) { dpView.m -= 12; dpView.y++; } }
    renderPicker();
  });
  dpEl.querySelectorAll("[data-val]").forEach(b => b.onclick = () => {
    dpInput.value = b.dataset.val;
    dpInput.dispatchEvent(new Event("change", { bubbles: true }));
    closePicker();
  });
}
window.addEventListener("resize", closePicker);

let STATUS = {};
const VIEW_TITLES = { collect: "データ取得", dashboard: "ダッシュボード", analysis: "商品ｘキーワード", product: "商品ｘキーワード", matrix: "商品ｘキーワード", compare: "商品ｘキーワード", report: "レポート", feedback: "お問い合わせ" };

function toast(msg, kind) {
  const t = $("#toast");
  const cls = (kind === true || kind === "err") ? "err" : (kind === "ok" ? "ok" : "");
  const ic = cls === "err" ? "!" : (cls === "ok" ? "✓" : "i");
  t.className = "toast " + cls;
  // 닫기 버튼 + 내용
  t.innerHTML = `<span class="ti">${ic}</span><span class="tt">${msg}</span><button class="tx" title="閉じる">✕</button>`;
  t.classList.remove("hidden"); void t.offsetWidth; t.classList.add("show");
  clearTimeout(t._tm);
  // 에러는 더 길게, 일반은 4초 (이전 1.6s → 4s로 천천히)
  const ms = cls === "err" ? 6000 : 4000;
  const dismiss = () => { t.classList.remove("show"); setTimeout(() => t.classList.add("hidden"), 220); };
  t._tm = setTimeout(dismiss, ms);
  t.querySelector(".tx").onclick = dismiss;
}

/* ---------------- 뷰 전환 ---------------- */
$$(".nav-item").forEach(b => b.onclick = () => switchView(b.dataset.view));
function switchView(v) {
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  $$(".view").forEach(s => s.classList.add("hidden"));
  $("#view-" + v).classList.remove("hidden");
  $("#view-title").textContent = VIEW_TITLES[v];
  if (v === "dashboard") loadDashboard();
  if (v === "analysis") loadAnalysisView();
  if (v === "report") loadReportView();
  if (v === "feedback") loadFeedbackView();
}

/* ==================== お問い合わせ / Q&A 게시판 ==================== */
const FB_CAT_META = {
  question: { label: "質問",     icon: "❓", color: "#1d4ed8" },
  bug:      { label: "バグ",     icon: "🐛", color: "#bf0000" },
  feature:  { label: "機能要望", icon: "✨", color: "#7c3aed" },
  other:    { label: "その他",   icon: "📝", color: "#64748b" },
};
const FB_STATUS_META = {
  open:      { label: "未対応", color: "#f59e0b", bg: "#fef3c7" },
  answered:  { label: "回答済", color: "#0c7a3e", bg: "#dcfce7" },
  resolved:  { label: "解決済", color: "#5a6173", bg: "#e5e7eb" },
  wont_fix:  { label: "対象外", color: "#94a3b8", bg: "#f1f5f9" },
};
let FB_STATE = {
  category: "all",
  query: "",
  posts: [],
  selectedId: null,
  attachments: [],
  modalEditId: null,
  replyCounts: {},
  reactionsByPost: {},   // {post_id: [{emoji, count, mine}]}
  reactionsByReply: {},  // {reply_id: [{emoji, count, mine}]}
  typingTimers: {},      // {post_id: timer}
  typingDisplay: {},     // {post_id: {email, until}}
};
let FB_INIT = false;
let FB_SB = null;        // Supabase JS client (realtime 전용)
let FB_REALTIME = null;  // 활성 channel
const FB_EMOJIS = ["👍", "❤️", "🎉", "😄", "🙏", "✅"];
const FB_DRAFT_KEY = "fb_draft_v1";

// 본문 안전 렌더 + 링크 자동감지
function _fbRenderBody(text) {
  const esc = escapeHtml(text || "");
  // URL 매칭 (http(s)://) — escape 한 결과의 &amp; 도 정상 처리
  const re = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g;
  return esc
    .replace(re, '<a href="$1" target="_blank" rel="noopener" class="fb-link">$1</a>')
    .replace(/\n/g, "<br>");
}

function _fbDraftSave(data) {
  try { localStorage.setItem(FB_DRAFT_KEY, JSON.stringify(data || {})); } catch {}
}
function _fbDraftLoad() {
  try { return JSON.parse(localStorage.getItem(FB_DRAFT_KEY) || "null"); } catch { return null; }
}
function _fbDraftClear() {
  try { localStorage.removeItem(FB_DRAFT_KEY); } catch {}
}

function _fbSbClient() {
  if (FB_SB) return FB_SB;
  if (!window.supabase || !AUTH_CFG) return null;
  FB_SB = window.supabase.createClient(AUTH_CFG.supabase_url, AUTH_CFG.supabase_anon_key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 5 } },
  });
  const tok = sessionStorage.getItem("sb_access_token");
  if (tok) FB_SB.realtime.setAuth(tok);
  return FB_SB;
}

async function _sbFetch(path, opts = {}) {
  const cfg = await loadAuthConfig();
  const doFetch = () => {
    const tok = sessionStorage.getItem("sb_access_token");
    const headers = {
      "apikey": cfg.supabase_anon_key,
      "Authorization": "Bearer " + tok,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    };
    return fetch(`${cfg.supabase_url}/rest/v1/${path}`, { ...opts, headers });
  };
  let r = await doFetch();
  if (r.status === 401) {
    // JWT 만료 가능성 → refresh 후 재시도. Realtime 토큰도 갱신.
    const refreshed = await _tryRefreshToken();
    if (refreshed) {
      if (FB_SB) try { FB_SB.realtime.setAuth(sessionStorage.getItem("sb_access_token")); } catch {}
      r = await doFetch();
    }
    if (r.status === 401) {
      _clearTokens();
      if (typeof showLogin === "function") showLogin();
    }
  }
  return r;
}
async function _sbStorageUpload(file) {
  const cfg = await loadAuthConfig();
  const ext = (file.name.split(".").pop() || "png").toLowerCase();
  const ts = String(Date.now()).slice(-9);
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${ts}_${rand}.${ext}`;
  const doUpload = () => {
    const tok = sessionStorage.getItem("sb_access_token");
    return fetch(
      `${cfg.supabase_url}/storage/v1/object/feedback-attachments/${path}`,
      { method: "POST", headers: { "Authorization": "Bearer " + tok, "Content-Type": file.type || "application/octet-stream" }, body: file });
  };
  let r = await doUpload();
  if (r.status === 401) {
    const refreshed = await _tryRefreshToken();
    if (refreshed) {
      if (FB_SB) try { FB_SB.realtime.setAuth(sessionStorage.getItem("sb_access_token")); } catch {}
      r = await doUpload();
    }
  }
  if (!r.ok) throw new Error(`storage upload ${r.status}`);
  return path;
}
function _sbPublicUrl(path) {
  // loadAuthConfig 는 cached 라 동기 접근 가능
  return `${AUTH_CFG.supabase_url}/storage/v1/object/public/feedback-attachments/${path}`;
}

function _fbNormEmail(e) {
  return (e || "").trim().toLowerCase();
}
function _fbCurrentUser() {
  const tok = sessionStorage.getItem("sb_access_token");
  if (!tok) return null;
  try {
    const payload = JSON.parse(atob(tok.split(".")[1]));
    const email = payload.email || "";
    const adminEmail = _fbNormEmail(AUTH_CFG && AUTH_CFG.admin_email);
    const isAdmin = !!adminEmail && _fbNormEmail(email) === adminEmail;
    return { id: payload.sub, email, isAdmin };
  } catch { return null; }
}
function _fbIsAdminEmail(email) {
  const adminEmail = _fbNormEmail(AUTH_CFG && AUTH_CFG.admin_email);
  return !!adminEmail && _fbNormEmail(email) === adminEmail;
}
// 디버그용: 콘솔에서 fbDebug() 입력하면 admin 매칭 상태 출력
window.fbDebug = () => {
  const me = _fbCurrentUser();
  console.log("[fb-debug] AUTH_CFG.admin_email =", AUTH_CFG?.admin_email);
  console.log("[fb-debug] login email           =", me?.email);
  console.log("[fb-debug] normalized admin      =", _fbNormEmail(AUTH_CFG?.admin_email));
  console.log("[fb-debug] normalized login      =", _fbNormEmail(me?.email));
  console.log("[fb-debug] isAdmin               =", me?.isAdmin);
  return me;
};

// 이미지 라이트박스 (새 탭 대신 화면 위 모달)
function _fbOpenLightbox(srcs, startIdx) {
  if (!Array.isArray(srcs)) srcs = [srcs];
  let idx = Math.max(0, Math.min(startIdx || 0, srcs.length - 1));
  const exist = document.getElementById("fb-lightbox");
  if (exist) exist.remove();
  const lb = document.createElement("div");
  lb.id = "fb-lightbox";
  lb.className = "fb-lightbox";
  lb.innerHTML = `
    <button class="fb-lb-close" title="閉じる (Esc)">✕</button>
    ${srcs.length > 1 ? `<button class="fb-lb-prev" title="前">‹</button><button class="fb-lb-next" title="次">›</button>` : ""}
    <div class="fb-lb-stage"><img id="fb-lb-img" src="${srcs[idx]}" alt=""></div>
    ${srcs.length > 1 ? `<div class="fb-lb-counter">${idx + 1} / ${srcs.length}</div>` : ""}
  `;
  document.body.appendChild(lb);
  const close = () => {
    lb.remove();
    document.removeEventListener("keydown", onKey);
  };
  const show = (n) => {
    idx = (n + srcs.length) % srcs.length;
    document.getElementById("fb-lb-img").src = srcs[idx];
    const c = lb.querySelector(".fb-lb-counter");
    if (c) c.textContent = `${idx + 1} / ${srcs.length}`;
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "ArrowRight") show(idx + 1);
    if (e.key === "ArrowLeft") show(idx - 1);
  };
  lb.querySelector(".fb-lb-close").onclick = close;
  lb.querySelector(".fb-lb-prev")?.addEventListener("click", (e) => { e.stopPropagation(); show(idx - 1); });
  lb.querySelector(".fb-lb-next")?.addEventListener("click", (e) => { e.stopPropagation(); show(idx + 1); });
  lb.addEventListener("click", (e) => { if (e.target === lb) close(); });
  document.addEventListener("keydown", onKey);
}

function _fbRelTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "今";
  if (diff < 3600) return Math.floor(diff / 60) + "分前";
  if (diff < 86400) return Math.floor(diff / 3600) + "時間前";
  if (diff < 604800) return Math.floor(diff / 86400) + "日前";
  return d.toLocaleDateString("ja-JP");
}

async function loadFeedbackView() {
  if (!FB_INIT) {
    _fbBindEvents();
    _fbInitRealtime();
    FB_INIT = true;
  }
  await _fbReloadList();
}

function _fbInitRealtime() {
  const sb = _fbSbClient();
  if (!sb) return;
  if (FB_REALTIME) { try { sb.removeChannel(FB_REALTIME); } catch {} }
  FB_REALTIME = sb.channel("feedback-room", { config: { broadcast: { self: false } } })
    .on("postgres_changes", { event: "*", schema: "public", table: "feedback_posts" }, () => _fbReloadList())
    .on("postgres_changes", { event: "*", schema: "public", table: "feedback_replies" }, (payload) => {
      const pid = payload.new?.post_id || payload.old?.post_id;
      // 토스트 (다른 사람 새 답글)
      if (payload.eventType === "INSERT") {
        const me = _fbCurrentUser();
        if (payload.new && me?.id !== payload.new.user_id) {
          if (FB_STATE.selectedId !== pid) toast("💬 新しい返信があります", "ok");
        }
      }
      if (FB_STATE.selectedId === pid) _fbSelectPost(pid);
      _fbReloadList();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "feedback_reactions" }, () => {
      if (FB_STATE.selectedId) _fbLoadReactions([FB_STATE.selectedId]);
      _fbReloadList();
    })
    .on("broadcast", { event: "typing" }, (msg) => {
      const { post_id, email } = msg.payload || {};
      if (!post_id) return;
      FB_STATE.typingDisplay[post_id] = { email, until: Date.now() + 4000 };
      _fbRenderTyping(post_id);
    })
    .subscribe();
}

function _fbBroadcastTyping(post_id) {
  if (!FB_REALTIME) return;
  const me = _fbCurrentUser();
  try {
    FB_REALTIME.send({ type: "broadcast", event: "typing",
      payload: { post_id, email: me?.email || "?" } });
  } catch {}
}

function _fbRenderTyping(post_id) {
  if (FB_STATE.selectedId !== post_id) return;
  const el = document.getElementById("fb-typing");
  if (!el) return;
  const info = FB_STATE.typingDisplay[post_id];
  if (!info || info.until < Date.now()) {
    el.textContent = "";
    return;
  }
  const name = (info.email || "?").split("@")[0];
  el.innerHTML = `<span class="fb-typing-dot"></span><span class="fb-typing-dot"></span><span class="fb-typing-dot"></span> ${escapeHtml(name)} が入力中…`;
  setTimeout(() => _fbRenderTyping(post_id), 1000);
}

async function _fbReloadList() {
  const list = document.getElementById("fb-list");
  if (list.children.length === 0 || list.querySelector(".fb-empty")) list.innerHTML = `<div class="fb-empty">読み込み中…</div>`;
  try {
    const [rPosts, rReplies] = await Promise.all([
      _sbFetch("feedback_posts?select=*&order=created_at.desc&limit=200"),
      _sbFetch("feedback_replies?select=id,post_id"),
    ]);
    if (!rPosts.ok) {
      if (rPosts.status === 404) {
        list.innerHTML = `<div class="fb-empty">テーブル未作成です。<br><b>Supabase Dashboard → SQL Editor</b> で<br><code>supabase_feedback_schema.sql</code> を実行してください。</div>`;
        return;
      }
      const txt = await rPosts.text().catch(() => "");
      throw new Error("HTTP " + rPosts.status + " " + txt.slice(0, 100));
    }
    FB_STATE.posts = await rPosts.json();
    FB_STATE.replyCounts = {};
    if (rReplies.ok) {
      const replies = await rReplies.json();
      for (const r of replies) FB_STATE.replyCounts[r.post_id] = (FB_STATE.replyCounts[r.post_id] || 0) + 1;
    }
    // 글 리액션 카운트 (post 단위만)
    await _fbLoadReactions(FB_STATE.posts.map(p => p.id), { onlyPosts: true });
    _fbRenderList();
  } catch (e) {
    list.innerHTML = `<div class="fb-empty">読み込み失敗: ${escapeHtml(String(e.message || e))}</div>`;
  }
}

async function _fbLoadReactions(postIds, opts = {}) {
  if (!postIds.length) return;
  try {
    const me = _fbCurrentUser();
    const rPost = await _sbFetch(`feedback_reactions?post_id=in.(${postIds.join(",")})&select=*`);
    if (rPost.ok) {
      const rows = await rPost.json();
      const byPost = {};
      for (const r of rows) {
        const k = r.post_id;
        byPost[k] = byPost[k] || {};
        byPost[k][r.emoji] = byPost[k][r.emoji] || { count: 0, mine: false };
        byPost[k][r.emoji].count++;
        if (me && r.user_id === me.id) byPost[k][r.emoji].mine = true;
      }
      for (const k in byPost) {
        FB_STATE.reactionsByPost[k] = Object.entries(byPost[k]).map(([emoji, v]) => ({ emoji, ...v }));
      }
      // 빈 경우는 명시적으로 비움 (다른 사람이 0으로 만든 후)
      for (const id of postIds) if (!byPost[id]) FB_STATE.reactionsByPost[id] = [];
    }
    if (opts.onlyPosts) return;
    // 답글 리액션 (선택된 글의 답글만)
    if (FB_STATE.selectedId) {
      const rReply = await _sbFetch(`feedback_reactions?reply_id=not.is.null&select=*`);
      if (rReply.ok) {
        const rows = await rReply.json();
        const byReply = {};
        for (const r of rows) {
          if (!r.reply_id) continue;
          const k = r.reply_id;
          byReply[k] = byReply[k] || {};
          byReply[k][r.emoji] = byReply[k][r.emoji] || { count: 0, mine: false };
          byReply[k][r.emoji].count++;
          if (me && r.user_id === me.id) byReply[k][r.emoji].mine = true;
        }
        FB_STATE.reactionsByReply = {};
        for (const k in byReply) {
          FB_STATE.reactionsByReply[k] = Object.entries(byReply[k]).map(([emoji, v]) => ({ emoji, ...v }));
        }
      }
    }
  } catch {}
}

async function _fbToggleReaction(target, id, emoji) {
  // target: 'post' | 'reply'
  const me = _fbCurrentUser();
  if (!me) return toast("ログインしてください", true);
  const col = target === "post" ? "post_id" : "reply_id";
  try {
    // 본인 리액션 존재 여부 조회
    const rExist = await _sbFetch(`feedback_reactions?${col}=eq.${id}&user_id=eq.${me.id}&emoji=eq.${encodeURIComponent(emoji)}&select=id`);
    const rows = await rExist.json();
    if (rows && rows.length) {
      await _sbFetch(`feedback_reactions?id=eq.${rows[0].id}`, { method: "DELETE", headers: { "Prefer": "return=minimal" } });
    } else {
      const body = { emoji, user_email: me.email };
      body[col] = id;
      await _sbFetch("feedback_reactions", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify(body),
      });
    }
  } catch (e) { toast("リアクション失敗", true); }
}

function _fbRenderList() {
  const list = document.getElementById("fb-list");
  const q = (FB_STATE.query || "").toLowerCase();
  const filtered = FB_STATE.posts.filter(p => {
    if (FB_STATE.category !== "all" && p.category !== FB_STATE.category) return false;
    if (q && !(p.title.toLowerCase().includes(q) || (p.body || "").toLowerCase().includes(q))) return false;
    return true;
  });
  // 정렬: 핀 → 未対応 → 최신순
  filtered.sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    const ao = a.status === "open" ? 0 : 1;
    const bo = b.status === "open" ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return (b.created_at || "").localeCompare(a.created_at || "");
  });
  if (!filtered.length) {
    list.innerHTML = `
      <div class="fb-empty fb-empty-illus">
        <div style="font-size:42px;opacity:.5;margin-bottom:8px">📭</div>
        <div style="font-weight:700;color:#475569;margin-bottom:4px">投稿がありません</div>
        <div style="font-size:11.5px;color:#94a3b8">右上の「＋ 新規投稿」から最初の質問を投稿してみましょう</div>
      </div>`;
    return;
  }
  list.innerHTML = filtered.map(p => {
    const cat = FB_CAT_META[p.category] || FB_CAT_META.other;
    const st = FB_STATUS_META[p.status] || FB_STATUS_META.open;
    const repCount = (FB_STATE.replyCounts || {})[p.id] || 0;
    const reacts = (FB_STATE.reactionsByPost || {})[p.id] || [];
    const reactSum = reacts.reduce((s, r) => s + r.count, 0);
    const isSel = FB_STATE.selectedId === p.id;
    const author = (p.user_email || "—").split("@")[0];
    const authorIsAdmin = _fbIsAdminEmail(p.user_email);
    return `
      <div class="fb-card${isSel ? ' fb-card-sel' : ''}${p.pinned ? ' fb-card-pinned' : ''}" data-id="${p.id}">
        <div class="fb-card-top">
          ${p.pinned ? `<span class="fb-pin-mark" title="ピン留め">📌</span>` : ""}
          <span class="fb-cat-pill" style="background:${cat.color}15;color:${cat.color}">${cat.icon} ${cat.label}</span>
          <span class="fb-st-pill" style="background:${st.bg};color:${st.color}">${st.label}</span>
        </div>
        <div class="fb-card-title">${escapeHtml(p.title)}</div>
        <div class="fb-card-meta">
          <span>${escapeHtml(author)}</span>
          ${authorIsAdmin ? `<span class="fb-admin-badge fb-admin-badge-sm">管理者</span>` : ""}
          <span>·</span>
          <span>${_fbRelTime(p.created_at)}</span>
          ${repCount ? `<span class="fb-rep-badge">💬 ${repCount}</span>` : ""}
          ${reactSum ? `<span class="fb-rep-badge">${reacts.map(r => r.emoji).slice(0,3).join("")} ${reactSum}</span>` : ""}
        </div>
      </div>
    `;
  }).join("");
  list.querySelectorAll(".fb-card").forEach(el => {
    el.onclick = () => _fbSelectPost(parseInt(el.dataset.id));
  });
  if (FB_STATE.selectedId) {
    const post = FB_STATE.posts.find(p => p.id === FB_STATE.selectedId);
    if (!post) FB_STATE.selectedId = null;
  }
}

async function _fbSelectPost(id) {
  FB_STATE.selectedId = id;
  _fbRenderList();
  const detail = document.getElementById("fb-detail");
  if (!detail.querySelector(".fb-detail-head")) detail.innerHTML = `<div class="fb-empty">読み込み中…</div>`;
  try {
    const [rPost, rReplies] = await Promise.all([
      _sbFetch(`feedback_posts?id=eq.${id}&select=*`),
      _sbFetch(`feedback_replies?post_id=eq.${id}&select=*&order=created_at.asc`),
    ]);
    const post = (await rPost.json())[0];
    const replies = await rReplies.json();
    if (!post) { detail.innerHTML = `<div class="fb-empty">見つかりません</div>`; return; }
    await _fbLoadReactions([id]);
    _fbRenderDetail(post, replies);
  } catch (e) {
    detail.innerHTML = `<div class="fb-empty">読み込み失敗</div>`;
  }
}

function _fbReactionBar(target, id, list) {
  const items = (list || []).filter(r => r.count > 0);
  const have = new Set(items.map(r => r.emoji));
  const pills = items.map(r =>
    `<button class="fb-react-pill${r.mine ? ' on' : ''}" data-react="${target}:${id}:${r.emoji}">${r.emoji} <b>${r.count}</b></button>`).join("");
  const addable = FB_EMOJIS.filter(e => !have.has(e));
  return `<div class="fb-react-bar">
    ${pills}
    <div class="fb-react-add">
      <button class="fb-react-toggle" title="リアクションを追加">＋</button>
      <div class="fb-react-menu">
        ${addable.map(e => `<button class="fb-react-add-btn" data-react="${target}:${id}:${e}">${e}</button>`).join("")}
      </div>
    </div>
  </div>`;
}

function _fbRenderDetail(post, replies) {
  const detail = document.getElementById("fb-detail");
  const cat = FB_CAT_META[post.category] || FB_CAT_META.other;
  const st = FB_STATUS_META[post.status] || FB_STATUS_META.open;
  const me = _fbCurrentUser();
  const isOwn = me && me.id === post.user_id;
  const isAdmin = me && me.isAdmin;
  const author = (post.user_email || "—").split("@")[0];
  const authorIsAdmin = _fbIsAdminEmail(post.user_email);
  const _attImg = (path, allPaths) => {
    const url = _sbPublicUrl(path);
    const name = path.split("/").pop() || "";
    if (_fbIsImage(name, "")) {
      return `<button type="button" class="fb-att-img" data-src="${url}" data-group="${(allPaths || []).map(p => _sbPublicUrl(p)).join('|')}"><img src="${url}" loading="lazy"></button>`;
    }
    // 이미지 외 = 다운로드 링크 (아이콘 + 파일명)
    return `<a class="fb-att-file" href="${url}" target="_blank" download="${escapeHtml(name)}">
      <span style="font-size:22px">${_fbFileIcon(name)}</span>
      <span class="fb-att-file-name">${escapeHtml(name)}</span>
      <span class="fb-att-file-dl">↓</span>
    </a>`;
  };
  const attHTML = (post.attachment_paths || []).map(p => _attImg(p, post.attachment_paths)).join("");
  const repliesHTML = replies.map(r => {
    const rIsOwn = me && me.id === r.user_id;
    const rIsAdmin = _fbIsAdminEmail(r.user_email);
    const rAuthor = (r.user_email || "—").split("@")[0];
    const rAtt = (r.attachment_paths || []).map(p => _attImg(p, r.attachment_paths)).join("");
    const rReact = FB_STATE.reactionsByReply[r.id] || [];
    return `
      <div class="fb-reply${rIsAdmin ? ' fb-reply-admin' : (rIsOwn ? ' fb-reply-own' : '')}" data-rid="${r.id}">
        <div class="fb-reply-head">
          <span class="fb-avatar${rIsAdmin ? ' fb-avatar-admin' : ''}">${escapeHtml(rAuthor.slice(0,2).toUpperCase())}</span>
          <span class="fb-reply-author">${escapeHtml(rAuthor)}</span>
          ${rIsAdmin ? `<span class="fb-admin-badge">管理者</span>` : ""}
          <span class="fb-reply-time">${_fbRelTime(r.created_at)}</span>
          <span class="fb-reply-actions">
            <button class="fb-reply-quote" data-qrid="${r.id}" title="引用">↩</button>
            ${(rIsOwn || isAdmin) ? `<button class="fb-reply-del" data-rid="${r.id}" title="削除">✕</button>` : ""}
          </span>
        </div>
        <div class="fb-reply-body">${_fbRenderBody(r.body)}</div>
        ${rAtt ? `<div class="fb-att-grid">${rAtt}</div>` : ""}
        ${_fbReactionBar("reply", r.id, rReact)}
      </div>
    `;
  }).join("");

  detail.innerHTML = `
    <div class="fb-detail-head">
      <div class="fb-detail-tags">
        <span class="fb-cat-pill" style="background:${cat.color}15;color:${cat.color}">${cat.icon} ${cat.label}</span>
        <span class="fb-st-pill" style="background:${st.bg};color:${st.color}">${st.label}</span>
      </div>
      <h1 class="fb-detail-title">${escapeHtml(post.title)}</h1>
      <div class="fb-detail-meta">
        <span class="fb-avatar${authorIsAdmin ? ' fb-avatar-admin' : ''}">${escapeHtml(author.slice(0,2).toUpperCase())}</span>
        <span>${escapeHtml(author)}</span>
        ${authorIsAdmin ? `<span class="fb-admin-badge">管理者</span>` : ""}
        <span>·</span>
        <span>${_fbRelTime(post.created_at)}</span>
        ${(isOwn || isAdmin) ? `
          <span style="margin-left:auto;display:flex;gap:6px">
            ${isAdmin ? `<button class="fb-status-btn" id="fb-pin-toggle" title="${post.pinned ? 'ピン解除' : 'ピン留め'}">${post.pinned ? '📌 解除' : '📌 ピン'}</button>` : ""}
            ${isAdmin ? `<button class="fb-status-btn" id="fb-status-toggle">状態 ${st.label}</button>` : ""}
            ${isOwn ? `<button class="fb-btn-ghost-sm" id="fb-edit-post">編集</button>` : ""}
            ${(isOwn || isAdmin) ? `<button class="fb-btn-ghost-sm fb-danger" id="fb-delete-post">削除</button>` : ""}
          </span>` : ""}
      </div>
    </div>
    <div class="fb-detail-body">${_fbRenderBody(post.body)}</div>
    ${attHTML ? `<div class="fb-att-grid">${attHTML}</div>` : ""}
    ${_fbReactionBar("post", post.id, FB_STATE.reactionsByPost[post.id] || [])}
    <div class="fb-replies-sec">
      <h3 class="fb-replies-h">💬 返信 (${replies.length})</h3>
      <div class="fb-replies-list">${repliesHTML || '<div class="fb-empty fb-empty-sm">まだ返信がありません</div>'}</div>
      <div class="fb-typing" id="fb-typing"></div>
      <div class="fb-reply-form">
        <textarea id="fb-reply-body" rows="3" placeholder="返信を書く…"></textarea>
        <div class="fb-reply-form-foot">
          <input type="file" id="fb-reply-file" multiple hidden />
          <button class="fb-btn-ghost-sm" id="fb-reply-attach">📎 添付</button>
          <span class="fb-reply-att-info" id="fb-reply-att-info"></span>
          <button class="fb-btn-primary fb-btn-sm" id="fb-reply-send">返信</button>
        </div>
      </div>
    </div>
  `;

  // 답글 폼 핸들러 + 인용 + 타이핑 broadcast + Ctrl+V 첨부
  const replyAttachments = [];
  const replyTextarea = document.getElementById("fb-reply-body");
  // 타이핑 throttle (1.5초)
  let typingLast = 0;
  replyTextarea.addEventListener("input", () => {
    const now = Date.now();
    if (now - typingLast > 1500) {
      typingLast = now;
      _fbBroadcastTyping(post.id);
    }
  });
  // 인용 버튼
  detail.querySelectorAll(".fb-reply-quote").forEach(b => {
    b.onclick = () => {
      const rid = parseInt(b.dataset.qrid);
      const target = replies.find(x => x.id === rid);
      if (!target) return;
      const qauthor = (target.user_email || "?").split("@")[0];
      const quoted = target.body.split("\n").map(l => "> " + l).join("\n");
      const cur = replyTextarea.value;
      replyTextarea.value = `**@${qauthor}**\n${quoted}\n\n${cur}`;
      replyTextarea.focus();
      replyTextarea.scrollIntoView({ behavior: "smooth", block: "center" });
    };
  });
  // 답글 박스 Ctrl+V 클립보드 이미지 첨부
  replyTextarea.addEventListener("paste", (e) => {
    if (!e.clipboardData) return;
    const imgs = [...e.clipboardData.items].filter(it => it.kind === "file" && it.type?.startsWith("image/"));
    if (!imgs.length) return;
    e.preventDefault();
    const info = document.getElementById("fb-reply-att-info");
    (async () => {
      for (const it of imgs) {
        const f = it.getAsFile();
        if (!f) continue;
        const named = new File([f], f.name || `paste_${Date.now()}.png`, { type: f.type });
        info.textContent = "アップロード中…";
        try {
          const p = await _sbStorageUpload(named);
          replyAttachments.push(p);
        } catch { toast("貼り付け失敗", true); }
      }
      info.textContent = `添付 ${replyAttachments.length}件`;
    })();
  });
  // 리액션 버튼들
  detail.querySelectorAll("[data-react]").forEach(b => {
    b.onclick = async () => {
      const [target, id, emoji] = b.dataset.react.split(":");
      await _fbToggleReaction(target, parseInt(id), emoji);
      // 옵티미스틱은 안 함 — realtime 으로 자동 갱신
    };
  });
  // 첨부 버튼
  document.getElementById("fb-reply-attach").onclick = () =>
    document.getElementById("fb-reply-file").click();
  document.getElementById("fb-reply-file").onchange = async (e) => {
    const info = document.getElementById("fb-reply-att-info");
    for (const f of e.target.files) {
      if (f.size > FB_MAX_FILE) {
        toast(`${f.name}: ${Math.round(f.size/1024/1024)}MB 大きすぎます (上限 30MB)`, true);
        continue;
      }
      info.textContent = "アップロード中…";
      try {
        const path = await _sbStorageUpload(f);
        replyAttachments.push(path);
      } catch (err) { toast("添付失敗: " + err.message, true); }
    }
    info.textContent = `添付 ${replyAttachments.length}件`;
    e.target.value = "";
  };
  document.getElementById("fb-reply-send").onclick = async () => {
    const body = document.getElementById("fb-reply-body").value.trim();
    if (!body) return toast("内容を入力してください", true);
    const me = _fbCurrentUser();
    try {
      const r = await _sbFetch("feedback_replies", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({
          post_id: post.id, body, user_email: me?.email,
          attachment_paths: replyAttachments,
        }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      // 管理者(= ADMIN_EMAIL) 본인 답변 시에만 자동 「回答済」 전환
      if (post.status === "open" && me?.isAdmin) {
        await _sbFetch(`feedback_posts?id=eq.${post.id}`, {
          method: "PATCH",
          headers: { "Prefer": "return=minimal" },
          body: JSON.stringify({ status: "answered" }),
        }).catch(() => {});
      }
      toast("返信しました", "ok");
      await _fbReloadList();
      _fbSelectPost(post.id);
    } catch (e) { toast("返信失敗: " + e.message, true); }
  };

  // 권한별 액션: 글쓴이는 편집, 글쓴이 또는 관리자는 삭제, 관리자만 상태 변경
  if (isOwn) {
    document.getElementById("fb-edit-post").onclick = () => _fbOpenModal(post);
  }
  if (isOwn || isAdmin) {
    document.getElementById("fb-delete-post").onclick = async () => {
      if (!confirm("この投稿を削除しますか？")) return;
      try {
        // return=representation 로 삭제된 row 반환 → 0이면 RLS로 막힘
        const r = await _sbFetch(`feedback_posts?id=eq.${post.id}`, {
          method: "DELETE", headers: { "Prefer": "return=representation" } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const deleted = await r.json().catch(() => []);
        if (!Array.isArray(deleted) || deleted.length === 0) {
          toast("削除権限がありません (RLS で拒否) — ADMIN_EMAIL 設定 / 投稿者本人か確認", true);
          return;
        }
        FB_STATE.selectedId = null;
        document.getElementById("fb-detail").innerHTML = `<div class="fb-empty">投稿を選択してください</div>`;
        await _fbReloadList();
        toast("削除しました", "ok");
      } catch (e) { toast("削除失敗: " + e.message, true); }
    };
  }
  if (isAdmin) {
    document.getElementById("fb-status-toggle").onclick = async () => {
      const next = { open: "answered", answered: "resolved", resolved: "wont_fix", wont_fix: "open" }[post.status] || "open";
      try {
        await _sbFetch(`feedback_posts?id=eq.${post.id}`, {
          method: "PATCH",
          headers: { "Prefer": "return=minimal" },
          body: JSON.stringify({ status: next }),
        });
        await _fbReloadList();
        _fbSelectPost(post.id);
      } catch (e) { toast("状態変更失敗: " + e.message, true); }
    };
    const pinBtn = document.getElementById("fb-pin-toggle");
    if (pinBtn) pinBtn.onclick = async () => {
      try {
        await _sbFetch(`feedback_posts?id=eq.${post.id}`, {
          method: "PATCH",
          headers: { "Prefer": "return=minimal" },
          body: JSON.stringify({ pinned: !post.pinned }),
        });
        await _fbReloadList();
        _fbSelectPost(post.id);
      } catch (e) { toast("ピン操作失敗", true); }
    };
  }

  // 첨부 이미지 클릭 → lightbox (새 탭 X)
  detail.querySelectorAll(".fb-att-img").forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      const group = (btn.dataset.group || "").split("|").filter(Boolean);
      const idx = group.indexOf(btn.dataset.src);
      _fbOpenLightbox(group.length ? group : [btn.dataset.src], idx >= 0 ? idx : 0);
    };
  });

  // 답글 삭제
  detail.querySelectorAll(".fb-reply-del").forEach(b => {
    b.onclick = async () => {
      if (!confirm("この返信を削除しますか？")) return;
      try {
        const r = await _sbFetch(`feedback_replies?id=eq.${b.dataset.rid}`, {
          method: "DELETE", headers: { "Prefer": "return=representation" } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const del = await r.json().catch(() => []);
        if (!Array.isArray(del) || del.length === 0) {
          toast("削除権限がありません", true);
          return;
        }
        toast("削除しました", "ok");
        _fbSelectPost(post.id);
      } catch (e) { toast("削除失敗", true); }
    };
  });
}

function _fbHandleClipboardImages(items) {
  // ClipboardData.items 또는 DataTransferItem 배열에서 image/* 찾아 첨부
  for (const it of items) {
    if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) {
        // 잘려있는 이름 보강 (clipboard image 는 보통 image.png)
        const named = new File([f], f.name || `screenshot_${Date.now()}.png`, { type: f.type });
        _fbHandleFiles([named]);
      }
    }
  }
}

function _fbBindEvents() {
  document.getElementById("fb-search").oninput = (e) => {
    FB_STATE.query = e.target.value;
    _fbRenderList();
  };
  document.getElementById("fb-filters").querySelectorAll(".fb-chip").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#fb-filters .fb-chip").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      FB_STATE.category = b.dataset.cat;
      _fbRenderList();
    };
  });
  document.getElementById("fb-btn-new").onclick = () => _fbOpenModal(null);
  document.getElementById("fb-modal-close").onclick = _fbCloseModal;
  document.getElementById("fb-cancel").onclick = _fbCloseModal;
  document.getElementById("fb-modal").onclick = (e) => {
    if (e.target.id === "fb-modal") _fbCloseModal();
  };
  document.getElementById("fb-cat-picker").querySelectorAll(".fb-cat-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#fb-cat-picker .fb-cat-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
    };
  });
  const drop = document.getElementById("fb-drop");
  const fileInput = document.getElementById("fb-file");
  const folderInput = document.getElementById("fb-folder");
  drop.onclick = () => fileInput.click();
  fileInput.onchange = (e) => _fbHandleFiles(e.target.files);
  if (folderInput) folderInput.onchange = (e) => _fbHandleFiles(e.target.files);
  const pickFolder = document.getElementById("fb-pick-folder");
  if (pickFolder) pickFolder.onclick = (e) => { e.preventDefault(); folderInput?.click(); };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("fb-drop-over"); };
  drop.ondragleave = () => drop.classList.remove("fb-drop-over");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("fb-drop-over");
    _fbHandleFiles(e.dataTransfer.files);
  };
  document.getElementById("fb-submit").onclick = _fbSubmitPost;

  // 임시저장 자동: 신규 작성 중 인풋 변경 시 (500ms throttle)
  let draftTm = null;
  const persistDraft = () => {
    if (FB_STATE.modalEditId) return;  // 편집 모드는 저장 안 함
    clearTimeout(draftTm);
    draftTm = setTimeout(() => {
      const title = document.getElementById("fb-title").value;
      const body = document.getElementById("fb-body").value;
      const cat = document.querySelector("#fb-cat-picker .fb-cat-btn.active")?.dataset.v || "question";
      if (title || body) _fbDraftSave({ title, body, cat });
      const hint = document.getElementById("fb-draft-hint");
      if (hint && (title || body)) hint.textContent = "💾 自動保存済み";
    }, 500);
  };
  document.getElementById("fb-title").addEventListener("input", persistDraft);
  document.getElementById("fb-body").addEventListener("input", persistDraft);
  document.querySelectorAll("#fb-cat-picker .fb-cat-btn").forEach(b => b.addEventListener("click", persistDraft));

  // Ctrl+V / Cmd+V 로 클립보드 이미지 자동 첨부 (모달 열려있을 때)
  document.addEventListener("paste", (e) => {
    const modal = document.getElementById("fb-modal");
    if (modal.classList.contains("hidden")) return;
    // textarea/input 안에서 텍스트 paste 면 무시 (브라우저 기본 처리)
    if (document.activeElement?.tagName === "TEXTAREA" || document.activeElement?.tagName === "INPUT") {
      if (![...(e.clipboardData?.items || [])].some(it => it.kind === "file" && it.type?.startsWith("image/"))) return;
    }
    if (!e.clipboardData) return;
    _fbHandleClipboardImages(e.clipboardData.items);
  });

  // ESC 로 모달 닫기
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const m = document.getElementById("fb-modal");
      if (m && !m.classList.contains("hidden")) _fbCloseModal();
    }
  });
}

// 파일 크기 상한 (Supabase 무료 50MB / 유료 5GB. 안전 마진 30MB)
const FB_MAX_FILE = 30 * 1024 * 1024;
async function _fbHandleFiles(files) {
  for (const f of files) {
    if (f.size > FB_MAX_FILE) {
      toast(`${f.name}: ${Math.round(f.size/1024/1024)}MB 大きすぎます (上限 30MB)`, true);
      continue;
    }
    const item = { file: f, path: null, status: "uploading" };
    FB_STATE.attachments.push(item);
    _fbRenderAttachments();
    try {
      item.path = await _sbStorageUpload(f);
      item.status = "done";
    } catch (e) {
      item.status = "fail";
      toast("アップロード失敗: " + e.message, true);
    }
    _fbRenderAttachments();
  }
}
function _fbFileIcon(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["zip","rar","7z","tar","gz"].includes(ext)) return "🗜";
  if (["pdf"].includes(ext)) return "📄";
  if (["doc","docx"].includes(ext)) return "📝";
  if (["xls","xlsx","csv"].includes(ext)) return "📊";
  if (["ppt","pptx"].includes(ext)) return "📑";
  if (["mp4","mov","avi","webm"].includes(ext)) return "🎬";
  if (["mp3","wav","m4a"].includes(ext)) return "🎵";
  return "📎";
}
function _fbIsImage(name, mime) {
  if (mime && mime.startsWith("image/")) return true;
  const ext = (name.split(".").pop() || "").toLowerCase();
  return ["png","jpg","jpeg","gif","webp","bmp","svg"].includes(ext);
}
function _fbRenderAttachments() {
  const wrap = document.getElementById("fb-attachments");
  wrap.innerHTML = FB_STATE.attachments.map((a, i) => {
    const name = a.file.name || "";
    const mime = a.file.type || "";
    const sizeKb = a.file.size ? Math.round(a.file.size / 1024) : null;
    let preview;
    if (a.status === "uploading") preview = '<span class="spin"></span>';
    else if (a.status === "fail") preview = '<span style="color:#bf0000">⚠</span>';
    else if (_fbIsImage(name, mime)) preview = `<img src="${_sbPublicUrl(a.path)}" loading="lazy">`;
    else preview = `<span style="font-size:18px">${_fbFileIcon(name)}</span>`;
    return `<div class="fb-att-chip">
      ${preview}
      <span>${escapeHtml(name)}${sizeKb != null ? ` <span style="color:#94a3b8">· ${sizeKb >= 1024 ? (sizeKb/1024).toFixed(1)+"MB" : sizeKb+"KB"}</span>` : ""}</span>
      <button data-i="${i}" class="fb-att-x">✕</button>
    </div>`;
  }).join("");
  wrap.querySelectorAll(".fb-att-x").forEach(b => {
    b.onclick = () => {
      FB_STATE.attachments.splice(parseInt(b.dataset.i), 1);
      _fbRenderAttachments();
    };
  });
}

function _fbOpenModal(post) {
  FB_STATE.modalEditId = post ? post.id : null;
  FB_STATE.attachments = post ? (post.attachment_paths || []).map(p => ({ file: { name: p.split("/").pop() }, path: p, status: "done" })) : [];
  document.getElementById("fb-modal-title").textContent = post ? "投稿を編集" : "新規投稿";
  // 신규 작성 시: localStorage 임시저장 복원
  const draft = !post ? _fbDraftLoad() : null;
  document.getElementById("fb-title").value = post ? post.title : (draft?.title || "");
  document.getElementById("fb-body").value = post ? post.body : (draft?.body || "");
  const targetCat = post ? post.category : (draft?.cat || "question");
  document.querySelectorAll("#fb-cat-picker .fb-cat-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.v === targetCat));
  _fbRenderAttachments();
  // 草稿 復元 메시지
  const hint = document.getElementById("fb-draft-hint");
  if (hint) hint.textContent = (!post && draft && (draft.title || draft.body)) ? "💾 下書きを復元しました" : "";
  document.getElementById("fb-modal").classList.remove("hidden");
}
function _fbCloseModal() {
  // 신규 작성 도중이면 저장 (편집은 저장 X)
  if (!FB_STATE.modalEditId) {
    const title = document.getElementById("fb-title")?.value || "";
    const body = document.getElementById("fb-body")?.value || "";
    const cat = document.querySelector("#fb-cat-picker .fb-cat-btn.active")?.dataset.v || "question";
    if (title || body) _fbDraftSave({ title, body, cat });
    else _fbDraftClear();
  }
  document.getElementById("fb-modal").classList.add("hidden");
  FB_STATE.attachments = [];
  FB_STATE.modalEditId = null;
}

async function _fbSubmitPost() {
  const title = document.getElementById("fb-title").value.trim();
  const body = document.getElementById("fb-body").value.trim();
  const cat = document.querySelector("#fb-cat-picker .fb-cat-btn.active")?.dataset.v || "question";
  if (!title) return toast("タイトルを入力してください", true);
  if (!body) return toast("内容を入力してください", true);
  const me = _fbCurrentUser();
  if (!me) return toast("ログインしてください", true);
  const attachment_paths = FB_STATE.attachments.filter(a => a.status === "done").map(a => a.path);
  try {
    if (FB_STATE.modalEditId) {
      const r = await _sbFetch(`feedback_posts?id=eq.${FB_STATE.modalEditId}`, {
        method: "PATCH",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({ title, body, category: cat, attachment_paths }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      toast("更新しました", "ok");
    } else {
      const r = await _sbFetch("feedback_posts", {
        method: "POST",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({ title, body, category: cat, user_email: me.email, attachment_paths }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      toast("投稿しました", "ok");
    }
    _fbDraftClear();
    _fbCloseModal();
    await _fbReloadList();
  } catch (e) { toast("失敗: " + e.message, true); }
}
let analysisSub = "board", analysisInit = false;
function loadAnalysisView() {
  if (!analysisInit) {
    // 기존 3개 뷰의 내부 DOM을 서브 컨테이너로 옮긴다(이벤트 핸들러는 #id 기반이라 유지됨)
    const moveInside = (fromId, toId) => {
      const from = $(fromId), to = $(toId);
      if (!from || !to) return;
      while (from.firstChild) to.appendChild(from.firstChild);
    };
    moveInside("#view-product", "#sub-board");
    moveInside("#view-matrix", "#sub-matrix");
    moveInside("#view-compare", "#sub-compare");
    $$("#analysis-tabs .seg-btn").forEach(b => b.onclick = () => switchAnalysisSub(b.dataset.sub));
    analysisInit = true;
  }
  switchAnalysisSub(analysisSub);
}
function switchAnalysisSub(s) {
  analysisSub = s;
  $$("#analysis-tabs .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.sub === s));
  ["board", "matrix", "compare"].forEach(k => $("#sub-" + k).classList.toggle("hidden", k !== s));
  if (s === "board") loadProductView();
  if (s === "matrix") loadMatrixView();
  if (s === "compare") loadCompareView();
}

/* ---------------- 상태/세션 ---------------- */
// 楽天 자동 감지 shop 변경 시 화면 일괄 갱신 (멀티테넌트 — 모든 API 가 ?shop_id 자동 첨부됨).
// config 갱신 불필요 (멤버별 독립). 화면만 새로 그리면 됨.
let _shopSyncInflight = false;
async function _autoSyncShopAndReload() {
  if (_shopSyncInflight) return;
  if (!RAKUTEN_SHOP_ID) return;
  _shopSyncInflight = true;
  try {
    // 우상단 pill 즉시 갱신
    const pillShop = document.getElementById('pill-shop');
    if (pillShop) pillShop.textContent = `店舗 ${RAKUTEN_SHOP_ID}`;
    // 전체 화면 갱신 (status + coverage + 현재 view)
    await loadStatus();
    await loadCoverage().catch(() => {});
    const cur = $$(".view").find(v => !v.classList.contains("hidden"))?.id?.replace(/^view-/, "");
    if (cur === "dashboard") loadDashboard();
    else if (cur === "analysis") loadAnalysisView();
    else if (cur === "report") loadReportView();
    if (typeof _updateSessionPill === "function") _updateSessionPill();
  } finally {
    setTimeout(() => { _shopSyncInflight = false; }, 0);
  }
}

// RMS 탭 보장: 없으면 백그라운드 탭으로 열고 잠시 대기 (사용자 화면 안 빼앗음).
async function ensureRakutenTab() {
  try {
    const has = await ext_call({ type: 'HAS_RAKUTEN_TAB' });
    if (has && has.hasTab) return true;
    toast("楽天 RMS タブをバックグラウンドで開きます…", "ok");
    await ext_call({ type: 'OPEN_RAKUTEN_TAB', background: true }).catch(() => {
      // window.open 폴백은 새 탭 자동 포커스됨 → 사용 안 함, 그냥 실패 처리
      console.warn("[ensureRakutenTab] OPEN_RAKUTEN_TAB 失敗");
    });
    await new Promise(r => setTimeout(r, 3000));
    return true;
  } catch (e) {
    console.warn("[ensureRakutenTab]", e);
    return false;
  }
}

// shop 일관성 보장 — 자동 감지 vs config 비교 후 confirm + 자동 전환.
// 데이터 취득/백필 직전에 호출. 반환값: 실제 사용할 shop_id (null = 중단).
async function ensureShopConsistent() {
  const st = await api.get("/api/status").catch(() => null);
  const cfgShop = (st && st.shop_id) || "";
  const liveShop = RAKUTEN_SHOP_ID || "";
  // 楽天 로그인 안 됨
  if (!liveShop) {
    toast("楽天 RMS にログインしていません — RMS広告ページを開いてから再実行してください", true);
    return null;
  }
  // config 미설정 (첫 사용)
  if (!cfgShop) {
    // 첫 사용 — 조용히 config 등록
    await api.post("/api/config", { shop_id: liveShop }).catch(() => {});
    return liveShop;
  }
  // 일치 — 그대로 진행
  if (String(cfgShop) === String(liveShop)) return liveShop;
  // ⚠ 불일치 — 명시적 confirm + 자동 전환
  const msg =
    `⚠ ショップが異なります\n\n` +
    `現在のダッシュボード表示: shop ${cfgShop}\n` +
    `現在の楽天ログイン:        shop ${liveShop}\n\n` +
    `「OK」を押すと:\n` +
    `  1. データを shop ${liveShop} に保存\n` +
    `  2. ダッシュボード表示を shop ${liveShop} に自動切替\n\n` +
    `※ 違うショップに混ざらないよう、楽天で取得対象のショップにログインしてから「OK」を押してください。`;
  if (!confirm(msg)) return null;
  // config 갱신 → 화면도 새 shop 으로
  await api.post("/api/config", { shop_id: liveShop }).catch(() => {});
  toast(`ショップ ${liveShop} に切替えました`, "ok");
  // 화면 즉시 반영
  loadStatus(); loadCoverage();
  return liveShop;
}

// セッション 표시 — 브라우저 워커 시대의 진짜 신호 우선 (확장 + 楽天 shop_id).
// 옛 서버 사이드 cookie 체크 (STATUS.session) 는 sample 폴백 흐름 진단용으로만 의미.
function _updateSessionPill() {
  const ps = document.getElementById("pill-session");
  if (!ps) return;
  // 멀티테넌트라 「ショップ不一致」 경고 불필요 — 모든 API 가 ?shop_id 자동 첨부됨
  ps.onclick = null; ps.style.cursor = "default";
  if (EXT_READY && RAKUTEN_SHOP_ID) {
    // cookie / shop_id 잡혔으면 초록 OK (탭 유무는 데이터 취득 시 자동 보장)
    ps.textContent = "● 楽天連携 OK";
    ps.className = "pill ok";
    ps.title = "楽天 RMS 連携正常 — データ取得時に必要なら自動でタブを開きます";
    return;
  } else if (EXT_READY && !RAKUTEN_SHOP_ID) {
    ps.textContent = "● 楽天 RMS にログインしてください";
    ps.className = "pill err";
    ps.title = "拡張機能は OK。楽天 RMS にログインして RMS 広告ページ(https://ad.rms.rakuten.co.jp/rpp/)を一度開いてください";
  } else {
    ps.textContent = "● 拡張機能が見つかりません";
    ps.className = "pill err";
    ps.title = "Rakuten RMS Analytics 拡張機能をインストール/有効化してください (chrome://extensions/)";
  }
}
async function loadStatus() {
  try {
    STATUS = await api.get("/api/status");
    if (STATUS.shop_id) $("#pill-shop").textContent = "店舗 " + STATUS.shop_id;
    _updateSessionPill();
    // Drive 경로가 폴백된 경우 안내
    if (STATUS.db_fallback) {
      toast(`⚠ Google Drive (${STATUS.db_configured}) が見つかりません。ローカル(${STATUS.db_path})に保存中`, true);
    }
    renderBounds();
  } catch (e) { toast("状態の読み込みに失敗: " + e.message, true); }
}
function renderBounds() {
  const b = STATUS.bounds || {};
  $("#bounds-box").innerHTML = `
    <div class="b"><span class="muted small">取得開始</span><b>${b.min || "—"}</b></div>
    <div class="b"><span class="muted small">最新</span><b>${b.max || "—"}</b></div>
    <div class="b"><span class="muted small">取得日数</span><b>${b.distinct_days || 0}日</b></div>`;
}

/* ---------------- 수집 뷰 ---------------- */
let collectMode = "day";
$$("#view-collect .seg-btn").forEach(b => b.onclick = () => {
  collectMode = b.dataset.mode;
  $$("#view-collect .seg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
  $("#field-day").classList.toggle("hidden", collectMode !== "day");
  $("#field-range").classList.toggle("hidden", collectMode !== "range");
});
$$(".quick .chip").forEach(c => c.onclick = () => {
  const map = { yesterday: -1, d2: -2, d7: -7 };
  $("#in-day").value = addDays(today(), map[c.dataset.q]);
});
$("#btn-collect").onclick = async () => {
  let from, to;
  if (collectMode === "day") { from = to = $("#in-day").value; }
  else { from = $("#in-from").value; to = $("#in-to").value; }
  if (!from || !to) return toast("日付を選択してください", true);

  // 확장 워커 우선. 확장 미설치 시에만 옛 서버 사이드 /api/collect 폴백 (로컬 server.py 한정).
  await ensureExt(1500);
  if (EXT_READY) {
    await ensureRakutenTab();  // RMS 탭 없으면 자동으로 백그라운드 탭 + 대기
    const shopId = await ensureShopConsistent();  // 자동 감지 vs config 불일치 시 confirm + 전환
    if (!shopId) return;
    const box = $("#collect-result"); box.className = "result-box"; box.classList.remove("hidden");
    box.innerHTML = `<span class="spin"></span>ブラウザワーカーで取得中 (${from} 〜 ${to}) — shop ${shopId}…`;
    $("#btn-collect").disabled = true;
    return runBackfillViaExtension(from, to, shopId, { resultBoxSelector: '#collect-result', label: '取得', standalone: true });
  }

  const btn = $("#btn-collect"); btn.disabled = true;
  const box = $("#collect-result"); box.className = "result-box"; box.classList.remove("hidden");
  box.innerHTML = `<span class="spin"></span>楽天から取得中… (${from} 〜 ${to})<br><span class="muted small">商品/キーワード CSVダウンロードに約1〜2分かかります</span>`;
  try {
    let r;
    try {
      r = await api.post("/api/collect", { from, to });
    } catch (e) {
      // Lock 충돌(409) — 사용자에게 강제 실행 옵션
      if (String(e.message || "").includes("他のPC") && confirm(e.message + "\n\n強制実行しますか？")) {
        r = await api.post("/api/collect", { from, to, force_lock: true });
      } else { throw e; }
    }
    box.classList.add("ok");
    const totalRpp = (r.RPP_sel1 || 0) + (r.RPP_sel2 || 0) + (r.RPP_item || 0) + (r.RPP_keyword || 0);
    const skips = r.skips || {};
    const skipList = Object.keys(skips).map(k => `<span class="cl-skip-tag">${k}: ${skips[k]}</span>`).join("");
    const notes = (r.notes || []).map(n => `<li>${escapeHtml(n)}</li>`).join("");
    box.innerHTML = `
      <div class="cl-head"><span class="cl-ok">✅ 取得完了</span><span class="muted small">${r.date_from} 〜 ${r.date_to}${r.elapsed_seconds != null ? ` ・ ⏱ ${(() => { const s=r.elapsed_seconds; const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=s%60; return (h?h+"時間":"")+(m||h?m+"分":"")+ss+"秒"; })()}` : ""}</span></div>
      <div class="cl-grid">
        <div class="cl-section"><div class="cl-sec-h">📦 RPP（楽天プロモーション広告）</div>
          <div class="cl-cards">
            <div class="cl-card"><div class="cl-l">全体</div><div class="cl-v">${fmt(r.RPP_sel1)}</div></div>
            <div class="cl-card"><div class="cl-l">キャンペーン</div><div class="cl-v">${fmt(r.RPP_sel2)}</div></div>
            <div class="cl-card cl-card-accent"><div class="cl-l">商品別</div><div class="cl-v">${fmt(r.RPP_item)}</div></div>
            <div class="cl-card cl-card-accent"><div class="cl-l">キーワード別</div><div class="cl-v">${fmt(r.RPP_keyword)}</div></div>
          </div>
          <div class="cl-total">合計 <b>${fmt(totalRpp)}</b> 行</div>
        </div>
        <div class="cl-section"><div class="cl-sec-h">🎯 その他</div>
          <div class="cl-cards">
            <div class="cl-card"><div class="cl-l">CPA</div><div class="cl-v">${fmt(r.CPA_rows)}</div></div>
            <div class="cl-card"><div class="cl-l">TDA</div><div class="cl-v">${fmt(r.TDA_rows)}</div></div>
            <div class="cl-card"><div class="cl-l">スキップ</div><div class="cl-v">${fmt(r.skipped_calls)}</div></div>
          </div>
        </div>
      </div>
      ${skipList ? `<div class="cl-skips"><span class="muted small">スキップ詳細:</span> ${skipList}</div>` : ""}
      ${notes ? `<div class="cl-notes"><div class="cl-sec-h">📝 メモ</div><ul class="rep-ul">${notes}</ul></div>` : ""}
      ${r._kw_csv_preview ? (() => {
        const p = r._kw_csv_preview;
        const headers = p.headers || [];
        const resolvedKeys = Object.keys(p.resolved_columns || {});
        const matched = resolvedKeys.filter(k => p.resolved_columns[k]).length;
        const total = resolvedKeys.length;
        const headerChips = headers.length ? headers.slice(0, 60).map(h => `<code style="font-size:10px;background:#fff;border:1px solid #cfe6d3;border-radius:4px;padding:1px 5px;margin:1px;display:inline-block">${escapeHtml(h)}</code>`).join(" ") : `<span style="color:#b4690a">— 헤더 추출 실패 (파싱 에러일 가능성)</span>`;
        const resolvedRows = Object.entries(p.resolved_columns || {}).map(([k, v]) => `<tr style="border-bottom:1px solid #e3f0e7"><td style="padding:2px 6px;font-size:10.5px"><code>${escapeHtml(k)}</code></td><td style="padding:2px 6px;font-size:10.5px">${v ? `<code style="color:#0c7a3e">${escapeHtml(v)}</code>` : `<span style="color:#b4690a">— 未マッチ</span>`}</td></tr>`).join("");
        const parseOk = (p.normalized_count != null && p.normalized_count > 0);
        const color = parseOk ? "#0c7a3e" : "#b4690a";
        const bg = parseOk ? "#f1faf4" : "#fff7e6";
        const title = parseOk ? "✅ キーワードCSV 取得成功" : "⚠️ キーワードCSV: ダウンロード成功・パース未完了";
        return `<div class="cl-notes" style="margin-top:10px;background:${bg};border:2px solid ${color};border-radius:10px;padding:12px"><div style="font-weight:800;font-size:13px;color:${color};margin-bottom:6px">${title}</div><div style="font-size:12.5px;margin:4px 0"><b>CSV サイズ:</b> ${fmt(p.raw_len)}字 / ${fmt(p.raw_line_count)}行 ・ <b>正規化後:</b> ${fmt(p.normalized_count ?? 0)}行 ・ <b>列マッチング:</b> ${matched}/${total}</div>${p.raw_head ? `<details style="margin:6px 0" ${parseOk ? "" : "open"}><summary style="cursor:pointer;font-size:11.5px;font-weight:700">▶ raw CSV 先頭1500字</summary><pre style="font-size:10.5px;background:#fff;padding:8px;border-radius:4px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-all">${escapeHtml(p.raw_head)}</pre></details>` : ""}<div style="margin:8px 0"><div style="font-size:11px;font-weight:700;margin-bottom:3px">CSV ヘッダー（${headers.length}列）</div>${headerChips}</div>${total ? `<details style="margin:6px 0"><summary style="cursor:pointer;font-size:11px;font-weight:700">▶ 列マッチング詳細</summary><table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:4px"><thead><tr style="background:#fff;border-bottom:1px solid #bfe6cf"><th style="text-align:left;padding:3px 6px">内部キー</th><th style="text-align:left;padding:3px 6px">CSV 列名</th></tr></thead><tbody>${resolvedRows}</tbody></table></details>` : ""}${p.first_row ? `<details style="margin:6px 0"><summary style="cursor:pointer;font-size:11px;font-weight:700">▶ 最初の1行（生データ）</summary><pre style="font-size:10.5px;background:#fff;padding:8px;border-radius:4px;max-height:200px;overflow:auto">${escapeHtml(JSON.stringify(p.first_row, null, 2))}</pre></details>` : ""}</div>`;
      })() : ""}
      ${(r._diagnostic && !r._kw_csv_preview) ? (() => {
        const fc = r._diagnostic.kw_first_call || {};
        const variants = fc.payload_variants || [];
        const variantTbl = variants.length ? `<div style="margin:8px 0"><div style="font-weight:800;font-size:12px;color:#15181e;margin-bottom:4px">🧪 ペイロード変形テスト結果（rows が一番多いものが正解）</div><table style="width:100%;font-size:11.5px;border-collapse:collapse"><thead><tr style="background:#fff;border-bottom:1px solid #f0c060"><th style="text-align:left;padding:4px 8px">label</th><th style="text-align:right;padding:4px 8px">rows</th><th style="text-align:right;padding:4px 8px">status</th></tr></thead><tbody>${variants.map(v => `<tr style="border-bottom:1px solid #fef3d0"><td style="padding:3px 8px"><b>${escapeHtml(v.label || "?")}</b></td><td style="padding:3px 8px;text-align:right"><b>${v.rows ?? "—"}</b></td><td style="padding:3px 8px;text-align:right">${v.status || (v.error ? "ERR" : "—")}</td></tr>`).join("")}</tbody></table>${fc.best_variant ? `<div style="margin-top:6px;font-size:12px"><b style="color:#0c7a3e">✅ best:</b> <code>${escapeHtml(fc.best_variant)}</code></div>` : ""}</div>` : "";
        const probes = fc.endpoint_probes || [];
        const probeTbl = probes.length ? `<div style="margin:12px 0 8px"><div style="font-weight:800;font-size:12px;color:#15181e;margin-bottom:4px">🌐 エンドポイント探索（status 200 で list_* が大きいものを探す）</div><table style="width:100%;font-size:11px;border-collapse:collapse"><thead><tr style="background:#fff;border-bottom:1px solid #f0c060"><th style="text-align:left;padding:4px 8px">endpoint</th><th style="text-align:right;padding:4px 8px">status</th><th style="text-align:left;padding:4px 8px">content_type</th><th style="text-align:right;padding:4px 8px">data</th></tr></thead><tbody>${probes.map(p => {
          const listInfo = Object.keys(p).filter(k => k.startsWith("list_")).map(k => `${k.slice(5)}=${p[k]}`).join(", ");
          const txt = listInfo || (p.lines != null ? `lines=${p.lines}` : (p.body_len != null ? `len=${p.body_len}` : (p.error ? p.error.slice(0,40) : "—")));
          const ok = p.status >= 200 && p.status < 300;
          const extras = [];
          if (p.paths_in_html) extras.push(`<div style="margin:4px 0"><b>paths_in_html:</b><br><code style="font-size:10px;color:#0c5a99">${p.paths_in_html.map(x => escapeHtml(x)).join("<br>")}</code></div>`);
          if (p.form_actions) extras.push(`<div style="margin:4px 0"><b>form_actions:</b> <code style="font-size:10px">${p.form_actions.map(x => escapeHtml(x)).join(", ")}</code></div>`);
          if (p.download_links) extras.push(`<div style="margin:4px 0"><b>download_links:</b> <code style="font-size:10px">${p.download_links.map(x => escapeHtml(x)).join(", ")}</code></div>`);
          if (p.api_urls_in_js) extras.push(`<div style="margin:4px 0"><b>api_urls_in_js:</b> <code style="font-size:10px">${p.api_urls_in_js.map(x => escapeHtml(x)).join(", ")}</code></div>`);
          if (p.html_head) extras.push(`<details style="margin:4px 0"><summary style="font-size:10px;cursor:pointer">html_head (先頭800字)</summary><pre style="font-size:10px;background:#fff;padding:6px;border-radius:4px;margin:4px 0;max-height:240px;overflow:auto">${escapeHtml(p.html_head)}</pre></details>`);
          const mainRow = `<tr style="border-bottom:1px solid #fef3d0;${ok ? 'background:#f1faf4' : ''}"><td style="padding:3px 8px"><code style="font-size:10.5px">${escapeHtml(p.method || "")}&nbsp;${escapeHtml(p.endpoint || "")}</code></td><td style="padding:3px 8px;text-align:right"><b style="color:${ok ? '#0c7a3e' : '#b4690a'}">${p.status ?? "ERR"}</b></td><td style="padding:3px 8px;font-size:10.5px;color:#5a6173">${escapeHtml(p.content_type || "—")}</td><td style="padding:3px 8px;text-align:right;font-size:10.5px">${escapeHtml(txt)}</td></tr>`;
          const extraRow = extras.length ? `<tr style="${ok ? 'background:#f1faf4' : ''}"><td colspan="4" style="padding:6px 12px;font-size:11px;border-bottom:1px solid #fef3d0">${extras.join("")}</td></tr>` : "";
          return mainRow + extraRow;
        }).join("")}</tbody></table></div>` : "";
        const dl = fc.download_list || {};
        const dlBlock = dl.status ? `<div style="margin:10px 0;padding:10px;background:#e6f4ea;border:2px solid #2e7d32;border-radius:8px"><div style="font-weight:800;font-size:12.5px;color:#2e7d32;margin-bottom:6px">📋 /rpp/api/download/list 応答（履歴一覧 — downloadId を取り出す）</div><div style="font-size:12px;margin:4px 0"><b>status:</b> ${dl.status} ・ <b>extracted_rows:</b> ${dl.extracted_rows_count ?? "—"}</div>${dl.first_row_keys ? `<div style="font-size:11px;margin:4px 0"><b>first_row_keys:</b> ${dl.first_row_keys.map(k => `<code style="font-size:10.5px;margin-right:6px;color:#1b5e20">${escapeHtml(k)}</code>`).join("")}</div>` : ""}${dl.first_3_rows ? `<div style="font-size:11px;margin:4px 0"><b>first_3_rows:</b><pre style="background:#fff;padding:8px;border-radius:4px;font-size:10.5px;overflow:auto;max-height:240px;margin:4px 0">${escapeHtml(JSON.stringify(dl.first_3_rows, null, 2))}</pre></div>` : ""}${dl.body_text ? `<div style="font-size:11px;color:#5a6173"><b>body_text:</b> ${escapeHtml(dl.body_text.slice(0,400))}…</div>` : ""}${dl.error ? `<div style="color:#8a1c17"><b>error:</b> ${escapeHtml(dl.error)}</div>` : ""}</div>` : "";
        const da = fc.downloadAsync || {};
        const adp = fc.after_dl_probes || [];
        const adpTbl = adp.length ? `<div style="margin:8px 0"><div style="font-weight:800;font-size:11.5px;color:#0c7a3e;margin-bottom:4px">📥 downloadAsync 後の取得先候補（status 200 で body_preview が見えるものが正解）</div><table style="width:100%;font-size:10.5px;border-collapse:collapse"><thead><tr style="background:#fff;border-bottom:1px solid #bfe6cf"><th style="text-align:left;padding:3px 6px">endpoint</th><th style="text-align:right;padding:3px 6px">status</th><th style="text-align:left;padding:3px 6px">body_preview</th></tr></thead><tbody>${adp.map(p => { const ok = p.status >= 200 && p.status < 300; return `<tr style="border-bottom:1px solid #e3f0e7;${ok ? 'background:#f1faf4' : ''}"><td style="padding:3px 6px"><code style="font-size:10px">${escapeHtml(p.endpoint || "")}</code></td><td style="padding:3px 6px;text-align:right"><b style="color:${ok ? '#0c7a3e' : '#b4690a'}">${p.status ?? "ERR"}</b></td><td style="padding:3px 6px;font-size:10px;color:#5a6173"><code>${escapeHtml((p.body_preview || p.error || "").slice(0,200))}</code></td></tr>`; }).join("")}</tbody></table></div>` : "";
        const daBlock = da.status ? `<div style="margin:10px 0;padding:10px;background:#e8f6ee;border:2px solid #0c7a3e;border-radius:8px"><div style="font-weight:800;font-size:12.5px;color:#0c7a3e;margin-bottom:6px">🚀 downloadAsync 応答（CSV ダウンロード用 API）</div><div style="font-size:12px;margin:4px 0"><b>status:</b> ${da.status} ・ <b>content_type:</b> ${escapeHtml(da.content_type || "—")}</div>${da.body ? `<div style="font-size:11px;margin:4px 0"><b>body:</b><pre style="background:#fff;padding:8px;border-radius:4px;margin:4px 0;font-size:11px;overflow:auto;max-height:160px">${escapeHtml(JSON.stringify(da.body, null, 2))}</pre></div>` : ""}${da.body_text ? `<div style="font-size:11px;margin:4px 0"><b>body_text:</b><pre style="background:#fff;padding:8px;border-radius:4px;font-size:10.5px;overflow:auto;max-height:140px">${escapeHtml(da.body_text)}</pre></div>` : ""}${da.all_headers ? `<details style="margin:4px 0;font-size:11px"><summary style="cursor:pointer"><b>all_headers</b>（job ID 단서 찾기）</summary><pre style="background:#fff;padding:6px;border-radius:4px;font-size:10px;overflow:auto;max-height:200px;margin:4px 0 0 0">${escapeHtml(JSON.stringify(da.all_headers, null, 2))}</pre></details>` : ""}${da.error ? `<div style="color:#8a1c17"><b>error:</b> ${escapeHtml(da.error)}</div>` : ""}${adpTbl}</div>` : "";
        const rs = fc.row_summary || [];
        const rowSumTbl = rs.length ? `<div style="margin:12px 0 8px"><div style="font-weight:800;font-size:12px;color:#15181e;margin-bottom:4px">📋 受信した10件の中身（キャンペーンが <b>${fc.distinct_campaigns}</b> 種類）</div><table style="width:100%;font-size:11px;border-collapse:collapse"><thead><tr style="background:#fff;border-bottom:1px solid #f0c060"><th style="text-align:left;padding:4px 8px">campaignId</th><th style="text-align:left;padding:4px 8px">campaign</th><th style="text-align:left;padding:4px 8px">keyword</th><th style="text-align:left;padding:4px 8px">itemUrl</th></tr></thead><tbody>${rs.map(x => `<tr style="border-bottom:1px solid #fef3d0"><td style="padding:3px 8px"><code style="font-size:10.5px">${escapeHtml(String(x.campaignId ?? "—"))}</code></td><td style="padding:3px 8px">${escapeHtml(x.campaignName || "—")}</td><td style="padding:3px 8px"><b>${escapeHtml(x.keyword || "—")}</b></td><td style="padding:3px 8px;font-size:10px;color:#5a6173">${escapeHtml(x.itemUrl || "")}</td></tr>`).join("")}</tbody></table>${fc.row_keys ? `<details style="margin-top:6px"><summary style="font-size:10.5px;cursor:pointer">▶ row_keys（応答1行の全フィールド名）</summary><div style="font-size:10px;color:#0c5a99;background:#fff;padding:6px;border-radius:4px;margin-top:4px">${fc.row_keys.map(k => `<code style="margin-right:8px">${escapeHtml(k)}</code>`).join("")}</div></details>` : ""}</div>` : "";
        return `<div class="cl-notes" style="margin-top:10px;background:#fff7e6;border:2px solid #f0a020;padding:12px"><div class="cl-sec-h" style="color:#b4690a;font-size:13px">🔧 ページネーション診断</div>${daBlock}${dlBlock}<div style="margin:6px 0;font-size:12px;color:#15181e"><b>KW別呼び出し回数:</b> ${r._diagnostic.kw_calls_count} ・ <b>各回のページ数:</b> ${r._diagnostic.pages_per_kw_call.join(' / ')}</div>${rowSumTbl}${variantTbl}${probeTbl}<details style="margin-top:8px"><summary style="cursor:pointer;font-size:11px;color:#5a6173">▶ raw JSON</summary><pre style="font-size:11px;background:#fff;padding:10px;border:1px solid #f0c060;border-radius:6px;overflow:auto;max-height:400px;margin:6px 0 0 0">${escapeHtml(JSON.stringify(fc, null, 2))}</pre></details></div>`;
      })() : ""}
    `;
    toast("取得完了");
    await loadStatus(); await loadCoverage();
    // 백그라운드 작업이 등록됐으면 진행 패널 갱신 시작
    pollJobs();
  } catch (e) {
    box.classList.add("err"); box.textContent = "❌ " + e.message;
  } finally { btn.disabled = false; }
};

// 백그라운드 다운로드 작업 진행 패널 (10초마다 갱신)
let jobsTimer = null;
async function pollJobs() {
  try {
    const { jobs, counts } = await api.get("/api/jobs");
    const panel = $("#jobs-panel");
    if (!panel) return;
    const active = (counts.pending || 0) + (counts.registered || 0);
    if (!jobs.length) { panel.classList.add("hidden"); return; }
    panel.classList.remove("hidden");
    const labelOf = (j) => {
      const sel = { 3: "📦 商品別", 4: "🔍 キーワード別" }[j.selection_type] || `sel=${j.selection_type}`;
      return `${sel} ${j.start_date}〜${j.end_date}`;
    };
    const statusBadge = (s) => {
      const map = { pending: ["⏳ 登録待ち", "#b4690a", "#fff7e6"],
                    registered: ["⚙️ 楽天処理中", "#0c5a99", "#e6f1fc"],
                    completed: ["✅ 完了", "#0c7a3e", "#f1faf4"],
                    failed: ["❌ 失敗", "#8a1c17", "#fdecec"] };
      const [t, c, bg] = map[s] || [s, "#5a6173", "#f5f6f8"];
      return `<span style="background:${bg};color:${c};font-size:10.5px;font-weight:800;padding:2px 8px;border-radius:999px;border:1px solid ${c}33">${t}</span>`;
    };
    const rows = jobs.slice(0, 10).map(j => {
      const elapsed = Math.round((Date.now() - new Date(j.created_at.replace(' ', 'T') + 'Z').getTime()) / 60000);
      return `<tr style="border-bottom:1px solid #eef1f5">
        <td style="padding:6px 10px;font-size:12px">${labelOf(j)}</td>
        <td style="padding:6px 10px">${statusBadge(j.status)}</td>
        <td style="padding:6px 10px;font-size:11px;color:#5a6173">${j.normalized_rows != null ? `${fmt(j.normalized_rows)}行` : "—"}</td>
        <td style="padding:6px 10px;font-size:11px;color:#5a6173">${isFinite(elapsed) ? `${elapsed}分前` : "—"}</td>
      </tr>`;
    }).join("");
    panel.innerHTML = `
      <div class="card-head"><h3 style="font-size:14px">📥 バックグラウンドダウンロード <span class="muted small">楽天は処理に5〜10分要します。完了すると自動で正確データに更新されます。</span></h3></div>
      <div style="margin-bottom:8px;font-size:12px">処理中: <b>${active}</b> ・ 完了: <b>${counts.completed || 0}</b> ・ 失敗: <b>${counts.failed || 0}</b></div>
      <table style="width:100%;font-size:12px;border-collapse:collapse"><tbody>${rows}</tbody></table>
    `;
    // 활성 작업이 있으면 10초마다 폴링 계속
    clearTimeout(jobsTimer);
    if (active > 0) jobsTimer = setTimeout(pollJobs, 10000);
  } catch (e) {
    // 패널 만 hide
  }
}
// 페이지 로드시 한 번 + view 진입시
window.addEventListener("load", () => setTimeout(pollJobs, 1000));
$("#btn-refresh-cov").onclick = loadCoverage;
async function loadCoverage() {
  try {
    const { coverage } = await api.get("/api/coverage");
    const list = $("#coverage-list");
    if (!coverage.length) { list.innerHTML = `<span class="muted small">まだ取得されたデータがありません。上で日付を選んで取得してみてください。</span>`; return; }
    // 日付ごとにグループ化
    const byDate = {};
    coverage.forEach(c => { (byDate[c.report_date] ||= []).push(c); });
    list.innerHTML = Object.keys(byDate).sort().reverse().slice(0, 60).map(d => {
      const tags = byDate[d].map(c => `<span class="cov-tag">${c.ad_product} ${fmt(c.rows)}</span>`).join("");
      return `<div class="cov-row"><span class="cov-date">${d}</span>${tags}</div>`;
    }).join("");
  } catch (e) { toast("状況の読み込みに失敗: " + e.message, true); }
}
// ---- 기간 백필 ----
function lastDayOfMonth(ym) { const [y, m] = ym.split("-").map(Number); return new Date(y, m, 0).toISOString().slice(0, 10); }
let bfTimer = null;
$("#btn-backfill").onclick = async () => {
  const fm = $("#bf-from").value, tm = $("#bf-to").value;
  if (!fm || !tm) return toast("開始月／終了月を選択してください", true);
  const from = fm + "-01", to = lastDayOfMonth(tm);

  // 확장 설치돼 있으면 → 브라우저 워커 사용 (로컬 속도 + 멀티숍 + 楽天 IP 통과)
  await ensureExt(1500);
  if (EXT_READY) {
    await ensureRakutenTab();
    const shopId = await ensureShopConsistent();
    if (!shopId) return;
    return runBackfillViaExtension(from, to, shopId);
  }
  // 폴백 (서버 사이드): 옛 cookie session 필요
  const st = await api.get("/api/status").catch(() => null);
  if (st && !st.session) return toast("セッションが無効です — 拡張機能の「Cookieを送信」を押してから再実行してください", true);
  // 폴백 — 서버 백필 (로컬 또는 Cloud Run)
  try {
    const r = await api.post("/api/backfill", { from, to });
    // 로컬 local_server.py: {started: true, months}
    // Vercel 신: {ok: true, started: true, months, debug}
    // forward 실패 시: {ok: false, error, debug}
    if (r.ok === false) {
      const dbg = JSON.stringify(r.debug || {}, null, 2);
      console.error("[backfill] forward failed:", r);
      alert(`一括取得の開始に失敗\n\nエラー: ${r.error}\n\nデバッグ:\n${dbg}`);
      return;
    }
    if ($("#view-collect").classList.contains("hidden")) switchView("collect");
    $("#bf-progress").classList.remove("hidden");
    $("#btn-backfill").disabled = true; $("#btn-refill").disabled = true;
    $("#btn-backfill-cancel").style.display = "";
    console.log("[backfill] started:", r);
    toast(`取得を開始しました（${r.months}ヶ月） — 進捗バーで確認できます。完了まで数分かかります。`, "ok");
    setTimeout(() => $("#bf-progress").scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    pollBackfill();
  } catch (e) { toast("一括取得の開始に失敗: " + e.message, true); }
};
$("#btn-backfill-cancel").onclick = async () => { await api.post("/api/backfill/cancel", {}); toast("キャンセルを要求しました"); };

// 結果 박스 HTML 생성 (데이터 취득 박스 + 백필 완료 모달 공통).
// 디자인: Modern SaaS 풍 — Hero 절제, 6개 카드 한 줄 평등 배치, 그룹 칩 라벨, 0 카드는 회색 톤.
// opts: {from, to, totals, totalRows, ok, failed, elapsed, log}
function buildCollectResultHTML(opts) {
  const ALL = [
    { group: "RPP 集計", key: "全体広告",     short: "全体広告" },
    { group: "RPP 集計", key: "キャンペーン別", short: "キャンペーン" },
    { group: "RPP 明細", key: "商品別",       short: "商品別" },
    { group: "RPP 明細", key: "キーワード別",   short: "キーワード" },
    { group: "その他",   key: "CPA",         short: "CPA" },
    { group: "その他",   key: "TDA",         short: "TDA" },
  ];
  const GROUP_COLORS = {
    "RPP 集計": "#0c7a3e",
    "RPP 明細": "#1d4ed8",
    "その他":    "#7d8590",
  };
  const card = (def) => {
    const v = opts.totals[def.key] || 0;
    const zero = !v;
    const valColor = zero ? "#bcc1c7" : "#15181e";
    const dotColor = zero ? "#e5e7eb" : GROUP_COLORS[def.group];
    return `
      <div style="background:#fff;border:1px solid #eef0f2;border-radius:10px;padding:14px 14px 12px;display:flex;flex-direction:column;gap:8px;min-width:0;position:relative;overflow:hidden">
        <span style="position:absolute;top:0;left:0;width:3px;height:100%;background:${dotColor}"></span>
        <div style="font-size:10.5px;font-weight:600;color:#7d8590;letter-spacing:.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(def.short)}</div>
        <div style="font-size:26px;font-weight:800;color:${valColor};line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.5px">${fmt(v)}</div>
        <div style="font-size:9.5px;font-weight:500;color:#9ca3af;letter-spacing:.3px;text-transform:uppercase">${escapeHtml(def.group)}</div>
      </div>
    `;
  };

  const logLines = (opts.log || []).slice(-30).reverse();
  const logHtml = logLines.length
    ? logLines.map(l => {
        const isErr = l.includes('失敗') || l.includes('エラー');
        return `<div style="font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;padding:4px 8px;border-radius:4px;margin-bottom:1px;${isErr ? 'background:#fef2f2;color:#bf0000;font-weight:600' : 'color:#475569'}">${escapeHtml(l)}</div>`;
      }).join("")
    : `<div style="color:#9ca3af;font-size:12px;padding:8px">— ログなし</div>`;

  const rate = opts.totalRows && opts.elapsed
    ? Math.round(opts.totalRows / Math.max(1, parseInt(opts.elapsed) || 1))
    : 0;

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding-bottom:14px;border-bottom:1px solid #f0f2f5;margin-bottom:18px">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="display:inline-flex;width:22px;height:22px;border-radius:50%;background:#dcfce7;color:#0c7a3e;align-items:center;justify-content:center;font-size:13px;font-weight:800">✓</span>
        <span style="font-size:14.5px;font-weight:700;color:#15181e">取得完了</span>
      </div>
      <div style="font-size:11.5px;color:#7d8590;font-variant-numeric:tabular-nums;font-weight:500">
        ${escapeHtml(opts.from)} 〜 ${escapeHtml(opts.to)} <span style="color:#cbd5e1;margin:0 4px">·</span>
        ⏱ ${escapeHtml(opts.elapsed)} <span style="color:#cbd5e1;margin:0 4px">·</span>
        成功 <b style="color:#0c7a3e">${opts.ok}</b> / 失敗 <b style="color:${opts.failed?'#bf0000':'#94a3b8'}">${opts.failed}</b>
      </div>
    </div>

    <div style="display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:16px;padding:18px 20px;background:linear-gradient(180deg,#fafbfc 0%,#ffffff 100%);border:1px solid #eef0f2;border-radius:12px;margin-bottom:16px">
      <div>
        <div style="font-size:10.5px;color:#7d8590;font-weight:600;letter-spacing:.5px;text-transform:uppercase;margin-bottom:4px">合計取得件数</div>
        <div style="font-size:40px;font-weight:800;color:#15181e;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-1px">${fmt(opts.totalRows)}<span style="font-size:15px;color:#94a3b8;font-weight:600;margin-left:6px">件</span></div>
      </div>
      ${rate ? `
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px">
        <div style="font-size:10.5px;color:#7d8590;font-weight:600;letter-spacing:.5px;text-transform:uppercase">取得速度</div>
        <div style="font-size:20px;font-weight:700;color:#15181e;font-variant-numeric:tabular-nums">${fmt(rate)} <span style="font-size:11px;color:#94a3b8;font-weight:600">件/秒</span></div>
      </div>
      ` : ""}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px">
      ${ALL.map(card).join("")}
    </div>

    <details>
      <summary style="cursor:pointer;font-size:12px;font-weight:600;color:#5a6173;padding:8px 4px;user-select:none;list-style:none;display:flex;align-items:center;gap:6px">
        <span style="display:inline-block;transition:transform .15s">▶</span>
        取得ログ <span style="color:#9ca3af;font-weight:500">(${logLines.length}件)</span>
      </summary>
      <div style="max-height:240px;overflow:auto;background:#fafbfc;border:1px solid #eef0f2;border-radius:8px;padding:8px;margin-top:6px;display:flex;flex-direction:column;gap:1px">${logHtml}</div>
    </details>
  `;
}

// 백필 완료 모달 표시 (전체 결과 큰 화면)
function showBackfillCompleteModal(opts) {
  // 같은 ID 가 떠있으면 먼저 닫기
  const existing = document.getElementById("bf-complete-modal");
  if (existing) existing.remove();

  const m = document.createElement("div");
  m.id = "bf-complete-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(15,24,32,.55);z-index:9998;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(2px)";
  m.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:24px;width:min(760px,100%);max-height:90vh;overflow:auto;box-shadow:0 30px 80px rgba(0,0,0,.35)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <h2 style="margin:0;font-size:18px;font-weight:800">🎉 一括取得 完了</h2>
        <button class="bfm-close" style="background:none;border:none;font-size:22px;cursor:pointer;color:#7d8590;line-height:1;padding:4px 10px">✕</button>
      </div>
      ${buildCollectResultHTML(opts)}
      <div style="text-align:right;margin-top:14px;padding-top:14px;border-top:1px solid #eef0f2">
        <button class="bfm-ok" style="background:#bf0000;color:#fff;border:none;border-radius:6px;padding:9px 22px;font-weight:700;cursor:pointer;font-size:13px">確認</button>
      </div>
    </div>
  `;
  document.body.appendChild(m);
  const close = () => {
    m.remove();
    document.removeEventListener("keydown", onEsc);
  };
  const onEsc = (e) => { if (e.key === "Escape") close(); };
  m.querySelector(".bfm-close").onclick = close;
  m.querySelector(".bfm-ok").onclick = close;
  m.addEventListener("click", (e) => { if (e.target === m) close(); });
  document.addEventListener("keydown", onEsc);
}

// 확장 워커로 백필 실행 (브라우저 = 본인 楽天 세션 직접 사용)
//   opts.standalone        : true 시 #bf-progress / btn-backfill 등 백필 UI 일절 안 건드림
//   opts.resultBoxSelector : standalone 시 진행 + 결과 둘 다 그릴 박스 (#collect-result)
//   opts.label             : 시작 토스트 메시지 ("取得" vs "一括取得")
async function runBackfillViaExtension(from, to, shopId, opts = {}) {
  const standalone = !!opts.standalone;
  const cfg = await loadAuthConfig();
  const vercelUrl = window.location.origin;
  const jwt = sessionStorage.getItem("sb_access_token") || "";
  const taskId = "bf_" + Date.now();
  if (!standalone) {
    $("#bf-progress").classList.remove("hidden");
    $("#btn-backfill").disabled = true; $("#btn-refill").disabled = true;
    $("#btn-backfill-cancel").style.display = "";
  }
  toast(`${opts.label || '一括取得'}開始（ブラウザワーカー）— 進捗を確認できます。`, "ok");
  const startTs = Date.now();
  let lastProgress = { ok: 0, failed: 0, rows: 0, totals: {}, current: '', log: [], done: false };

  const fmtTime = (sec) => {
    sec = sec || 0;
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? `${h}時間` : "") + (m || h ? `${m}分` : "") + `${s}秒`;
  };

  const tickTimer = setInterval(() => {
    if (lastProgress.done) { clearInterval(tickTimer); return; }
    render(lastProgress, Math.floor((Date.now() - startTs) / 1000));
  }, 1000);

  function render(info, elapsedOverride) {
    const elapsed = elapsedOverride !== undefined ? elapsedOverride : (info.elapsed_seconds || 0);
    const pct = info.progress_pct != null ? info.progress_pct
              : (info.total_count ? Math.floor((info.done_count || 0) / info.total_count * 100) : 0);
    const counter = info.total_count ? `${info.done_count || 0}/${info.total_count}` : `${info.ok || 0}成功`;
    const timeChip = `<span class="bf-time">⏱ 経過 <b>${fmtTime(elapsed)}</b></span>`;
    const totals = info.totals || {};

    if (standalone) {
      // 결과 박스에 진행 + 결과 자체 렌더 (백필 영역 건드리지 않음)
      const rb = opts.resultBoxSelector ? document.querySelector(opts.resultBoxSelector) : null;
      if (!rb) return;
      if (info.done) {
        if (info.error) {
          rb.className = "result-box err";
          rb.innerHTML = `<div class="cl-head"><span class="cl-ok" style="color:#bf0000">⚠ 取得失敗</span><span class="muted small">${escapeHtml(info.error)}</span></div>`;
        } else {
          rb.className = "result-box ok";
          rb.innerHTML = buildCollectResultHTML({ from, to, totals, totalRows: info.rows || 0, ok: info.ok || 0, failed: info.failed || 0, elapsed: fmtTime(elapsed), log: info.log || [] });
        }
      } else {
        rb.className = "result-box";
        const totalsChips = Object.entries(totals).map(([k,v]) =>
          `<span style="background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:2px 10px;font-size:11px;margin-right:4px">${escapeHtml(k)} <b>${fmt(v)}</b></span>`).join("");
        rb.innerHTML = `
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
            <span class="spin"></span>
            <b style="font-size:13px">取得中</b>
            <span class="muted small">${escapeHtml(info.current || '')}</span>
            <span style="margin-left:auto">${timeChip}</span>
          </div>
          <div style="background:#f0f2f5;border-radius:6px;overflow:hidden;height:6px;margin:6px 0 8px">
            <div style="background:#bf0000;height:100%;width:${pct}%;transition:width .3s"></div>
          </div>
          <div class="muted small" style="margin-bottom:6px">${counter} · 成功 ${info.ok || 0} / 失敗 ${info.failed || 0} · 累計 ${fmt(info.rows || 0)}件</div>
          ${totalsChips ? `<div style="margin-top:6px">${totalsChips}</div>` : ""}
        `;
      }
    } else {
      // 기존 백필 UI
      $("#bf-bar").style.width = pct + "%";
      $("#bf-status").innerHTML = `${info.done ? '完了' : '取得中 ' + escapeHtml(info.current || '')} · ${counter} · 成功 ${info.ok || 0} / 失敗 ${info.failed || 0} · 累計 ${fmt(info.rows || 0)}件 · ${timeChip}`;
      $("#bf-totals").innerHTML = Object.entries(totals)
        .map(([k, v]) => `<span class="t">${k} <b>${fmt(v)}</b></span>`).join("");
      $("#bf-log").innerHTML = (info.log || []).slice().reverse()
        .map(l => `<div class="${l.includes('失敗') || l.includes('エラー') ? 'fail' : ''}">${escapeHtml(l)}</div>`).join("");
    }
  }

  ext_on('BACKFILL_PROGRESS', (info) => {
    if (info.taskId !== taskId) return;
    lastProgress = { ...lastProgress, ...info };
    render(lastProgress, Math.floor((Date.now() - startTs) / 1000));
    if (info.done) {
      if (!standalone) {
        $("#btn-backfill").disabled = false; $("#btn-refill").disabled = false;
        $("#btn-backfill-cancel").style.display = "none";
      } else {
        const cb = document.querySelector('#btn-collect');
        if (cb) cb.disabled = false;
      }
      if (info.error) toast("エラー: " + info.error, true);
      else toast(`完了 — ${fmt(info.rows || 0)}件 取得`, "ok");
      loadStatus(); loadCoverage();
      // 백필(!standalone) 완료 시 전체 결과 모달
      if (!standalone && !info.error) {
        const elapsedSec = Math.floor((Date.now() - startTs) / 1000);
        showBackfillCompleteModal({
          from, to,
          totals: lastProgress.totals || {},
          totalRows: info.rows || 0,
          ok: info.ok || 0,
          failed: info.failed || 0,
          elapsed: fmtTime(elapsedSec),
          log: info.log || [],
        });
      }
    }
  });

  const r = await ext_call({
    type: 'START_BACKFILL',
    taskId, shop_id: shopId, from, to,
    vercelUrl, jwt,
  });
  if (r?.error) {
    toast("拡張機能エラー: " + r.error, true);
    if (!standalone) {
      $("#btn-backfill").disabled = false; $("#btn-refill").disabled = false;
      $("#btn-backfill-cancel").style.display = "none";
    } else {
      const cb = document.querySelector('#btn-collect');
      if (cb) cb.disabled = false;
    }
  }
}
async function pollBackfill() {
  clearTimeout(bfTimer);
  let s;
  try { s = await api.get("/api/backfill/status"); } catch (e) { bfTimer = setTimeout(pollBackfill, 2000); return; }
  const pct = s.total ? Math.round(s.done / s.total * 100) : 0;
  $("#bf-bar").style.width = pct + "%";
  const fmtTime = (sec) => {
    if (!sec || sec < 0) return "0秒";
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
    return (h ? `${h}時間` : "") + (m || h ? `${m}分` : "") + `${s2}秒`;
  };
  const elapsed = s.elapsed_seconds || 0;
  const eta = (s.running && s.done > 0 && s.total > s.done)
    ? Math.round(elapsed * (s.total - s.done) / s.done) : 0;
  const timeChip = `<span class="bf-time">⏱ 経過 <b>${fmtTime(elapsed)}</b>${eta ? ` · 残り目安 <b>${fmtTime(eta)}</b>` : ""}</span>`;
  $("#bf-status").innerHTML = `${s.running ? "取得中 " + escapeHtml(s.current || "") : "完了"} · ${s.done}/${s.total} · 成功 ${s.ok} / スキップ ${s.failed} · 累計 ${fmt(s.rows)}件 · ${timeChip}`;
  // 広告メニュー別の取得内訳
  const totals = s.totals || {};
  $("#bf-totals").innerHTML = Object.keys(totals).length
    ? Object.entries(totals).map(([k, v]) => `<span class="t">${k} <b>${fmt(v)}</b></span>`).join("") : "";
  // 未取得・制限の理由 — 같은 사유 묶고 접기/펼치기
  const reasons = Object.entries(s.skips || {}), notes = s.notes || [];
  if (reasons.length || notes.length) {
    // "광고タイプ · 사유" → 사유별로 그룹핑 (같은 이유는 합치고 광고タイプ 카운트 모음)
    const grouped = {};
    reasons.forEach(([r, c]) => {
      const idx = r.indexOf(" · "); const cat = idx > 0 ? r.slice(0, idx) : "";
      const reason = idx > 0 ? r.slice(idx + 3) : r;
      grouped[reason] = grouped[reason] || { total: 0, byCat: {} };
      grouped[reason].total += c;
      if (cat) grouped[reason].byCat[cat] = (grouped[reason].byCat[cat] || 0) + c;
    });
    const sortedReasons = Object.entries(grouped).sort((a, b) => b[1].total - a[1].total);
    $("#bf-reasons").innerHTML = `<div class="bf-reasons">
      <div class="rh">ℹ️ 未取得・制限の理由 <span class="muted small" style="margin-left:6px;font-weight:600">${sortedReasons.length}種類</span></div>
      ${notes.map(n => `<div class="bf-note">${escapeHtml(n)}</div>`).join("")}
      <div class="bf-reason-list">${sortedReasons.map(([reason, info]) => `
        <details class="bf-reason"><summary><span class="bf-reason-label">${escapeHtml(reason)}</span><span class="bf-reason-count">${fmt(info.total)}件</span></summary>
          <div class="bf-reason-body">${Object.entries(info.byCat).map(([cat, n]) => `<span class="bf-cat-pill">${cat} <b>${fmt(n)}</b></span>`).join("")}</div>
        </details>`).join("")}</div>
    </div>`;
  } else $("#bf-reasons").innerHTML = "";
  $("#bf-log").innerHTML = (s.log || []).slice().reverse()
    .map(l => `<div class="${l.includes("スキップ") || l.includes("キャンセル") || l.includes("失敗") ? "fail" : ""}">${l}</div>`).join("");
  if (s.running) { bfTimer = setTimeout(pollBackfill, 1500); }
  else {
    $("#btn-backfill").disabled = false;
    $("#btn-refill").disabled = false;
    $("#btn-backfill-cancel").style.display = "none";
    if (s.error) toast("エラー: " + s.error, true);
    else if (s.ok === 0 && s.failed > 0) toast("0件 — セッション切れの可能性。拡張機能でCookieを再送信してください", true);
    else toast(`完了 — ${fmt(s.rows)}件 取得`, "ok");
    loadStatus(); loadCoverage();
  }
}

// 미수집 채우기 (수집 가능한 구간의 빈 날짜만 재수집)
$("#btn-refill").onclick = async () => {
  try {
    const r = await api.post("/api/refill", {});
    $("#bf-progress").classList.remove("hidden");
    $("#btn-backfill").disabled = true;
    $("#btn-refill").disabled = true;
    $("#btn-backfill-cancel").style.display = "";
    toast(`取得漏れの補完を開始（${r.units}件）`);
    pollBackfill();
  } catch (e) { toast("補完の開始に失敗: " + e.message, true); }
};

/* ---------------- 필터 빌더 ---------------- */
function buildFilters(elId, opts) {
  const max = (STATUS.bounds && STATUS.bounds.max) || STATUS.yesterday || today();
  const from = addDays(max, -6), to = max;
  const selSel = opts.selection ? `
    <div class="f"><label>集計単位</label><select data-k="selection_type">
      <option value="1">全体</option><option value="2">キャンペーン別</option><option value="3">商品別</option><option value="4">キーワード別</option>
    </select></div>` : "";
  const prods = opts.allProduct ? ["RPP", "TDA", "CPA", "ALL"] : ["RPP", "TDA", "ALL"];
  // 광고종별 세그 칩
  const prodSeg = prods.map(p => `<button type="button" class="pill-chip" data-k="product" data-v="${p}">${p === "ALL" ? "全広告" : p}</button>`).join("");
  // CV計測 칩 (켜기/끄기 토글식 2값)
  const winSeg = `<div class="filter-block"><span class="filter-lab">CV計測</span>
    <div class="pill-group">
      <button type="button" class="pill-chip" data-k="window" data-v="720h">720h (30日)</button>
      <button type="button" class="pill-chip" data-k="window" data-v="12h">12h</button>
    </div></div>`;
  // 集計対象 칩
  const segGroup = opts.segment ? `<div class="filter-block"><span class="filter-lab">集計対象</span>
    <div class="pill-group">
      <button type="button" class="pill-chip" data-k="segment" data-v="all">全体</button>
      <button type="button" class="pill-chip" data-k="segment" data-v="new">新規顧客</button>
      <button type="button" class="pill-chip" data-k="segment" data-v="existing">既存顧客</button>
    </div></div>` : "";
  // 集計単位는 4개 옵션이라 슬라이드 드롭다운 대신 칩으로
  const selSegment = opts.selection ? `<div class="filter-block"><span class="filter-lab">集計単位</span>
    <div class="pill-group">
      <button type="button" class="pill-chip" data-k="selection_type" data-v="1">全体</button>
      <button type="button" class="pill-chip" data-k="selection_type" data-v="2">キャンペーン別</button>
      <button type="button" class="pill-chip" data-k="selection_type" data-v="3">商品別</button>
      <button type="button" class="pill-chip" data-k="selection_type" data-v="4">キーワード別</button>
    </div></div>` : "";
  $(elId).innerHTML = `
    <div class="filter-main">
      <div class="filter-block">
        <span class="filter-lab">広告種別</span>
        <div class="pill-group">${prodSeg}</div>
      </div>
      <div class="filter-block filter-period">
        <span class="filter-lab">期間</span>
        <div class="period-row">
          <input type="text" data-k="from" data-dp="day" value="${from}" class="dp-mini">
          <span class="period-sep">〜</span>
          <input type="text" data-k="to" data-dp="day" value="${to}" class="dp-mini">
          <div class="pill-group preset-inline">
            <button type="button" class="pill-chip preset-chip" data-preset="7">7日</button>
            <button type="button" class="pill-chip preset-chip" data-preset="30">30日</button>
            <button type="button" class="pill-chip preset-chip" data-preset="month">今月</button>
            <button type="button" class="pill-chip preset-chip" data-preset="all">全期間</button>
          </div>
        </div>
      </div>
      <button class="primary" data-act="apply">表示</button>
      ${selSegment || segGroup || winSeg ? `<button class="ghost-btn small adv-btn" data-act="toggle-adv">⚙️ 詳細</button>` : ""}
    </div>
    <div class="filter-adv hidden">${selSegment}${segGroup}${winSeg}</div>
    <!-- 호환용 hidden inputs (기존 readFilters/buildFilters 로직 호환) -->
    <div style="display:none">
      <select data-k="product">${prods.map(p => `<option value="${p}">${p}</option>`).join("")}</select>
      ${opts.selection ? `<select data-k="selection_type"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select>` : ""}
      ${opts.segment ? `<select data-k="segment"><option value="all">all</option><option value="new">new</option><option value="existing">existing</option></select>` : ""}
      <select data-k="window"><option value="720h">720h</option><option value="12h">12h</option></select>
    </div>`;
  // pill-chip → 숨겨진 select 동기화
  function setPill(k, v) {
    $$(`${elId} .pill-chip[data-k="${k}"]`).forEach(c => c.classList.toggle("on", c.dataset.v === v));
    const sel = $(`${elId} select[data-k="${k}"]`); if (sel) sel.value = v;
  }
  // 기본값 설정
  setPill("product", prods[0]);
  if (opts.selection) setPill("selection_type", "1");
  if (opts.segment) setPill("segment", "all");
  setPill("window", "720h");
  // 클릭으로 칩 토글
  $$(`${elId} .pill-chip[data-k]`).forEach(c => c.onclick = () => { setPill(c.dataset.k, c.dataset.v); opts.onApply && opts.onApply(); });
  $(`${elId} [data-act=apply]`).onclick = opts.onApply;
  const advBtn = $(`${elId} [data-act=toggle-adv]`);
  const advPanel = $(`${elId} .filter-adv`);
  if (advBtn) advBtn.onclick = () => {
    advPanel.classList.toggle("hidden");
    advBtn.textContent = advPanel.classList.contains("hidden") ? "⚙️ 詳細" : "⚙️ 閉じる";
  };
  $$(`${elId} [data-dp]`).forEach(el => attachPicker(el, el.dataset.dp));
  $$(`${elId} .preset-chip`).forEach(c => c.onclick = () => {
    const b = STATUS.bounds || {}, mx = b.max || STATUS.yesterday || today();
    let f0, t0 = mx;
    if (c.dataset.preset === "7") f0 = addDays(mx, -6);
    else if (c.dataset.preset === "30") f0 = addDays(mx, -29);
    else if (c.dataset.preset === "month") f0 = mx.slice(0, 8) + "01";
    else { f0 = b.min || addDays(mx, -29); t0 = mx; }
    $(`${elId} [data-k=from]`).value = f0;
    $(`${elId} [data-k=to]`).value = t0;
    $$(`${elId} .preset-chip`).forEach(x => x.classList.toggle("on", x === c));
    opts.onApply && opts.onApply();
  });
}
function readFilters(elId) {
  const o = {};
  $$(`${elId} [data-k]`).forEach(el => o[el.dataset.k] = el.value);
  return o;
}

/* ---------------- 대시보드 ---------------- */
let chartData = null, chartMetric = "ad_cost";
function loadDashboard() {
  if (!$("#dash-filters").innerHTML) buildFilters("#dash-filters", { segment: true, onApply: refreshDashboard });
  refreshDashboard();
}
// 通貨単位トグル(¥ ⇄ 万円) — 再取得せずキャッシュで再描画
let lastIns = {};
$("#btn-unit").onclick = () => {
  MONEY_UNIT = MONEY_UNIT === "yen" ? "man" : "yen";
  $("#btn-unit").textContent = MONEY_UNIT === "yen" ? "¥" : "万";
  if (lastIns && lastIns.current) { renderKPIs(lastIns); renderMovers(lastIns.movers); }
  if (topState.item.rows.length || topState.kw.rows.length) { renderTopDim("item"); renderTopDim("kw"); }
  if (detailRows.length) renderDetail();
};
function kpiSkeleton() {
  return Array.from({ length: 5 }, () => `<div class="kpi skel"><div class="label">広告</div><div class="val">000</div><div class="kpi-foot"></div></div>`).join("");
}
async function refreshDashboard() {
  const f = readFilters("#dash-filters");
  const win = f.window || "720h", seg = f.segment || "all";
  // 로딩 스켈레톤 — 모든 영역에 적용
  $("#kpi-row").innerHTML = kpiSkeleton();
  const chartCv = $("#chart"); if (chartCv) { const w = chartCv.parentElement; if (w) w.innerHTML = `<div class="skel skel-chart" style="height:240px"></div>`; }
  const insBox = $("#insight-list"); if (insBox) insBox.innerHTML = Array(3).fill(0).map(() => `<div class="skel skel-line" style="width:${60 + Math.random()*30}%"></div>`).join("");
  const moversBox = $("#movers"); if (moversBox) moversBox.innerHTML = `<table>${_skelTable(5, 5)}</table>`;
  ["top-item","top-kw"].forEach(id => { const el = $("#" + id); if (el) el.innerHTML = `<table>${_skelTable(6, 4)}</table>`; });
  const detail = $("#detail-table"); if (detail) detail.innerHTML = _skelTable(7, 8);
  // 상단 개요는 항상 전체(selection_type=1) 기준
  const qs = `from=${f.from}&to=${f.to}&product=${f.product}&selection_type=1&window=${win}&segment=${seg}`;
  try {
    const ins = await api.get("/api/kpis?" + qs);
    lastIns = ins;
    renderKPIs(ins);
    renderInsights(ins);
    renderMovers(ins.movers);
    const { series } = await api.get("/api/series?" + qs);
    chartData = series; drawChart();
    // TOP 상품/키워드
    const base = `from=${f.from}&to=${f.to}&product=${f.product}&window=${win}&segment=${seg}&order_by=ad_cost&limit=50`;
    const [ti, tk] = await Promise.all([
      api.get(`/api/top?${base}&selection_type=3`),
      api.get(`/api/top?${base}&selection_type=4`),
    ]);
    topState.item.rows = ti.rows; topState.kw.rows = tk.rows;
    renderTopDim("item"); renderTopDim("kw");
    loadDetail();
  } catch (e) { toast("ダッシュボードの読み込みに失敗: " + e.message, true); }
}
const trunc = (s, n = 34) => { s = String(s || "-"); return s.length > n ? s.slice(0, n) + "…" : s; };
const TOP_COLS = [["dimension_key", null], ["gms", "売上"], ["ad_cost", "広告費"],
["clicks", "クリック"], ["cv", "CV"], ["roas", "ROAS"]];
const topState = {
  item: { rows: [], sort: "ad_cost", desc: true, q: "", label: "商品", tbl: "#top-item-table" },
  kw: { rows: [], sort: "ad_cost", desc: true, q: "", label: "キーワード", tbl: "#top-kw-table" },
};
function renderTopDim(key) {
  const s = topState[key], t = $(s.tbl);
  let rows = s.rows.filter(r => !s.q || String(r.dimension_key || r.campaign_name || "").toLowerCase().includes(s.q.toLowerCase()));
  rows = rows.slice().sort((a, b) => {
    const x = a[s.sort] ?? -Infinity, y = b[s.sort] ?? -Infinity;
    return s.desc ? (y > x ? 1 : -1) : (x > y ? 1 : -1);
  }).slice(0, 15);
  if (!s.rows.length) { t.innerHTML = `<tr><td>${s.label}のデータがありません — 期間・広告種別をご確認ください。</td></tr>`; return; }
  const head = TOP_COLS.map(([k, l]) =>
    `<th data-k="${k}">${l || s.label}${s.sort === k ? (s.desc ? " ▼" : " ▲") : ""}</th>`).join("");
  const body = rows.map(r => "<tr>" +
    `<td class="dim-cell" title="${(r.dimension_key || r.campaign_name || "").replace(/"/g, "")}">${trunc(r.dimension_key || r.campaign_name)}</td>` +
    `<td>${fmtMoney(r.gms)}</td><td>${fmtMoney(r.ad_cost)}</td><td>${fmt(r.clicks)}</td><td>${fmt(r.cv)}</td><td>${fmtRoas(r.roas)}</td></tr>`).join("");
  t.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body || "<tr><td>検索結果なし</td></tr>"}</tbody>`;
  $$(`${s.tbl} th`).forEach(th => th.onclick = () => {
    const k = th.dataset.k; if (k === "dimension_key") return;
    if (s.sort === k) s.desc = !s.desc; else { s.sort = k; s.desc = true; }
    renderTopDim(key);
  });
  // 행 클릭 → 같은 화면의 詳細データ 드릴다운
  const selType = key === "item" ? 3 : 4;
  $$(`${s.tbl} tbody tr`).forEach((tr, i) => {
    const r = rows[i]; if (!r) return;
    tr.classList.add("row-click");
    tr.onclick = () => drillToDetail(selType, r.dimension_key || r.campaign_name);
  });
}
$("#search-item").addEventListener("input", e => { topState.item.q = e.target.value; renderTopDim("item"); });
$("#search-kw").addEventListener("input", e => { topState.kw.q = e.target.value; renderTopDim("kw"); });
function deltaHtml(p) {
  if (p === null || p === undefined) return `<span class="delta flat">— 比較なし</span>`;
  const cls = p > 0 ? "up" : (p < 0 ? "down" : "flat");
  const ar = p > 0 ? "▲" : (p < 0 ? "▼" : "—");
  return `<span class="delta ${cls}">${ar} ${Math.abs(p)}%</span>`;
}
function kpiCardsHTML(c, d) {
  const cards = [
    { l: "売上 (GMS)", v: fmtMoney(c.gms), d: d && d.gms },
    { l: "広告費", v: fmtMoney(c.ad_cost), d: d && d.ad_cost },
    { l: "クリック", v: fmt(c.clicks), d: d && d.clicks, sub: "CTR", subv: fmtPct(c.ctr) },
    { l: "CV (コンバージョン)", v: fmt(c.cv), d: d && d.cv, sub: "CVR", subv: fmtPct(c.cvr) },
    { l: "ROAS", v: fmtRoas(c.roas), d: d && d.roas, accent: true, sub: "CPC", subv: fmtMoney(c.cpc) },
  ];
  return cards.map(k =>
    `<div class="kpi${k.accent ? " kpi-accent" : ""}">
       <div class="label">${k.l}</div>
       <div class="val">${k.v}</div>
       <div class="kpi-foot">${d ? deltaHtml(k.d) : ""}${k.sub ? `<span class="kpi-sub">${k.sub} <b>${k.subv}</b></span>` : ""}</div>
     </div>`).join("");
}
function renderKPIs(ins) { $("#kpi-row").innerHTML = kpiCardsHTML(ins.current, ins.deltas); }
function renderInsights(ins) {
  const pr = ins.previous_range || {};
  let fresh = "";
  if (ins.impressions_last_date && ins.current && ins.current.clicks && !ins.current.ctr) {
    fresh = ` <span class="muted" style="margin-left:8px">ⓘ CTR は最新数日が未確定（最終確定: ${ins.impressions_last_date}）</span>`;
  }
  $("#kpi-caption").innerHTML = `各指標下の増減は <b>比較期間比</b>（${pr.from || "—"} 〜 ${pr.to || "—"}）${fresh}`;
  $("#insight-headline").textContent = ins.headline;
  $("#insight-bullets").innerHTML = ins.bullets.map(b => `<li>${b}</li>`).join("");
  const a = $("#insight-actions");
  a.innerHTML = (ins.actions && ins.actions.length)
    ? `<div class="actions-box"><div class="ah">⚡ 推奨アクション</div><ul>${ins.actions.map(x => `<li>${x}</li>`).join("")}</ul></div>` : "";
  $("#insight-note").textContent = "※ " + ins.note + `（比較期間: ${ins.previous_range.from}〜${ins.previous_range.to}）`;
}
function renderMovers(movers) {
  const t = $("#movers-table");
  if (!movers || !movers.length) { t.innerHTML = "<tr><td>データがありません</td></tr>"; return; }
  t.innerHTML = `<thead><tr><th>キャンペーン</th><th>広告費</th><th>ROAS</th><th>広告費 変動</th><th>ROAS 変動</th></tr></thead><tbody>` +
    movers.map(m => {
      const dc = m.cost_change_pct, dr = m.roas_change_pct;
      const cell = p => p === null || p === undefined ? "—" : `<span class="${p > 0 ? 'pos' : 'neg'}">${p > 0 ? '▲' : '▼'} ${Math.abs(p)}%</span>`;
      return `<tr><td>${m.campaign_name}</td><td>${fmtMoney(m.ad_cost)}</td><td>${fmtRoas(m.roas)}</td><td>${cell(dc)}</td><td>${cell(dr)}</td></tr>`;
    }).join("") + "</tbody>";
  $$("#movers-table tbody tr").forEach((tr, i) => {
    const m = movers[i]; if (!m) return;
    tr.classList.add("row-click");
    tr.onclick = () => drillToDetail(2, m.campaign_name);
  });
}
$$("#metric-toggle .seg-btn").forEach(b => b.onclick = () => {
  chartMetric = b.dataset.metric;
  $$("#metric-toggle .seg-btn").forEach(x => x.classList.toggle("active", x === b));
  drawChart();
});
// 일별 / 월별 토글
let chartGran = "day";
$$("#granularity-toggle .seg-btn").forEach(b => b.onclick = () => {
  chartGran = b.dataset.gran;
  $$("#granularity-toggle .seg-btn").forEach(x => x.classList.toggle("active", x === b));
  drawChart();
});
// 월별 집계 (chartData 가 일별 series 라 가정)
function aggregateMonthly(series) {
  const m = {};
  series.forEach(d => {
    const ym = d.report_date.slice(0, 7);
    m[ym] = m[ym] || { report_date: ym + "-01", clicks: 0, ad_cost: 0, gms: 0, cv: 0, impressions: 0 };
    m[ym].clicks += d.clicks || 0;
    m[ym].ad_cost += d.ad_cost || 0;
    m[ym].gms += d.gms || 0;
    m[ym].cv += d.cv || 0;
    m[ym].impressions += d.impressions || 0;
  });
  return Object.values(m).map(d => ({ ...d, roas: d.ad_cost ? d.gms / d.ad_cost : null }))
    .sort((a, b) => a.report_date < b.report_date ? -1 : 1);
}
const METRIC_LABEL = { ad_cost: "広告費", gms: "売上", roas: "ROAS", clicks: "クリック" };
const isMoneyMetric = m => m === "ad_cost" || m === "gms";
function abbr(v) {
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, "") + "億";
  if (a >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, "") + "万";
  return Math.round(v).toLocaleString("ko-KR");
}
function axisLabel(v) { return isMoneyMetric(chartMetric) ? abbr(v) : (chartMetric === "roas" ? Math.round(v * 100) + "%" : Math.round(v).toLocaleString()); }
function valLabel(v) {
  if (v == null) return "—";
  if (isMoneyMetric(chartMetric)) return "¥" + Math.round(v).toLocaleString("ko-KR");
  if (chartMetric === "roas") return fmtRoas(v);
  return Math.round(v).toLocaleString("ko-KR");
}
let chartGeom = null; // {pts:[{x,y,date,val}], hover}
function drawChart(hover = -1) {
  const cv = $("#trend-chart"); if (!cv || !chartData) return;
  const ctx = cv.getContext("2d");
  const W = cv.width = cv.clientWidth, H = cv.height = cv.clientHeight || 260;
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 64, r: 18, t: 18, b: 30 };
  const sourceSeries = (chartGran === "month") ? aggregateMonthly(chartData) : chartData;
  const data = sourceSeries.map(d => ({ x: d.report_date, y: d[chartMetric] ?? 0 }));
  if (!data.length) { ctx.fillStyle = "#9ca3af"; ctx.font = "13px sans-serif"; ctx.textAlign = "center"; ctx.fillText("データがありません — まず該当期間を取得してください", W / 2, H / 2); chartGeom = null; return; }
  const ys = data.map(d => d.y), maxY = Math.max(...ys) * 1.08 || 1, minY = Math.min(...ys, 0);
  const px = i => pad.l + (W - pad.l - pad.r) * (data.length === 1 ? .5 : i / (data.length - 1));
  const py = v => pad.t + (H - pad.t - pad.b) * (1 - (v - minY) / (maxY - minY || 1));
  // 그리드 + y라벨
  ctx.font = "11px sans-serif"; ctx.textAlign = "right"; ctx.strokeStyle = "#eef0f3"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = minY + (maxY - minY) * i / 4, y = py(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillStyle = "#9ca3af"; ctx.fillText(axisLabel(v), pad.l - 8, y + 4);
  }
  // 채움
  ctx.beginPath();
  data.forEach((d, i) => { const X = px(i), Y = py(d.y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
  ctx.lineTo(px(data.length - 1), H - pad.b); ctx.lineTo(px(0), H - pad.b); ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, "rgba(191,0,0,.16)"); grad.addColorStop(1, "rgba(191,0,0,0)");
  ctx.fillStyle = grad; ctx.fill();
  // 라인
  ctx.strokeStyle = "#bf0000"; ctx.lineWidth = 2.2; ctx.lineJoin = "round"; ctx.beginPath();
  data.forEach((d, i) => { const X = px(i), Y = py(d.y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
  ctx.stroke();
  // 점
  const pts = data.map((d, i) => ({ x: px(i), y: py(d.y), date: d.x, val: d.y }));
  pts.forEach((p, i) => {
    ctx.beginPath(); ctx.arc(p.x, p.y, i === hover ? 5 : 3, 0, 7);
    ctx.fillStyle = "#bf0000"; ctx.fill();
    if (i === hover) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
  });
  // x라벨
  ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center";
  const step = Math.ceil(data.length / 8);
  data.forEach((d, i) => { if (i % step === 0 || i === data.length - 1) ctx.fillText(chartGran === "month" ? d.x.slice(0, 7) : d.x.slice(5), px(i), H - 9); });
  chartGeom = { pts, pad };
  // 툴팁
  const tip = $("#chart-tip");
  if (hover >= 0 && pts[hover]) {
    const p = pts[hover];
    tip.innerHTML = `${p.date}<br><b>${METRIC_LABEL[chartMetric]} ${valLabel(p.val)}</b>`;
    tip.style.left = p.x + "px"; tip.style.top = p.y + "px"; tip.style.opacity = "1";
  } else { tip.style.opacity = "0"; }
}
(function bindChartHover() {
  const cv = $("#trend-chart"); if (!cv) return;
  cv.addEventListener("mousemove", e => {
    if (!chartGeom) return;
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left;
    let best = -1, bd = 1e9;
    chartGeom.pts.forEach((p, i) => { const d = Math.abs(p.x - mx); if (d < bd) { bd = d; best = i; } });
    drawChart(best);
  });
  cv.addEventListener("mouseleave", () => drawChart(-1));
})();
window.addEventListener("resize", () => { if (!$("#view-dashboard").classList.contains("hidden")) drawChart(); });

/* ---------------- 詳細データ(統合) ---------------- */
const COLS = [["report_date", "日付"], ["campaign_name", "キャンペーン"], ["dimension_key", "項目"],
["gms", "売上"], ["ad_cost", "広告費"], ["impressions", "IMP"], ["clicks", "クリック"], ["ctr", "CTR"], ["cv", "CV"],
["cvr", "CVR"], ["roas", "ROAS"], ["cpc", "CPC"], ["cpa", "CPA"]];
function fmtCell(k, v) {
  if (["ad_cost", "gms", "cpc", "cpa"].includes(k)) return fmtMoney(v);
  if (["clicks", "cv", "impressions"].includes(k)) return fmt(v);
  if (k === "roas") return fmtRoas(v);
  if (k === "ctr" || k === "cvr") return fmtPct(v);
  return v ?? "—";
}
let detailRows = [], rawFields = [], rawMode = false;
let dSort = "ad_cost", dDesc = true, dQ = "", dExact = null;

async function loadDetail() {
  const f = readFilters("#dash-filters");
  const sel = $("#detail-sel").value || "3";
  if (f.product === "CPA") {            // CPA는 매핑 미확정 → 원본 동적표
    rawMode = true;
    try {
      const r = await api.get(`/api/raw?from=${f.from}&to=${f.to}&product=CPA`);
      detailRows = r.rows; rawFields = r.fields; renderDetail();
    } catch (e) { toast("元データの読み込みに失敗: " + e.message, true); }
    return;
  }
  rawMode = false;
  const win = f.window || "720h", seg = f.segment || "all";
  const qs = `from=${f.from}&to=${f.to}&product=${f.product}&selection_type=${sel}&window=${win}&segment=${seg}&limit=3000`;
  try {
    const r = await api.get("/api/data?" + qs);
    detailRows = r.rows;
    detailRows.forEach(x => { x.ctr = (x.impressions && x.clicks) ? x.clicks / x.impressions : null; });
    renderDetail();
  } catch (e) { toast("データの読み込みに失敗: " + e.message, true); }
}
function detailFiltered() {
  let rows = detailRows.slice();
  if (dExact != null) rows = rows.filter(r => (r.dimension_key || "") === dExact || (r.campaign_name || "") === dExact);
  if (dQ) rows = rows.filter(r => ((r.campaign_name || "") + " " + (r.dimension_key || "")).toLowerCase().includes(dQ.toLowerCase()));
  rows.sort((a, b) => {
    let x = a[dSort], y = b[dSort];
    if (typeof x === "string" || typeof y === "string") { x = String(x || ""); y = String(y || ""); return dDesc ? y.localeCompare(x) : x.localeCompare(y); }
    x = x ?? -Infinity; y = y ?? -Infinity; return dDesc ? y - x : x - y;
  });
  return rows;
}
function renderDetail() {
  const t = $("#detail-table");
  $("#detail-chip").innerHTML = dExact != null
    ? `<span class="fchip">絞り込み: <b>${trunc(dExact, 46)}</b> <button id="chip-x" title="解除">✕</button></span>` : "";
  if (dExact != null) $("#chip-x").onclick = () => { dExact = null; renderDetail(); };
  if (rawMode) {
    if (!detailRows.length) { $("#detail-count").textContent = ""; t.innerHTML = `<tr><td>CPA の元データがありません。</td></tr>`; return; }
    $("#detail-count").textContent = `（${fmt(detailRows.length)}件）`;
    t.innerHTML = `<thead><tr>${rawFields.map(k => `<th>${k}</th>`).join("")}</tr></thead><tbody>` +
      detailRows.map(r => "<tr>" + rawFields.map(k => `<td>${r[k] ?? ""}</td>`).join("") + "</tr>").join("") + "</tbody>";
    return;
  }
  if (!detailRows.length) { $("#detail-count").textContent = ""; t.innerHTML = "<tr><td>データがありません — まず該当期間を取得してください。</td></tr>"; return; }
  const rows = detailFiltered();
  $("#detail-count").textContent = `（${fmt(rows.length)}件）`;
  const LEFT = new Set(["report_date", "campaign_name", "dimension_key"]);
  const head = COLS.map(([k, l]) => `<th data-k="${k}" class="${LEFT.has(k) ? "col-l" : ""}">${l}${dSort === k ? (dDesc ? " ▼" : " ▲") : ""}</th>`).join("");
  const body = rows.map(r => "<tr>" + COLS.map(([k]) => {
    const click = (k === "dimension_key" || k === "campaign_name") && r[k];
    const cls = (LEFT.has(k) ? "col-l " : "") + (k === "dimension_key" || k === "campaign_name" ? "dim-cell" : "") + (click ? " cell-click" : "");
    return `<td class="${cls.trim()}"${click ? ` data-fv="${String(r[k]).replace(/"/g, "&quot;")}"` : ""}>${fmtCell(k, r[k])}</td>`;
  }).join("") + "</tr>").join("");
  drawItemChart(rows);
  t.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body || "<tr><td>検索結果なし</td></tr>"}</tbody>`;
  $$("#detail-table th").forEach(th => th.onclick = () => {
    const k = th.dataset.k; if (dSort === k) dDesc = !dDesc; else { dSort = k; dDesc = true; }
    renderDetail();
  });
  $$("#detail-table td.cell-click").forEach(td => td.onclick = () => { dExact = td.dataset.fv; renderDetail(); });
}
let detailMetric = "ad_cost";
function drawItemChart(rows) {
  const box = $("#detail-chart-box"), sel = $("#detail-sel").value;
  if (rawMode || !dExact || !(sel === "3" || sel === "4")) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  $("#detail-chart-title").textContent = `「${trunc(dExact, 40)}」の推移`;
  const data = rows.slice().sort((a, b) => a.report_date < b.report_date ? -1 : 1)
    .map(r => ({ x: r.report_date, y: r[detailMetric] ?? 0 }));
  miniChart($("#detail-chart"), data, detailMetric);
}
function miniChart(cv, data, metric) {
  const ctx = cv.getContext("2d");
  const W = cv.width = cv.clientWidth, H = cv.height = cv.clientHeight || 200;
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 64, r: 16, t: 14, b: 24 };
  if (!data.length) { ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center"; ctx.font = "13px sans-serif"; ctx.fillText("データなし", W / 2, H / 2); return; }
  const ys = data.map(d => d.y), maxY = Math.max(...ys) * 1.08 || 1, minY = Math.min(...ys, 0);
  const px = i => pad.l + (W - pad.l - pad.r) * (data.length === 1 ? .5 : i / (data.length - 1));
  const py = v => pad.t + (H - pad.t - pad.b) * (1 - (v - minY) / (maxY - minY || 1));
  const money = metric === "ad_cost" || metric === "gms";
  const ax = v => money ? abbr(v) : (metric === "roas" ? Math.round(v * 100) + "%" : Math.round(v).toLocaleString());
  ctx.font = "11px sans-serif"; ctx.textAlign = "right"; ctx.strokeStyle = "#eef0f3";
  for (let i = 0; i <= 4; i++) { const v = minY + (maxY - minY) * i / 4, y = py(v); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke(); ctx.fillStyle = "#9ca3af"; ctx.fillText(ax(v), pad.l - 8, y + 4); }
  ctx.beginPath(); data.forEach((d, i) => { const X = px(i), Y = py(d.y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
  ctx.lineTo(px(data.length - 1), H - pad.b); ctx.lineTo(px(0), H - pad.b); ctx.closePath();
  const g = ctx.createLinearGradient(0, pad.t, 0, H - pad.b); g.addColorStop(0, "rgba(191,0,0,.14)"); g.addColorStop(1, "rgba(191,0,0,0)"); ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = "#bf0000"; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
  data.forEach((d, i) => { const X = px(i), Y = py(d.y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }); ctx.stroke();
  ctx.fillStyle = "#bf0000"; data.forEach((d, i) => { ctx.beginPath(); ctx.arc(px(i), py(d.y), 2.5, 0, 7); ctx.fill(); });
  ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center"; const step = Math.ceil(data.length / 8);
  data.forEach((d, i) => { if (i % step === 0 || i === data.length - 1) ctx.fillText(d.x.slice(5), px(i), H - 8); });
}
$$("#detail-metric .seg-btn").forEach(b => b.onclick = () => {
  detailMetric = b.dataset.metric;
  $$("#detail-metric .seg-btn").forEach(x => x.classList.toggle("active", x === b));
  renderDetail();
});
$("#detail-sel").onchange = () => { dExact = null; loadDetail(); };
$("#detail-search").addEventListener("input", e => { dQ = e.target.value; renderDetail(); });
$("#btn-csv").onclick = () => {
  const rows = rawMode ? detailRows : detailFiltered();
  if (!rows.length) return toast("出力するデータがありません", true);
  const cols = rawMode ? rawFields.map(k => [k, k]) : COLS;
  const header = cols.map(([, l]) => l).join(",");
  const lines = rows.map(r => cols.map(([k]) => `"${String(r[k] ?? "").replace(/"/g, '""')}"`).join(","));
  const blob = new Blob(["﻿" + header + "\n" + lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `rms_ads_${today()}.csv`; a.click();
};
// ドリルダウン: TOP/キャンペーン クリック → 表示単位変更 + 完全一致フィルタ + スクロール
function drillToDetail(selection_type, value) {
  $("#detail-sel").value = String(selection_type);
  dExact = value || null; dQ = ""; $("#detail-search").value = "";
  dSort = "ad_cost"; dDesc = true;
  loadDetail();
  setTimeout(() => $("#detail-card").scrollIntoView({ behavior: "smooth", block: "start" }), 90);
}

/* ================= 商品分析 (リーダーボード + 複数比較) ================= */
const PALETTE = ["#bf0000", "#1e66d0", "#0ea36b", "#d98e00", "#7b3fe4"];
let prodAll = [], prodBoard = [], prodSel = [], prodMetric = "ad_cost";
let pbSort = "ad_cost", pbDesc = true, pbQ = "";
const dimOf = r => r.dimension_key || r.campaign_name || "";
function aggOf(rows) {
  const s = k => rows.reduce((a, b) => a + (b[k] || 0), 0);
  const clicks = s("clicks"), impr = s("impressions"), cost = s("ad_cost"), gms = s("gms"), cv = s("cv");
  return { clicks, impressions: impr, ad_cost: cost, gms, cv, roas: cost ? gms / cost : null,
    cpc: clicks ? cost / clicks : null, cpa: cv ? cost / cv : null, ctr: impr ? clicks / impr : null, cvr: clicks ? cv / clicks : null };
}
function loadProductView() {
  if (!$("#prod-filters").innerHTML) buildFilters("#prod-filters", { segment: true, onApply: loadProdBoard });
  loadProdBoard();
}
function _skelTable(rows = 8, cols = 8) {
  const head = `<thead><tr>${Array(cols).fill(0).map(() => `<th><span class="skel skel-line" style="width:70%;height:11px"></span></th>`).join("")}</tr></thead>`;
  const body = `<tbody>${Array(rows).fill(0).map(() => `<tr>${Array(cols).fill(0).map((_, i) => `<td><span class="skel skel-line" style="width:${i === 0 ? 80 : 60}%;height:12px"></span></td>`).join("")}</tr>`).join("")}</tbody>`;
  return head + body;
}
async function loadProdBoard() {
  const f = readFilters("#prod-filters"), win = f.window || "720h", seg = f.segment || "all", kind = $("#prod-kind").value;
  // 로딩 스켈레톤
  if ($("#prod-board")) $("#prod-board").innerHTML = _skelTable(8, 8);
  if ($("#prod-cap")) $("#prod-cap").innerHTML = `<span class="skel skel-line" style="width:280px"></span>`;
  try {
    const r = await api.get(`/api/data?from=${f.from}&to=${f.to}&product=${f.product}&selection_type=${kind}&window=${win}&segment=${seg}&limit=6000`);
    prodAll = r.rows;
    const m = {}; prodAll.forEach(r => { const d = dimOf(r); (m[d] = m[d] || []).push(r); });
    prodBoard = Object.entries(m).map(([dim, rows]) => ({ dim, ...aggOf(rows) }));
    // 商品(sel=3)인 경우: 純粋商品CPC도 함께 가져와서 매핑
    if (kind === "3") {
      try {
        const mx = await api.get(`/api/item_keywords?from=${f.from}&to=${f.to}&window=${win}&segment=${seg}`);
        const pureBy = {};
        // 매트릭스 응답은 item_url 키지만 prodBoard.dim은 商品管理番号 → 두 키 모두 등록
        (mx.items || []).forEach(it => {
          if (it.pure) {
            if (it.item_url) pureBy[it.item_url] = it.pure;
            if (it.item_label) pureBy[it.item_label] = it.pure;
          }
        });
        prodBoard.forEach(p => { if (pureBy[p.dim]) p.pure = pureBy[p.dim]; });
      } catch (_) { /* pure는 옵션이라 실패해도 보드는 표시 */ }
    }
    prodSel = []; renderBoard(); renderProdSel();
  } catch (e) { toast("一覧の取得に失敗: " + e.message, true); }
}
let pbPure = false;
$("#prod-kind").onchange = () => {
  // キーワード일 땐 純粋商品CPC 토글 숨김
  $("#prod-pure-toggle").style.display = $("#prod-kind").value === "3" ? "" : "none";
  loadProdBoard();
};
$("#prod-clear").onclick = () => { prodSel = []; renderBoard(); renderProdSel(); };
$("#prod-search").addEventListener("input", e => { pbQ = e.target.value; renderBoard(); });
$("#prod-pure").addEventListener("change", e => { pbPure = e.target.checked; renderBoard(); });
const BOARD_COLS = [["dim", "項目"], ["gms", "売上"], ["ad_cost", "広告費"], ["impressions", "IMP"], ["clicks", "クリック"], ["ctr", "CTR"], ["cv", "CV"], ["roas", "ROAS"]];
// 外部漏出 = 商品別広告のうちキーワード経由ではない部分（直接ページ閲覧・推薦・関連等）
const BOARD_PURE_COLS = [
  ["pure_gms", "外部漏出<br>売上"],
  ["pure_ad_cost", "外部漏出<br>広告費"],
  ["pure_impressions", "外部漏出<br>IMP"],
  ["pure_clicks", "外部漏出<br>クリック"],
  ["pure_cv", "外部漏出<br>CV"],
  ["pure_share", "外部漏出<br>比率"],
];
function renderBoard() {
  const t = $("#prod-board");
  // 캡션: 전건 안내(잘리지 않음을 명시)
  const cap = $("#prod-cap");
  if (cap) {
    const kindL = $("#prod-kind").value === "3" ? "商品" : "キーワード";
    cap.innerHTML = `この期間に広告掲載があった${kindL} <b>${prodBoard.length}件</b>を表示中（全件）`;
  }
  if (!prodBoard.length) { t.innerHTML = "<tr><td>データがありません — 期間・種別をご確認ください。</td></tr>"; return; }
  let rows = pbQ ? prodBoard.filter(r => r.dim.toLowerCase().includes(pbQ.toLowerCase())) : prodBoard.slice();
  // pure_*키로 정렬 시 r.pure에서 꺼내쓰기
  const valOf = (r, k) => k.startsWith("pure_") ? (r.pure ? r.pure[k.slice(5)] : null) : r[k];
  rows.sort((a, b) => { const x = valOf(a, pbSort) ?? -Infinity, y = valOf(b, pbSort) ?? -Infinity; return (typeof x === "string") ? (pbDesc ? String(y).localeCompare(x) : String(x).localeCompare(y)) : (pbDesc ? y - x : x - y); });
  rows = rows.slice(0, 100);
  const showPure = pbPure && $("#prod-kind").value === "3";
  const cols = showPure ? BOARD_COLS.concat(BOARD_PURE_COLS) : BOARD_COLS;
  const head = cols.map(([k, l]) => `<th data-k="${k}" class="${k === "dim" ? "col-l" : ""}${k.startsWith("pure_") ? " th-pure" : ""}">${l}${pbSort === k ? (pbDesc ? " ▼" : " ▲") : ""}</th>`).join("");
  const body = rows.map(r => {
    const on = prodSel.includes(r.dim);
    const p = r.pure || {};
    return `<tr class="row-click${on ? " row-sel" : ""}" data-dim="${r.dim.replace(/"/g, "&quot;")}">` +
      `<td class="col-l dim-cell" title="${r.dim.replace(/"/g, "")}">${on ? "✓ " : ""}${trunc(r.dim, 44)}</td>` +
      `<td>${fmtMoney(r.gms)}</td><td>${fmtMoney(r.ad_cost)}</td><td>${fmt(r.impressions)}</td><td>${fmt(r.clicks)}</td><td>${fmtPct(r.ctr)}</td><td>${fmt(r.cv)}</td><td>${fmtRoas(r.roas)}</td>` +
      (showPure ? `<td class="td-pure">${fmtMoney(p.gms)}</td><td class="td-pure">${fmtMoney(p.ad_cost)}</td><td class="td-pure">${fmt(p.impressions)}</td><td class="td-pure">${fmt(p.clicks)}</td><td class="td-pure">${fmt(p.cv)}</td><td class="td-pure" title="商品別広告のうち、キーワード経由ではない割合（推薦・関連商品・カテゴリ等での発生）">${p.share != null ? `<div class="match-bar"><div class="match-fill" style="width:${Math.round(p.share * 100)}%"></div><span class="match-pct">${Math.round(p.share * 100)}%</span></div>` : "—"}</td>` : "") +
      `</tr>`;
  }).join("");
  t.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body || "<tr><td>検索結果なし</td></tr>"}</tbody>`;
  $$("#prod-board th").forEach(th => th.onclick = () => { const k = th.dataset.k; if (pbSort === k) pbDesc = !pbDesc; else { pbSort = k; pbDesc = true; } renderBoard(); });
  $$("#prod-board tbody tr").forEach(tr => tr.onclick = () => toggleProd(tr.dataset.dim));
}
function toggleProd(dim) {
  const i = prodSel.indexOf(dim);
  if (i >= 0) prodSel.splice(i, 1);
  else { if (prodSel.length >= 5) return toast("比較は最大5件までです", true); prodSel.push(dim); }
  renderBoard(); renderProdSel();
}
function renderProdSel() {
  if (!prodSel.length) { $("#prod-result").classList.add("hidden"); return; }
  $("#prod-result").classList.remove("hidden");
  const single = prodSel.length === 1;
  $("#prod-kpi").style.display = single ? "" : "none";
  $("#prod-cmp-card").classList.toggle("hidden", single);
  if (single) {
    $("#prod-kpi").innerHTML = kpiCardsHTML(aggOf(prodAll.filter(r => dimOf(r) === prodSel[0])), null);
    $("#prod-title").textContent = `「${trunc(prodSel[0], 46)}」の推移`;
  } else { $("#prod-title").textContent = `選択 ${prodSel.length} 件の推移`; renderProdCmpTable(); }
  drawProdChart();
  renderProdDetail();
}
let prodDetailGran = "day";
$$("#prod-detail-gran .seg-btn").forEach(b => b.onclick = () => {
  prodDetailGran = b.dataset.gran;
  $$("#prod-detail-gran .seg-btn").forEach(x => x.classList.toggle("active", x === b));
  renderProdDetail();
});
function renderProdDetail() {
  if (!prodSel.length) return;
  $("#prod-detail-card").classList.remove("hidden");
  // 선택된 항목 행 추출
  const sel = new Set(prodSel);
  const rows = prodAll.filter(r => sel.has(dimOf(r)));
  rows.forEach(r => { r.ctr = (r.impressions && r.clicks) ? r.clicks / r.impressions : null; });
  // 단일 선택: 일별/월별
  // 다중 선택: 항목 × 날짜/월 분리 표시 (구분용으로 dim 컬럼 추가)
  const COLS = [["report_date", prodDetailGran === "month" ? "月" : "日付"]];
  if (prodSel.length > 1) COLS.push(["__dim", "項目"]);
  COLS.push(["gms", "売上"], ["ad_cost", "広告費"], ["impressions", "IMP"], ["clicks", "クリック"], ["ctr", "CTR"],
            ["cv", "CV"], ["cvr", "CVR"], ["roas", "ROAS"], ["cpc", "CPC"], ["cpa", "CPA"]);
  let displayRows;
  if (prodDetailGran === "month") {
    // 항목별로 월 집계
    const m = {};
    rows.forEach(r => {
      const dim = dimOf(r), ym = (r.report_date || "").slice(0, 7);
      const k = dim + "|" + ym;
      m[k] = m[k] || { __dim: dim, report_date: ym, ad_cost: 0, gms: 0, clicks: 0, cv: 0, impressions: 0 };
      m[k].ad_cost += r.ad_cost || 0; m[k].gms += r.gms || 0;
      m[k].clicks += r.clicks || 0; m[k].cv += r.cv || 0;
      m[k].impressions += r.impressions || 0;
    });
    displayRows = Object.values(m).map(r => ({
      ...r,
      roas: r.ad_cost ? r.gms / r.ad_cost : null,
      cpc: r.clicks ? r.ad_cost / r.clicks : null,
      cpa: r.cv ? r.ad_cost / r.cv : null,
      ctr: r.impressions ? r.clicks / r.impressions : null,
      cvr: r.clicks ? r.cv / r.clicks : null,
    }));
  } else {
    displayRows = rows.map(r => ({ ...r, __dim: dimOf(r) }));
  }
  displayRows.sort((a, b) => a.report_date < b.report_date ? -1 : 1);
  $("#prod-detail-count").textContent = `（${fmt(displayRows.length)}件）`;
  const head = COLS.map(([k, l]) => `<th class="${k === "report_date" || k === "__dim" ? "col-l" : ""}">${l}</th>`).join("");
  const body = displayRows.map(r => "<tr>" + COLS.map(([k]) => {
    if (k === "report_date") return `<td class="col-l">${r.report_date}</td>`;
    if (k === "__dim") return `<td class="col-l dim-cell" title="${(r.__dim || "").replace(/"/g, "")}">${trunc(r.__dim, 36)}</td>`;
    return `<td>${fmtCell(k, r[k])}</td>`;
  }).join("") + "</tr>").join("");
  $("#prod-detail-table").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body || "<tr><td>データなし</td></tr>"}</tbody>`;
}
function renderProdCmpTable() {
  const cols = [["売上", "gms", fmtMoney], ["広告費", "ad_cost", fmtMoney], ["IMP", "impressions", fmt], ["クリック", "clicks", fmt], ["CTR", "ctr", fmtPct], ["CV", "cv", fmt], ["CVR", "cvr", fmtPct], ["ROAS", "roas", fmtRoas], ["CPC", "cpc", fmtMoney]];
  const aggs = prodSel.map(d => ({ d, a: aggOf(prodAll.filter(r => dimOf(r) === d)) }));
  const head = `<th class="col-l">項目</th>` + cols.map(([l]) => `<th>${l}</th>`).join("");
  const body = aggs.map((x, i) => `<tr><td class="col-l"><b style="color:${PALETTE[i % 5]}">━</b> ${trunc(x.d, 40)}</td>` + cols.map(([, k, fn]) => `<td>${fn(x.a[k])}</td>`).join("") + "</tr>").join("");
  $("#prod-cmp-table").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
}
function drawProdChart() {
  const series = prodSel.map((d, i) => ({ label: d, color: PALETTE[i % 5],
    data: prodAll.filter(r => dimOf(r) === d).slice().sort((a, b) => a.report_date < b.report_date ? -1 : 1).map(r => ({ x: r.report_date, y: r[prodMetric] ?? 0 })) }));
  multiSeriesChart($("#prod-chart"), series, prodMetric);
  $("#prod-legend").innerHTML = series.map(s => `<span style="margin-right:14px"><b style="color:${s.color}">━</b> ${trunc(s.label, 30)}</span>`).join("");
}
$$("#prod-metric .seg-btn").forEach(b => b.onclick = () => { prodMetric = b.dataset.metric; $$("#prod-metric .seg-btn").forEach(x => x.classList.toggle("active", x === b)); if (prodSel.length) drawProdChart(); });
function multiSeriesChart(cv, series, metric) {
  const ctx = cv.getContext("2d");
  const W = cv.width = cv.clientWidth, H = cv.height = cv.clientHeight || 240;
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 64, r: 16, t: 16, b: 26 };
  const dates = [...new Set(series.flatMap(s => s.data.map(d => d.x)))].sort();
  if (!dates.length) { ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center"; ctx.fillText("データなし", W / 2, H / 2); return; }
  const all = series.flatMap(s => s.data.map(d => d.y));
  const maxY = Math.max(...all) * 1.08 || 1, minY = Math.min(...all, 0);
  const px = i => pad.l + (W - pad.l - pad.r) * (dates.length === 1 ? .5 : i / (dates.length - 1));
  const py = v => pad.t + (H - pad.t - pad.b) * (1 - (v - minY) / (maxY - minY || 1));
  const money = metric === "ad_cost" || metric === "gms";
  const ax = v => money ? abbr(v) : (metric === "roas" ? Math.round(v * 100) + "%" : Math.round(v).toLocaleString());
  ctx.font = "11px sans-serif"; ctx.textAlign = "right"; ctx.strokeStyle = "#eef0f3";
  for (let i = 0; i <= 4; i++) { const v = minY + (maxY - minY) * i / 4, y = py(v); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke(); ctx.fillStyle = "#9ca3af"; ctx.fillText(ax(v), pad.l - 8, y + 4); }
  series.forEach(s => {
    const map = {}; s.data.forEach(d => map[d.x] = d.y);
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
    dates.forEach((dt, i) => { const Y = py(map[dt] ?? 0), X = px(i); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }); ctx.stroke();
    ctx.fillStyle = s.color; dates.forEach((dt, i) => { if (map[dt] != null) { ctx.beginPath(); ctx.arc(px(i), py(map[dt]), 2.2, 0, 7); ctx.fill(); } });
  });
  ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center"; const step = Math.ceil(dates.length / 8);
  dates.forEach((dt, i) => { if (i % step === 0 || i === dates.length - 1) ctx.fillText(dt.slice(5), px(i), H - 8); });
}

/* ================= 商品×キーワード マトリクス ================= */
let mxData = [], mxQ = "", mxOpen = new Set();
function loadMatrixView() {
  if (!$("#mx-filters").innerHTML) buildFilters("#mx-filters", { segment: true, onApply: loadMatrix });
  loadMatrix();
}
async function loadMatrix() {
  const f = readFilters("#mx-filters"), win = f.window || "720h", seg = f.segment || "all";
  // 로딩 스켈레톤 — 매트릭스 카드 5개
  $("#mx-cap").innerHTML = `<span class="skel skel-line skel-inline" style="width:340px;height:14px"></span>`;
  $("#mx-list").innerHTML = Array(5).fill(0).map(() =>
    `<div class="mx-skel-card">
      <div class="mx-skel-row">
        <span class="skel skel-circle" style="width:28px;height:28px"></span>
        <span class="skel skel-line" style="width:180px;height:16px"></span>
        <span class="skel skel-line" style="width:60px;height:18px;border-radius:999px;margin-left:auto"></span>
        <span class="skel skel-line" style="width:80px;height:18px;border-radius:999px"></span>
        <span class="skel skel-line" style="width:100px;height:14px"></span>
        <span class="skel skel-line" style="width:100px;height:14px"></span>
        <span class="skel skel-line" style="width:80px;height:14px"></span>
        <span class="skel skel-line" style="width:120px;height:18px;border-radius:999px"></span>
      </div>
    </div>`).join("");
  try {
    const r = await api.get(`/api/item_keywords?from=${f.from}&to=${f.to}&window=${win}&segment=${seg}`);
    mxData = r.items || [];
    const s = r.summary || {};
    $("#mx-cap").innerHTML = `<b>${s.items_total || 0}件</b>の商品 ` +
      `<span class="muted">（商品広告のみ ${s.items_only_item_ad || 0} ・ キーワード広告あり ${s.items_with_keyword || 0} ・ 商品ページ不明 ${s.keyword_only_unmapped || 0}）</span>` +
      `<br><span class="muted small">📦 商品ページに直接出る「商品広告」と、🔍 検索結果に出る「キーワード広告」を、商品ごとにまとめて表示します。</span>`;
    renderMatrix();
  } catch (e) { toast("マトリクス取得に失敗: " + e.message, true); }
}
$("#mx-search").addEventListener("input", e => { mxQ = e.target.value; renderMatrix(); });
function renderMatrix() {
  const list = $("#mx-list");
  let items = mxData.slice();
  if (mxQ) {
    const q = mxQ.toLowerCase();
    items = items.filter(it => (it.item_url || "").toLowerCase().includes(q) ||
      it.keywords.some(k => (k.keyword || "").toLowerCase().includes(q)));
  }
  if (!items.length) { list.innerHTML = `<div class="muted small">${mxQ ? "検索結果なし" : "データがありません"}</div>`; return; }
  const total = items.reduce((a, b) => a + (b.total_cost || 0), 0) || 1;
  list.innerHTML = items.map((it, i) => {
    const open = mxOpen.has(it.item_url);
    const sharePct = Math.round((it.total_cost || 0) / total * 100);
    const itemLabel = it.item_url === "(未紐付け)" ? "(未紐付けキーワード)" : trunc(it.item_label || it.item_url, 80);
    return `<div class="mx-item ${open ? "open" : ""}" data-key="${escapeHtml(it.item_url)}">
      <div class="mx-head">
        <div class="mx-rank">${i + 1}</div>
        <div class="mx-name" title="${escapeHtml(it.item_url)}">${escapeHtml(itemLabel)}</div>
        <div class="mx-stat">
          <span class="mx-type">${it.has_item_ad ? `<span class="mx-tag tag-item">商品</span>` : ""}${it.keyword_count > 0 ? `<span class="mx-tag tag-kw">KW×${it.keyword_count}</span>` : ""}${it.pure && it.pure.share != null ? `<span class="mx-tag tag-pure" title="外部漏出比率（商品別広告 − キーワード合算）">📡 ${Math.round(it.pure.share * 100)}%</span>` : ""}</span>
          <span>売上 <b>${fmtMoney(it.total_gms)}</b></span><span>広告費 <b>${fmtMoney(it.total_cost)}</b></span><span>ROAS <b>${fmtRoas(it.roas)}</b></span>
        </div>
        <div class="mx-share"><div class="share-bar"><div class="share-fill" style="width:${sharePct}%"></div><span class="share-pct">${sharePct}%</span></div></div>
        <div class="mx-toggle">${open ? "▼" : "▶"}</div>
      </div>
      ${open ? (() => {
        // 키워드 합계 (분자/분모 따로 합산 후 비율 재계산)
        const kwSum = it.keywords.reduce((a, k) => ({
          clicks: a.clicks + (k.clicks || 0),
          impressions: a.impressions + (k.impressions || 0),
          ad_cost: a.ad_cost + (k.ad_cost || 0),
          gms: a.gms + (k.gms || 0),
          cv: a.cv + (k.cv || 0),
        }), { clicks: 0, impressions: 0, ad_cost: 0, gms: 0, cv: 0 });
        const kwCtr = kwSum.impressions ? kwSum.clicks / kwSum.impressions : null;
        const kwRoas = kwSum.ad_cost ? kwSum.gms / kwSum.ad_cost : null;
        return `<div class="mx-body">
        ${it.pure ? `<div class="pure-card">
          <div class="pure-h"><span class="mx-tag tag-pure">📡 外部漏出（純粋商品CPC）</span><span class="muted small">商品別広告 − キーワード合算（キーワード以外で発生したトラフィック）</span></div>
          <div class="pure-stats">
            <div><span class="pl">売上</span><b>${fmtMoney(it.pure.gms)}</b></div>
            <div><span class="pl">広告費</span><b>${fmtMoney(it.pure.ad_cost)}</b><span class="muted small">${it.pure.share != null ? `(商品別の${Math.round(it.pure.share * 100)}%)` : ""}</span></div>
            <div><span class="pl">IMP</span><b>${fmt(it.pure.impressions)}</b></div>
            <div><span class="pl">クリック</span><b>${fmt(it.pure.clicks)}</b></div>
            <div><span class="pl">CTR</span><b>${fmtPct(it.pure.ctr)}</b></div>
            <div><span class="pl">CV</span><b>${fmt(it.pure.cv)}</b></div>
            <div><span class="pl">ROAS</span><b class="pure-roas">${fmtRoas(it.pure.roas)}</b></div>
          </div>
        </div>` : ""}
        <table class="mx-tbl"><thead><tr><th class="col-l">広告タイプ／キーワード</th><th>売上</th><th>広告費</th><th>IMP</th><th>クリック</th><th>CTR</th><th>CV</th><th>ROAS</th></tr></thead><tbody>` +
        (it.item_ad ? (() => {
          const ia = it.item_ad;
          const iaCtr = ia.ctr ?? (ia.impressions ? ia.clicks / ia.impressions : null);
          return `<tr class="mx-itemad"><td class="col-l"><span class="mx-tag tag-item">📦 商品別広告（全体）</span></td><td>${fmtMoney(ia.gms)}</td><td>${fmtMoney(ia.ad_cost)}</td><td>${fmt(ia.impressions)}</td><td>${fmt(ia.clicks)}</td><td>${fmtPct(iaCtr)}</td><td>${fmt(ia.cv)}</td><td><b>${fmtRoas(ia.roas)}</b></td></tr>`;
        })() : "") +
        (it.keywords.length ? `<tr class="mx-kwsum"><td class="col-l"><span class="mx-tag tag-kw">📊 キーワード合計</span></td><td>${fmtMoney(kwSum.gms)}</td><td>${fmtMoney(kwSum.ad_cost)}</td><td>${fmt(kwSum.impressions)}</td><td>${fmt(kwSum.clicks)}</td><td>${fmtPct(kwCtr)}</td><td>${fmt(kwSum.cv)}</td><td><b>${fmtRoas(kwRoas)}</b></td></tr>` : "") +
        (it.keywords.length ? it.keywords.sort((a, b) => (b.gms || 0) - (a.gms || 0)).map(k => `<tr><td class="col-l"><span class="mx-tag tag-kw">🔍 KW</span> ${escapeHtml(k.keyword)}</td><td>${fmtMoney(k.gms)}</td><td>${fmtMoney(k.ad_cost)}</td><td>${fmt(k.impressions)}</td><td>${fmt(k.clicks)}</td><td>${fmtPct(k.ctr)}</td><td>${fmt(k.cv)}</td><td><b>${fmtRoas(k.roas)}</b></td></tr>`).join("") : "") +
        `</tbody></table></div>`;
      })() : ""}
    </div>`;
  }).join("");
  $$("#mx-list .mx-head").forEach(h => h.onclick = () => {
    const key = h.parentElement.dataset.key;
    if (mxOpen.has(key)) mxOpen.delete(key); else mxOpen.add(key);
    renderMatrix();
  });
}

/* ================= 期間比較 ================= */
let cmpA = null, cmpB = null, cmpMetric = "ad_cost";
function loadCompareView() {
  if (!$("#cmp-filters").dataset.built) { buildCompareFilters(); $("#cmp-filters").dataset.built = "1"; }
}
let cmpTargets = [], cmpTarget = null, cmpQ = "";
function buildCompareFilters() {
  const max = (STATUS.bounds && STATUS.bounds.max) || STATUS.yesterday || today();
  const a1 = addDays(max, -13), a2 = addDays(max, -7), b1 = addDays(max, -6), b2 = max;
  // 칩 기반 가로 레이아웃
  $("#cmp-filters").innerHTML = `
    <div class="filter-main">
      <div class="filter-block">
        <span class="filter-lab">広告種別</span>
        <div class="pill-group">
          <button type="button" class="pill-chip" data-k="product" data-v="RPP">RPP</button>
          <button type="button" class="pill-chip" data-k="product" data-v="TDA">TDA</button>
          <button type="button" class="pill-chip" data-k="product" data-v="ALL">全広告</button>
        </div>
      </div>
      <div class="filter-block">
        <span class="filter-lab">比較対象</span>
        <div class="pill-group">
          <button type="button" class="pill-chip" data-k="scope" data-v="1">全体</button>
          <button type="button" class="pill-chip" data-k="scope" data-v="3">商品</button>
          <button type="button" class="pill-chip" data-k="scope" data-v="4">キーワード</button>
          <button type="button" class="pill-chip" data-k="scope" data-v="3+4">商品×KW</button>
        </div>
      </div>
      <div class="filter-block filter-period">
        <span class="filter-lab">期間A</span>
        <div class="period-row">
          <input type="text" data-k="aFrom" data-dp="day" value="${a1}" class="dp-mini">
          <span class="period-sep">〜</span>
          <input type="text" data-k="aTo" data-dp="day" value="${a2}" class="dp-mini">
        </div>
      </div>
      <div class="filter-block filter-period">
        <span class="filter-lab">期間B</span>
        <div class="period-row">
          <input type="text" data-k="bFrom" data-dp="day" value="${b1}" class="dp-mini">
          <span class="period-sep">〜</span>
          <input type="text" data-k="bTo" data-dp="day" value="${b2}" class="dp-mini">
        </div>
      </div>
      <button class="primary" id="cmp-go">比較</button>
      <button class="ghost-btn small adv-btn" data-act="toggle-adv">⚙️ 詳細</button>
    </div>
    <div class="filter-adv hidden">
      <div class="filter-block">
        <span class="filter-lab">CV計測</span>
        <div class="pill-group">
          <button type="button" class="pill-chip" data-k="window" data-v="720h">720h (30日)</button>
          <button type="button" class="pill-chip" data-k="window" data-v="12h">12h</button>
        </div>
      </div>
      <div class="filter-block">
        <span class="filter-lab">集計対象</span>
        <div class="pill-group">
          <button type="button" class="pill-chip" data-k="segment" data-v="all">全体</button>
          <button type="button" class="pill-chip" data-k="segment" data-v="new">新規顧客</button>
          <button type="button" class="pill-chip" data-k="segment" data-v="existing">既存顧客</button>
        </div>
      </div>
    </div>
    <div style="display:none">
      <select data-k="product"><option>RPP</option><option>TDA</option><option value="ALL">ALL</option></select>
      <select data-k="scope"><option value="1">1</option><option value="3">3</option><option value="4">4</option><option value="3+4">3+4</option></select>
      <select data-k="window"><option value="720h">720h</option><option value="12h">12h</option></select>
      <select data-k="segment"><option value="all">all</option><option value="new">new</option><option value="existing">existing</option></select>
    </div>`;
  function setPill(k, v) {
    $$(`#cmp-filters .pill-chip[data-k="${k}"]`).forEach(c => c.classList.toggle("on", c.dataset.v === v));
    const sel = $(`#cmp-filters select[data-k="${k}"]`); if (sel) sel.value = v;
  }
  setPill("product", "RPP"); setPill("scope", "1");
  setPill("window", "720h"); setPill("segment", "all");
  $$("#cmp-filters .pill-chip[data-k]").forEach(c => c.onclick = () => {
    setPill(c.dataset.k, c.dataset.v);
    if (c.dataset.k === "scope") onScopeChange();
  });
  // 詳細 토글
  const advBtn = $("#cmp-filters .adv-btn"), advPanel = $("#cmp-filters .filter-adv");
  advBtn.onclick = () => {
    advPanel.classList.toggle("hidden");
    advBtn.textContent = advPanel.classList.contains("hidden") ? "⚙️ 詳細" : "⚙️ 閉じる";
  };
  $$("#cmp-filters [data-dp]").forEach(el => attachPicker(el, "day"));
  $("#cmp-go").onclick = onCompareGo;
  $("#cmp-search").addEventListener("input", e => { cmpQ = e.target.value; renderCmpPicker(); });
  onScopeChange();
}
let cmpItemForKW = null;  // 商品×キーワード 모드에서 먼저 선택한 상품
function onScopeChange() {
  // 칩 활성 상태에서 직접 읽음 (select 동기화 지연 회피)
  const activePill = $("#cmp-filters .pill-chip[data-k=scope].on");
  const scope = activePill ? activePill.dataset.v : ($("#cmp-filters [data-k=scope]").value || "1");
  cmpTarget = null; cmpItemForKW = null; $("#cmp-target-label").textContent = "";
  if (scope === "1") {
    $("#cmp-picker-card").classList.add("hidden");
    $("#cmp-result-card").classList.remove("hidden");
    runCompare();
  } else {
    $("#cmp-picker-card").classList.remove("hidden");
    $("#cmp-result-card").classList.add("hidden");
    const labelMap = { "3": "商品 (SKU)", "4": "キーワード", "3+4": "STEP1: 商品 (SKU)" };
    const label = labelMap[scope] || "対象";
    $("#cmp-picker-title").innerHTML = `${label}を選択 <span class="muted small">行をクリックで選択（1件）</span>`;
    loadCmpTargets();
  }
}
async function loadCmpTargets() {
  const f = readFilters("#cmp-filters"); let scope = f.scope; const win = f.window || "720h", seg = f.segment || "all";
  // 商品×キーワード STEP1 = 상품 / STEP2 = 그 상품의 키워드
  if (scope === "3+4") scope = cmpItemForKW ? "4" : "3";
  try {
    const q = (fr, to) => `from=${fr}&to=${to}&product=${f.product}&selection_type=${scope}&window=${win}&segment=${seg}&limit=4000`;
    const [da, db] = await Promise.all([api.get("/api/data?" + q(f.aFrom, f.aTo)), api.get("/api/data?" + q(f.bFrom, f.bTo))]);
    const m = {};
    // 商品×キーワード STEP2: 선택한 상품에 매칭된 키워드만 필터.
    // STEP1 (scope=3) 의 키는 item_url (URL 전체) — 그래야 STEP2 의 키워드 row.item_url 와 매칭됨.
    // (sel=3 CSV 의 dimension_key 는 item_no 이므로 그걸 그대로 키로 쓰면 매칭 X)
    const filterFn = (f.scope === "3+4" && cmpItemForKW && scope === "4")
      ? r => r.item_url === cmpItemForKW
      : null;
    const isProductScope = (scope === "3");
    const add = (rows, side) => rows.forEach(r => {
      if (filterFn && !filterFn(r)) return;
      // 상품 scope 에서는 매칭 키를 item_url 로 일관화. 라벨은 dimension_key (= item_no) 유지.
      const k = isProductScope
        ? (r.item_url || r.dimension_key || "")
        : (r.dimension_key || r.campaign_name || "");
      if (!k) return;
      const label = isProductScope ? (r.dimension_key || r.item_url || "") : k;
      m[k] = m[k] || { dim: k, label, a: { ad_cost: 0, gms: 0, clicks: 0, cv: 0 }, b: { ad_cost: 0, gms: 0, clicks: 0, cv: 0 } };
      ["ad_cost", "gms", "clicks", "cv"].forEach(c => m[k][side][c] += r[c] || 0);
    });
    add(da.rows, "a"); add(db.rows, "b");
    cmpTargets = Object.values(m).map(r => ({
      dim: r.dim,
      label: r.label || r.dim,
      a_cost: r.a.ad_cost, b_cost: r.b.ad_cost, total_cost: r.a.ad_cost + r.b.ad_cost,
      a_gms: r.a.gms, b_gms: r.b.gms,
      a_roas: r.a.ad_cost ? r.a.gms / r.a.ad_cost : null, b_roas: r.b.ad_cost ? r.b.gms / r.b.ad_cost : null,
    }));
    // 商品 비교일 때 두 기간의 pure도 함께 매핑
    if (scope === "3") {
      try {
        const [ma, mb] = await Promise.all([
          api.get(`/api/item_keywords?from=${f.aFrom}&to=${f.aTo}&window=${win}&segment=${seg}`),
          api.get(`/api/item_keywords?from=${f.bFrom}&to=${f.bTo}&window=${win}&segment=${seg}`),
        ]);
        const pa = {}, pb = {};
        (ma.items || []).forEach(it => { if (it.pure) pa[it.item_url] = it.pure; });
        (mb.items || []).forEach(it => { if (it.pure) pb[it.item_url] = it.pure; });
        cmpTargets.forEach(t => { if (pa[t.dim]) t.a_pure = pa[t.dim]; if (pb[t.dim]) t.b_pure = pb[t.dim]; });
      } catch (_) {}
    }
    renderCmpPicker();
  } catch (e) { toast("対象リスト取得に失敗: " + e.message, true); }
}
function renderCmpPicker() {
  const t = $("#cmp-picker");
  let rows = cmpTargets.slice();
  if (cmpQ) rows = rows.filter(r => r.dim.toLowerCase().includes(cmpQ.toLowerCase()));
  rows.sort((a, b) => b.total_cost - a.total_cost);
  const total = rows.length; rows = rows.slice(0, 200);
  const cap = $("#cmp-cap");
  const scope = $("#cmp-filters .pill-chip[data-k=scope].on")?.dataset.v || "1";
  const kindL = scope === "3" ? "商品(SKU)" : (scope === "3+4" ? "商品×キーワード" : "キーワード");
  if (cap) cap.innerHTML = total ? `2期間で広告掲載があった${kindL} <b>${total}件</b>${total > 200 ? "（上位200件を表示）" : "（全件）"}` : "";
  if (!rows.length) { t.innerHTML = `<tr><td>${cmpQ ? "検索結果なし" : "対象データがありません"}</td></tr>`; return; }
  t.innerHTML = `<thead><tr><th class="col-l">項目</th><th>売上A</th><th>売上B</th><th>広告費A</th><th>広告費B</th><th>ROAS A</th><th>ROAS B</th></tr></thead><tbody>` +
    rows.map(r => {
      const labelText = r.label || r.dim;
      return `<tr class="row-click${cmpTarget === r.dim ? " row-sel" : ""}" data-dim="${r.dim.replace(/"/g, "&quot;")}" data-label="${labelText.replace(/"/g, "&quot;")}">` +
      `<td class="col-l dim-cell" title="${labelText.replace(/"/g, "")}">${cmpTarget === r.dim ? "✓ " : ""}${trunc(labelText, 46)}</td>` +
      `<td>${fmtMoney(r.a_gms)}</td><td>${fmtMoney(r.b_gms)}</td>` +
      `<td>${fmtMoney(r.a_cost)}</td><td>${fmtMoney(r.b_cost)}</td>` +
      `<td>${fmtRoas(r.a_roas)}</td><td>${fmtRoas(r.b_roas)}</td></tr>`;
    }).join("") + "</tbody>";
  $$("#cmp-picker tbody tr").forEach(tr => tr.onclick = () => {
    const f = readFilters("#cmp-filters");
    if (f.scope === "3+4" && !cmpItemForKW) {
      // STEP1 완료 → STEP2 진입. dataset.dim 은 매칭 키 (item_url), dataset.label 은 표시용 (item_no).
      cmpItemForKW = tr.dataset.dim;
      const labelText = tr.dataset.label || cmpItemForKW;
      $("#cmp-picker-title").innerHTML = `STEP2: 「${trunc(labelText, 40)}」のキーワードを選択 <button class="ghost-btn small" id="cmp-back-step1" style="margin-left:10px">← 商品選択へ戻る</button>`;
      $("#cmp-back-step1")?.addEventListener("click", () => { cmpItemForKW = null; cmpTarget = null; onScopeChange(); });
      cmpQ = ""; if ($("#cmp-search")) $("#cmp-search").value = "";
      loadCmpTargets();
      return;
    }
    cmpTarget = tr.dataset.dim;
    const lbl = cmpItemForKW ? `商品 「${trunc(cmpItemForKW, 30)}」 × KW 「${trunc(cmpTarget, 30)}」` : trunc(cmpTarget, 40);
    $("#cmp-target-label").innerHTML = `選択: <b>${lbl}</b>`;
    $("#cmp-result-card").classList.remove("hidden");
    renderCmpPicker(); runCompare();
    setTimeout(() => $("#cmp-result-card").scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  });
}
function onCompareGo() {
  const scope = $("#cmp-filters [data-k=scope]").value;
  if (scope === "1") return runCompare();
  if (!cmpTarget) return toast("先に対象を選択してください", true);
  runCompare();
}
async function runCompare() {
  const f = readFilters("#cmp-filters"), win = f.window || "720h", seg = f.segment || "all";
  const scope = f.scope || "1", target = cmpTarget || "";
  if (scope !== "1" && !target) return;  // 대상 미선택
  try {
    if (scope === "1") {
      // 全体 비교 (기존 로직)
      const q = (fr, to) => `from=${fr}&to=${to}&product=${f.product}&selection_type=1&window=${win}&segment=${seg}`;
      const [ia, ib, sa, sb] = await Promise.all([
        api.get("/api/kpis?" + q(f.aFrom, f.aTo)), api.get("/api/kpis?" + q(f.bFrom, f.bTo)),
        api.get("/api/series?" + q(f.aFrom, f.aTo)), api.get("/api/series?" + q(f.bFrom, f.bTo))]);
      cmpA = { ins: ia, series: sa.series, label: `A: ${f.aFrom}〜${f.aTo}` };
      cmpB = { ins: ib, series: sb.series, label: `B: ${f.bFrom}〜${f.bTo}` };
    } else {
      // 상품/키워드 1개에 대한 두 기간 데이터를 직접 집계
      const actualScope = (scope === "3+4") ? "4" : scope;
      const q = (fr, to) => `from=${fr}&to=${to}&product=${f.product}&selection_type=${actualScope}&window=${win}&segment=${seg}&limit=4000`;
      const [da, db] = await Promise.all([api.get("/api/data?" + q(f.aFrom, f.aTo)), api.get("/api/data?" + q(f.bFrom, f.bTo))]);
      const pick = rows => rows.filter(r => {
        if ((r.dimension_key || r.campaign_name) !== target) return false;
        if (scope === "3+4" && cmpItemForKW && r.item_url !== cmpItemForKW) return false;
        return true;
      });
      const ra = pick(da.rows), rb = pick(db.rows);
      ra.forEach(x => x.ctr = (x.impressions && x.clicks) ? x.clicks / x.impressions : null);
      rb.forEach(x => x.ctr = (x.impressions && x.clicks) ? x.clicks / x.impressions : null);
      cmpA = { ins: { current: aggOf(ra) }, series: rowsToSeries(ra), label: `A: ${f.aFrom}〜${f.aTo}` };
      cmpB = { ins: { current: aggOf(rb) }, series: rowsToSeries(rb), label: `B: ${f.bFrom}〜${f.bTo}` };
      cmpA.target = cmpB.target = target;
      // 商品 비교 시 純粋商品CPC도 동봉 (cmpTargets에서 검색)
      if (scope === "3") {
        const t = cmpTargets.find(x => x.dim === target);
        if (t) { cmpA.pure = t.a_pure; cmpB.pure = t.b_pure; }
      }
    }
    renderCompareTable(); drawCompareChart();
    const tgtLine = (scope !== "1") ? `<div class="muted small" style="margin-bottom:4px"><b>${({ "3": "商品", "4": "キーワード", "3+4": "商品×キーワード" })[scope] || "対象"}：</b>${target || ""}</div>` : "";
    $("#cmp-legend").innerHTML = tgtLine + `<b style="color:#bf0000">━</b> ${cmpA.label}　　<b style="color:#9aa0ad">┅┅</b> ${cmpB.label}`;
  } catch (e) { toast("比較の取得に失敗: " + e.message, true); }
}
function rowsToSeries(rows) {
  return rows.slice().sort((a, b) => a.report_date < b.report_date ? -1 : 1)
    .map(r => ({ report_date: r.report_date, ad_cost: r.ad_cost || 0, gms: r.gms || 0, clicks: r.clicks || 0, cv: r.cv || 0, roas: r.ad_cost ? r.gms / r.ad_cost : null }));
}
function renderCompareTable() {
  const A = cmpA.ins.current, B = cmpB.ins.current;
  const rows = [["売上 (GMS)", "gms", fmtMoney], ["広告費", "ad_cost", fmtMoney], ["クリック", "clicks", fmt], ["CTR", "ctr", fmtPct], ["CV", "cv", fmt], ["CVR", "cvr", fmtPct], ["ROAS", "roas", fmtRoas], ["CPC", "cpc", fmtMoney], ["CPA", "cpa", fmtMoney]];
  let html = `<thead><tr><th class="col-l">指標</th><th>${cmpA.label}</th><th>${cmpB.label}</th><th>差 (B vs A)</th></tr></thead><tbody>` +
    rows.map(([l, k, fn]) => {
      const a = A[k], b = B[k]; let diff = "—", cls = "";
      if (typeof a === "number" && typeof b === "number" && a) { const p = Math.round((b - a) / Math.abs(a) * 1000) / 10; cls = p > 0 ? "pos" : (p < 0 ? "neg" : ""); diff = `${p > 0 ? "▲" : (p < 0 ? "▼" : "—")} ${Math.abs(p)}%`; }
      return `<tr><td class="col-l">${l}</td><td>${fn(a)}</td><td>${fn(b)}</td><td class="${cls}">${diff}</td></tr>`;
    }).join("") + "</tbody>";
  // 商品 비교: 純粋商品CPC 비교 행 추가
  if (cmpA.pure && cmpB.pure) {
    const pRows = [["商品M 売上", "gms", fmtMoney], ["商品M 広告費", "ad_cost", fmtMoney], ["商品M ROAS", "roas", fmtRoas], ["商品M比率", "share", v => v != null ? Math.round(v * 100) + "%" : "—"]];
    html += `<thead><tr><th class="col-l" colspan="4" style="background:#e6f1fc;color:#0c5a99;border-top:2px solid #c8def0">📡 外部漏出（純粋商品CPC）</th></tr></thead><tbody>` +
      pRows.map(([l, k, fn]) => {
        const a = cmpA.pure[k], b = cmpB.pure[k]; let diff = "—", cls = "";
        if (typeof a === "number" && typeof b === "number" && a) { const p = Math.round((b - a) / Math.abs(a) * 1000) / 10; cls = p > 0 ? "pos" : (p < 0 ? "neg" : ""); diff = `${p > 0 ? "▲" : (p < 0 ? "▼" : "—")} ${Math.abs(p)}%`; }
        return `<tr class="pure-row"><td class="col-l">${l}</td><td>${fn(a)}</td><td>${fn(b)}</td><td class="${cls}">${diff}</td></tr>`;
      }).join("") + "</tbody>";
  }
  $("#cmp-table").innerHTML = html;
}
function drawCompareChart() {
  const da = cmpA.series.map(d => ({ x: d.report_date, y: d[cmpMetric] ?? 0 }));
  const db = cmpB.series.map(d => ({ x: d.report_date, y: d[cmpMetric] ?? 0 }));
  twoSeriesChart($("#cmp-chart"), da, db, cmpMetric);
}
$$("#cmp-metric .seg-btn").forEach(b => b.onclick = () => { cmpMetric = b.dataset.metric; $$("#cmp-metric .seg-btn").forEach(x => x.classList.toggle("active", x === b)); if (cmpA) drawCompareChart(); });
function twoSeriesChart(cv, A, B, metric) {
  const ctx = cv.getContext("2d");
  // 폭 안전망: clientWidth가 0이면 parent 폭 사용
  const W = cv.width = Math.max(cv.clientWidth || cv.parentElement?.clientWidth || 700, 400);
  const H = cv.height = cv.clientHeight || 240;
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 64, r: 16, t: 16, b: 26 }, n = Math.max(A.length, B.length);
  if (!n) { ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center"; ctx.fillText("データなし", W / 2, H / 2); return; }
  const all = A.concat(B).map(d => d.y), maxY = Math.max(...all) * 1.08 || 1, minY = Math.min(...all, 0);
  const px = i => pad.l + (W - pad.l - pad.r) * (n === 1 ? .5 : i / (n - 1));
  const py = v => pad.t + (H - pad.t - pad.b) * (1 - (v - minY) / (maxY - minY || 1));
  const money = metric === "ad_cost" || metric === "gms";
  const ax = v => money ? abbr(v) : (metric === "roas" ? Math.round(v * 100) + "%" : Math.round(v).toLocaleString());
  ctx.font = "11px sans-serif"; ctx.textAlign = "right"; ctx.strokeStyle = "#eef0f3";
  for (let i = 0; i <= 4; i++) { const v = minY + (maxY - minY) * i / 4, y = py(v); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke(); ctx.fillStyle = "#9ca3af"; ctx.fillText(ax(v), pad.l - 8, y + 4); }
  const line = (data, color, dash) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash); ctx.beginPath();
    data.forEach((d, i) => { const X = px(i), Y = py(d.y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = color;
    data.forEach((d, i) => { ctx.beginPath(); ctx.arc(px(i), py(d.y), 2.5, 0, 7); ctx.fill(); });
  };
  line(B, "#9aa0ad", [5, 4]); line(A, "#bf0000", []);
  ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center";
  const step = Math.ceil(n / 8);
  const dateLabel = (d, i) => {
    const src = (A[i] && A[i].x) || (B[i] && B[i].x);
    if (!src) return "D" + (i + 1);
    const m = String(src).slice(5, 7), dd = String(src).slice(8, 10);
    return `${parseInt(m, 10)}月${parseInt(dd, 10)}日`;
  };
  for (let i = 0; i < n; i++) if (i % step === 0 || i === n - 1) ctx.fillText(dateLabel(null, i), px(i), H - 8);
}

/* ================= レポート (プロ仕様) ================= */
let reportMode = "single";
function loadReportView() {
  if (!$("#rep-filters").innerHTML) {
    buildFilters("#rep-filters", { segment: true, onApply: runReport });
    // PDF/PPT 버튼 → filter-main에 작게 inline 배치
    const main = $("#rep-filters .filter-main");
    const btnPDF = document.createElement("button"); btnPDF.className = "ghost-btn small no-print rep-out-btn"; btnPDF.innerHTML = "🖨 PDF";
    btnPDF.onclick = () => {
      // PDF 출력 직전 모든 details 펼치기 (인쇄 후 자동 원복)
      document.querySelectorAll("details").forEach(d => {
        if (!d.open) { d.dataset.wasClosed = "1"; d.open = true; }
      });
      setTimeout(() => window.print(), 50);
    };
    if (!window._pdfReverted) {
      window._pdfReverted = true;
      window.addEventListener("afterprint", () => {
        document.querySelectorAll('details[data-was-closed="1"]').forEach(d => {
          d.open = false; delete d.dataset.wasClosed;
        });
      });
    }
    const btnPPT = document.createElement("button"); btnPPT.className = "ghost-btn small no-print rep-out-btn"; btnPPT.innerHTML = "📊 PPT";
    btnPPT.onclick = exportPptx;
    if (main) { main.appendChild(btnPDF); main.appendChild(btnPPT); }
    // 모드 토글
    $$("#rep-mode-toggle .seg-btn").forEach(b => b.onclick = () => {
      reportMode = b.dataset.mode;
      $$("#rep-mode-toggle .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      $("#rep-cmp-period").classList.toggle("hidden", reportMode !== "compare");
      runReport();
    });
    // 比較期間 프리셋
    $$("#rep-cmp-preset .seg-btn").forEach(b => b.onclick = () => {
      cmpPeriodPreset = b.dataset.preset;
      $$("#rep-cmp-preset .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      $("#rep-cmp-custom").style.display = cmpPeriodPreset === "custom" ? "inline-flex" : "none";
      runReport();
    });
    ["#rep-cmp-from", "#rep-cmp-to"].forEach(sel => {
      const el = $(sel); if (el) { attachPicker(el, "day"); el.addEventListener("change", () => { if (cmpPeriodPreset === "custom") runReport(); }); }
    });
  }
  runReport();
}
let cmpPeriodPreset = "prev";
let LAST_REPORT = null;  // 마지막 runReport / runReportCompare 결과 캐시 (PPT 가 사용)
async function loadPptxLib() {
  if (window.PptxGenJS) return window.PptxGenJS;
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/gh/gitbrent/PptxGenJS/dist/pptxgen.bundle.js";
    s.onload = () => res(window.PptxGenJS);
    s.onerror = () => rej(new Error("PptxGenJS の読み込みに失敗（インターネット接続を確認してください）"));
    document.head.appendChild(s);
  });
}
async function exportPptx() {
  try {
    if (!LAST_REPORT) {
      toast("先に「適用」を押してレポートを生成してください", true);
      return;
    }
    toast("PowerPoint生成中…", "ok");
    const Pptx = await loadPptxLib();
    const R = LAST_REPORT;
    const f = R.f;
    const client = localStorage.getItem("rep_client") || "楽天RMS 広告アナリティクス";
    const subtitle = localStorage.getItem("rep_subtitle") || (R.mode === "compare" ? "広告パフォーマンス・比較レポート" : "広告パフォーマンス・レポート");
    const logo = localStorage.getItem("rep_logo");

    // 모드별 변수 매핑 (LAST_REPORT 에서 추출)
    const isCompare = R.mode === "compare";
    const ins = isCompare ? R.A : R.ins;
    const insB = isCompare ? R.B : null;
    const c = ins.current || {}, dl = ins.deltas || {};
    const cB = insB ? (insB.current || {}) : null;
    const series = { series: isCompare ? (R.sA || []) : (R.series || []) };
    const seriesB = isCompare ? (R.sB || []) : null;
    const tc = { rows: isCompare ? (R.tcA || []) : (R.tc || []) };
    const ti = { rows: isCompare ? (R.tiA || []) : (R.ti || []) };
    const tk = { rows: isCompare ? (R.tkA || []) : (R.tk || []) };
    const wk = { weekday: R.wk || [] };
    const narrative = localStorage.getItem("rep_narrative_" + f.from + "_" + f.to) || ins.narrative || "";
    const bullets = ins.bullets || [];
    const actions = ins.actions || [];
    const kwDiff = R.kwDiff || null;
    const periodALabel = isCompare ? `期間A ${f.from} 〜 ${f.to}` : "";
    const periodBLabel = isCompare && R.f ? `期間B ${R.pFrom || ""} 〜 ${R.pTo || ""}` : "";

    const p = new Pptx();
    p.layout = "LAYOUT_WIDE";  // 13.33 × 7.5 inch
    // 컬러 팔레트 (Notion/Linear 풍)
    const RED = "BF0000", DARK = "15181E", INK = "1E293B", GRAY = "64748B",
          MUTED = "94A3B8", LINE = "EEF0F2", BG = "FAFBFC", GOOD = "0C7A3E", BAD = "BF0000",
          ACC1 = "1D4ED8", ACC2 = "7C3AED", LIGHT_RED = "FEE2E2";

    // 헬퍼
    const yen = v => v == null ? "—" : "¥" + Math.round(v).toLocaleString("ja-JP");
    const fmtPct = v => v == null ? "—" : (v * 100).toFixed(2) + "%";
    const fmtRoasV = v => v == null ? "—" : Math.round(v * 100) + "%";
    const fmtN = v => v == null ? "—" : Math.round(v).toLocaleString("ja-JP");
    const dPill = d => d == null ? { text: "—", color: GRAY }
                     : d > 0 ? { text: `▲ ${Math.abs(d)}%`, color: GOOD }
                     : d < 0 ? { text: `▼ ${Math.abs(d)}%`, color: BAD }
                     : { text: "横ばい", color: GRAY };

    const addPageHeader = (s, title) => {
      // 상단 좌측: 작은 빨간 점 + 라벨
      s.addShape(p.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.06, fill: { color: RED } });
      s.addText(title, { x: 0.55, y: 0.35, w: 11, h: 0.5, fontSize: 22, bold: true, color: DARK, fontFace: "Yu Gothic UI" });
      s.addText(`${f.from} 〜 ${f.to}`, { x: 0.55, y: 0.78, w: 11, h: 0.3, fontSize: 10, color: MUTED });
      s.addShape(p.ShapeType.line, { x: 0.55, y: 1.18, w: 12.23, h: 0, line: { color: LINE, width: 0.75 } });
      // 우측 상단 client 이름
      s.addText(client, { x: 9, y: 0.35, w: 3.8, h: 0.3, fontSize: 9, color: MUTED, align: "right" });
    };
    const addFooter = (s, n, total) => {
      s.addText([
        { text: client, options: { color: MUTED, fontSize: 8 } },
        { text: "  ·  ", options: { color: LINE, fontSize: 8 } },
        { text: `${n} / ${total}`, options: { color: MUTED, fontSize: 8 } },
      ], { x: 0.55, y: 7.15, w: 12.23, h: 0.25, align: "right" });
    };

    const slides = [];

    /* ───────────────────────────── ① 表紙 ───────────────────────────── */
    const s1 = p.addSlide(); slides.push(s1);
    s1.background = { color: "FFFFFF" };
    // 좌측 빨간 컬러 블록
    s1.addShape(p.ShapeType.rect, { x: 0, y: 0, w: 4.5, h: 7.5, fill: { color: RED } });
    // 좌측: 부제목 (흰 글자)
    s1.addText(subtitle, { x: 0.55, y: 0.6, w: 3.5, h: 0.5, fontSize: 11, color: "FFFFFF", bold: true, charSpacing: 4, fontFace: "Yu Gothic UI" });
    s1.addShape(p.ShapeType.line, { x: 0.55, y: 1.05, w: 1.4, h: 0, line: { color: "FFFFFF", width: 1.5 } });
    // 우측 메인 타이틀
    s1.addText(client, { x: 5, y: 1.4, w: 7.8, h: 1.8, fontSize: 36, bold: true, color: DARK, lineSpacingMultiple: 1.1, fontFace: "Yu Gothic UI" });
    // 기간 큰 텍스트
    s1.addText(`${f.from} 〜 ${f.to}`, { x: 5, y: 3.6, w: 7.8, h: 0.5, fontSize: 18, color: RED, bold: true, fontFace: "SF Mono" });
    s1.addText([
      { text: "広告種別\n", options: { color: MUTED, fontSize: 9, charSpacing: 2 } },
      { text: `${f.product === "ALL" ? "全広告" : f.product}\n\n`, options: { bold: true, fontSize: 14, color: DARK } },
      { text: "作成日\n", options: { color: MUTED, fontSize: 9, charSpacing: 2 } },
      { text: `${new Date().toLocaleDateString("ja-JP")}`, options: { bold: true, fontSize: 14, color: DARK } },
    ], { x: 5, y: 4.4, w: 7.8, h: 2 });
    // 로고
    if (logo && logo.startsWith("data:image")) {
      try { s1.addImage({ data: logo, x: 10.5, y: 6.5, w: 2.3, h: 0.7, sizing: { type: "contain", w: 2.3, h: 0.7 } }); } catch {}
    }

    /* ─────────────────────── ② エグゼクティブ サマリー ─────────────────────── */
    if (narrative || bullets.length) {
      const s = p.addSlide(); slides.push(s);
      addPageHeader(s, "エグゼクティブ サマリー");
      let y = 1.5;
      if (narrative) {
        s.addShape(p.ShapeType.rect, { x: 0.55, y: y, w: 0.08, h: 1.6, fill: { color: RED } });
        s.addText(narrative, { x: 0.85, y: y, w: 11.9, h: 1.6, fontSize: 14, color: INK, valign: "top", lineSpacingMultiple: 1.4, fontFace: "Yu Gothic UI" });
        y += 1.85;
      }
      if (bullets.length) {
        s.addText("ハイライト", { x: 0.55, y: y, w: 12, h: 0.4, fontSize: 12, bold: true, color: GRAY, charSpacing: 2 });
        y += 0.45;
        bullets.slice(0, 5).forEach(b => {
          s.addText([
            { text: "•  ", options: { color: RED, fontSize: 13, bold: true } },
            { text: b, options: { color: INK, fontSize: 11.5 } },
          ], { x: 0.7, y: y, w: 12.2, h: 0.35, valign: "top", fontFace: "Yu Gothic UI" });
          y += 0.4;
        });
      }
    }

    /* ─────────────────────── ③ KPI ハイライト (메트릭 카드 6개) ─────────────────────── */
    {
      const s = p.addSlide(); slides.push(s);
      addPageHeader(s, "KPI ハイライト");
      const METRICS = [
        { label: "売上 (GMS)", value: yen(c.gms), delta: dl.gms },
        { label: "広告費", value: yen(c.ad_cost), delta: dl.ad_cost },
        { label: "クリック", value: fmtN(c.clicks), delta: dl.clicks },
        { label: "CV", value: fmtN(c.cv), delta: dl.cv },
        { label: "ROAS", value: fmtRoasV(c.roas), delta: dl.roas, big: true },
        { label: "CPC / CPA", value: `${yen(c.cpc)} / ${yen(c.cpa)}`, delta: null },
      ];
      // 3 × 2 그리드, 각 카드 4.0 × 2.6
      const cardW = 4.0, cardH = 2.6, gapX = 0.15, gapY = 0.2, startX = 0.55, startY = 1.45;
      METRICS.forEach((m, i) => {
        const col = i % 3, row = Math.floor(i / 3);
        const x = startX + col * (cardW + gapX);
        const y = startY + row * (cardH + gapY);
        // 카드 배경
        s.addShape(p.ShapeType.roundRect, { x, y, w: cardW, h: cardH, fill: { color: "FFFFFF" }, line: { color: LINE, width: 1 }, rectRadius: 0.08 });
        // 라벨
        s.addText(m.label, { x: x + 0.2, y: y + 0.18, w: cardW - 0.4, h: 0.4, fontSize: 10, bold: true, color: GRAY, charSpacing: 2 });
        // 값
        s.addText(m.value, { x: x + 0.2, y: y + 0.7, w: cardW - 0.4, h: 1.0, fontSize: m.big ? 38 : 28, bold: true, color: m.big ? RED : DARK, fontFace: "Yu Gothic UI" });
        // 델타
        const dp = dPill(m.delta);
        s.addText(`${dp.text}  ${m.delta == null ? "" : "前期間比"}`,
                  { x: x + 0.2, y: y + cardH - 0.55, w: cardW - 0.4, h: 0.4, fontSize: 11, bold: true, color: dp.color });
      });
    }

    /* ─────────────────────── ④ 売上・広告費 推移 (Line) ─────────────────────── */
    if (series.series && series.series.length) {
      const s = p.addSlide(); slides.push(s);
      addPageHeader(s, "売上・広告費 推移");
      const labels = series.series.map(r => r.report_date?.slice(5) || "");
      const data = [
        { name: "売上", labels, values: series.series.map(r => r.gms || 0) },
        { name: "広告費", labels, values: series.series.map(r => r.ad_cost || 0) },
      ];
      s.addChart(p.ChartType.line, data, {
        x: 0.55, y: 1.45, w: 12.23, h: 5.5,
        chartColors: [RED, ACC1],
        showLegend: true, legendPos: "t", legendFontSize: 11, legendColor: GRAY,
        catAxisLabelFontSize: 9, valAxisLabelFontSize: 9,
        catAxisLabelColor: GRAY, valAxisLabelColor: GRAY,
        lineDataSymbolSize: 5, lineSize: 2.5,
        showValue: false, valGridLine: { color: LINE, style: "solid" }, catGridLine: { color: "FFFFFF" },
      });
    }

    /* ─────────────────────── ⑤ 曜日別 (Combo) ─────────────────────── */
    if (wk && wk.weekday && wk.weekday.some(w => w.days > 0)) {
      const s = p.addSlide(); slides.push(s);
      addPageHeader(s, "曜日別パフォーマンス");
      const labels = wk.weekday.map(w => w.weekday + "曜");
      const data = [
        { name: "売上", labels, values: wk.weekday.map(w => w.gms || 0) },
        { name: "ROAS (%)", labels, values: wk.weekday.map(w => w.roas ? Math.round(w.roas * 100) : 0) },
      ];
      s.addChart(p.ChartType.bar, [data[0]], {
        x: 0.55, y: 1.45, w: 12.23, h: 5.5,
        barDir: "col", chartColors: [RED],
        showLegend: false, showValue: false,
        catAxisLabelFontSize: 11, valAxisLabelFontSize: 9, catAxisLabelColor: DARK, valAxisLabelColor: GRAY,
        valGridLine: { color: LINE, style: "solid" },
      });
      // ROAS 라인을 텍스트로 우측 상단에 추가 (Pptx combo 제한 회피)
      const roasText = wk.weekday.map(w => `${w.weekday}: ${w.roas ? Math.round(w.roas * 100) : 0}%`).join("  ");
      s.addText("ROAS  " + roasText, { x: 0.55, y: 1.18, w: 12.23, h: 0.25, fontSize: 9, color: ACC1, bold: true });
    }

    /* ─────────────────────── ⑥⑦⑧ TOP 표들 ─────────────────────── */
    const topSlide = (title, rows, dimLabel) => {
      if (!rows || !rows.length) return;
      const s = p.addSlide(); slides.push(s);
      addPageHeader(s, title);
      const HDR = [
        { text: "#", options: { bold: true, fill: { color: BG }, color: GRAY, align: "center", valign: "middle", fontSize: 10 } },
        { text: dimLabel, options: { bold: true, fill: { color: BG }, color: DARK, valign: "middle", fontSize: 10 } },
        { text: "売上", options: { bold: true, fill: { color: BG }, color: DARK, align: "right", valign: "middle", fontSize: 10 } },
        { text: "広告費", options: { bold: true, fill: { color: BG }, color: DARK, align: "right", valign: "middle", fontSize: 10 } },
        { text: "ROAS", options: { bold: true, fill: { color: BG }, color: DARK, align: "right", valign: "middle", fontSize: 10 } },
        { text: "CPA", options: { bold: true, fill: { color: BG }, color: DARK, align: "right", valign: "middle", fontSize: 10 } },
      ];
      const body = rows.slice(0, 8).map((r, i) => {
        const roasV = r.roas != null ? Math.round(r.roas * 100) : null;
        return [
          { text: String(i + 1), options: { align: "center", color: GRAY, fontSize: 11 } },
          { text: (r.dimension_key || r.campaign_name || "—").toString().slice(0, 55), options: { color: INK, fontSize: 11, bold: true } },
          { text: yen(r.gms), options: { align: "right", color: INK, fontSize: 11 } },
          { text: yen(r.ad_cost), options: { align: "right", color: INK, fontSize: 11 } },
          { text: roasV == null ? "—" : roasV + "%", options: { align: "right", bold: true, color: roasV >= 200 ? GOOD : (roasV < 100 ? BAD : DARK), fontSize: 11 } },
          { text: r.cpa ? yen(r.cpa) : "—", options: { align: "right", color: INK, fontSize: 11 } },
        ];
      });
      s.addTable([HDR, ...body], {
        x: 0.55, y: 1.45, w: 12.23,
        colW: [0.6, 5.5, 1.7, 1.7, 1.3, 1.43],
        rowH: 0.42, fontFace: "Yu Gothic UI",
        border: { type: "solid", pt: 0.5, color: LINE },
      });
    };
    topSlide("TOP キャンペーン", tc.rows || [], "キャンペーン");
    topSlide("TOP 商品", ti.rows || [], "商品");
    topSlide("TOP キーワード", tk.rows || [], "キーワード");

    /* ───────────── 일반 모드 전용 추가 슬라이드 ───────────── */
    if (!isCompare) {
      // (가) 新規 vs 既存 顧客 比較
      if (R.insNew && R.insExist) {
        const a = R.insNew.current || {}, b = R.insExist.current || {};
        const s = p.addSlide(); slides.push(s);
        addPageHeader(s, "新規 vs 既存 顧客 (CV ベース)");
        s.addText("新規顧客", { x: 0.55, y: 1.18, w: 6.1, h: 0.3, fontSize: 10, bold: true, color: ACC1 });
        s.addText("既存顧客", { x: 6.7, y: 1.18, w: 6.1, h: 0.3, fontSize: 10, bold: true, color: ACC2 });
        const KEYS = [
          { k: "gms",     label: "売上 (GMS)",  fmt: yen },
          { k: "ad_cost", label: "広告費",       fmt: yen },
          { k: "cv",      label: "CV",          fmt: fmtN },
          { k: "roas",    label: "ROAS",        fmt: fmtRoasV },
          { k: "cvr",     label: "CVR",         fmt: fmtPct },
          { k: "cpa",     label: "CPA",         fmt: yen },
        ];
        const tbl = [[
          { text: "指標", options: { bold: true, fill: { color: BG }, fontSize: 10, color: GRAY } },
          { text: "新規",  options: { bold: true, fill: { color: BG }, fontSize: 10, color: ACC1, align: "right" } },
          { text: "既存",  options: { bold: true, fill: { color: BG }, fontSize: 10, color: ACC2, align: "right" } },
          { text: "新規比率", options: { bold: true, fill: { color: BG }, fontSize: 10, color: GRAY, align: "right" } },
        ]];
        KEYS.forEach(K => {
          const va = a[K.k], vb = b[K.k];
          const ratio = (va != null && vb != null && (va + vb)) ? Math.round(va / (va + vb) * 100) : null;
          tbl.push([
            { text: K.label, options: { color: DARK, fontSize: 12, bold: true } },
            { text: K.fmt(va), options: { align: "right", color: INK, fontSize: 12 } },
            { text: K.fmt(vb), options: { align: "right", color: INK, fontSize: 12 } },
            { text: ratio != null ? ratio + "%" : "—", options: { align: "right", bold: true, color: ACC1, fontSize: 12 } },
          ]);
        });
        s.addTable(tbl, { x: 0.55, y: 1.6, w: 12.23, rowH: 0.5, border: { type: "solid", pt: 0.5, color: LINE }, fontFace: "Yu Gothic UI" });
      }

      // (나) キーワード 新規/소멸 (kwDiff)
      if (kwDiff && ((kwDiff.entered || []).length || (kwDiff.gone || []).length)) {
        const s = p.addSlide(); slides.push(s);
        addPageHeader(s, "キーワード 変化 (前期間比)");
        s.addText("★ 新規キーワード", { x: 0.55, y: 1.4, w: 6.1, h: 0.4, fontSize: 12, bold: true, color: GOOD });
        s.addText("◆ 消失キーワード", { x: 6.7, y: 1.4, w: 6.1, h: 0.4, fontSize: 12, bold: true, color: BAD });
        const mkTbl = (rows, accent) => {
          const T = [[
            { text: "キーワード", options: { bold: true, fill: { color: BG }, fontSize: 10, color: DARK } },
            { text: "広告費", options: { bold: true, fill: { color: BG }, fontSize: 10, color: DARK, align: "right" } },
            { text: "売上", options: { bold: true, fill: { color: BG }, fontSize: 10, color: DARK, align: "right" } },
          ]];
          rows.slice(0, 12).forEach(r => T.push([
            { text: (r.dimension_key || "—").slice(0, 30), options: { color: INK, fontSize: 10 } },
            { text: yen(r.cost), options: { align: "right", color: INK, fontSize: 10 } },
            { text: yen(r.gms), options: { align: "right", color: accent, fontSize: 10, bold: true } },
          ]));
          if (!rows.length) T.push([{ text: "なし", options: { color: MUTED, fontSize: 10, italic: true } }, { text: "" }, { text: "" }]);
          return T;
        };
        s.addTable(mkTbl(kwDiff.entered || [], GOOD),
                   { x: 0.55, y: 1.85, w: 6.1, rowH: 0.32, fontSize: 10, fontFace: "Yu Gothic UI",
                     border: { type: "solid", pt: 0.5, color: LINE } });
        s.addTable(mkTbl(kwDiff.gone || [], BAD),
                   { x: 6.7, y: 1.85, w: 6.13, rowH: 0.32, fontSize: 10, fontFace: "Yu Gothic UI",
                     border: { type: "solid", pt: 0.5, color: LINE } });
      }

      // (다) 商品 × キーワード TOP (mx.items)
      if (R.mx && R.mx.items && R.mx.items.length) {
        const items = R.mx.items.slice().sort((a, b) => (b.total_gms || 0) - (a.total_gms || 0)).slice(0, 6);
        const s = p.addSlide(); slides.push(s);
        addPageHeader(s, "商品 × キーワード TOP");
        let y = 1.45;
        items.forEach((it, i) => {
          const kws = (it.keywords || []).slice().sort((a, b) => (b.gms || 0) - (a.gms || 0)).slice(0, 3);
          const itemLabel = (it.item_label || it.item_url || "—").slice(0, 50);
          // 상품 카드 헤더
          s.addShape(p.ShapeType.roundRect, { x: 0.55, y, w: 12.23, h: 0.8, fill: { color: BG }, line: { color: LINE, width: 0.5 }, rectRadius: 0.04 });
          s.addText(`#${i + 1}`, { x: 0.7, y: y + 0.18, w: 0.6, h: 0.45, fontSize: 16, bold: true, color: RED, fontFace: "Yu Gothic UI" });
          s.addText(itemLabel, { x: 1.4, y: y + 0.15, w: 7.0, h: 0.3, fontSize: 12, bold: true, color: DARK, fontFace: "Yu Gothic UI" });
          s.addText(`KW × ${(it.keyword_count || 0)}`, { x: 1.4, y: y + 0.45, w: 7, h: 0.25, fontSize: 9, color: MUTED });
          // KPI 우측 정렬
          s.addText(`売上 ${yen(it.total_gms)}`, { x: 8.5, y: y + 0.12, w: 3.5, h: 0.3, fontSize: 11, color: INK, align: "right", bold: true });
          s.addText(`ROAS ${fmtRoasV(it.roas)}`, { x: 8.5, y: y + 0.42, w: 3.5, h: 0.3, fontSize: 11, color: RED, align: "right", bold: true });
          y += 0.85;
          // 상위 키워드 한 줄
          if (kws.length) {
            const kwText = kws.map(k => `${k.keyword || "?"} (${yen(k.gms)})`).join("   ·   ");
            s.addText("  └ " + kwText, { x: 0.7, y, w: 12.1, h: 0.3, fontSize: 9.5, color: GRAY, fontFace: "Yu Gothic UI" });
            y += 0.32;
          }
          y += 0.1;
        });
      }

      // (라) 전년 동기 비교 (seasonality)
      if (R.season && R.season.has_prev) {
        const cur = R.season.current || {}, pyy = R.season.prev_year || {}, yoy = R.season.yoy || {};
        const s = p.addSlide(); slides.push(s);
        addPageHeader(s, "前年同期 比較 (YoY)");
        s.addText(`今年 ${f.from} 〜 ${f.to}`, { x: 0.55, y: 1.18, w: 6.1, h: 0.3, fontSize: 10, bold: true, color: RED });
        s.addText(`前年 ${R.season.prev_range?.from || "—"} 〜 ${R.season.prev_range?.to || "—"}`, { x: 6.7, y: 1.18, w: 6.1, h: 0.3, fontSize: 10, bold: true, color: GRAY });
        const KEYS = [
          { k: "gms",     label: "売上 (GMS)" },
          { k: "ad_cost", label: "広告費" },
          { k: "clicks",  label: "クリック" },
          { k: "cv",      label: "CV" },
          { k: "roas",    label: "ROAS", fmt: fmtRoasV },
        ];
        const tbl = [[
          { text: "指標", options: { bold: true, fill: { color: BG }, fontSize: 10, color: GRAY } },
          { text: "今年",  options: { bold: true, fill: { color: BG }, fontSize: 10, color: RED, align: "right" } },
          { text: "前年",  options: { bold: true, fill: { color: BG }, fontSize: 10, color: GRAY, align: "right" } },
          { text: "YoY",   options: { bold: true, fill: { color: BG }, fontSize: 10, color: DARK, align: "right" } },
        ]];
        KEYS.forEach(K => {
          const fn = K.fmt || (typeof K.k === "string" && K.k === "roas" ? fmtRoasV : yen);
          const va = cur[K.k], vb = pyy[K.k], yoyV = yoy[K.k];
          const dp = dPill(yoyV);
          tbl.push([
            { text: K.label, options: { color: DARK, fontSize: 12, bold: true } },
            { text: fn(va), options: { align: "right", color: INK, fontSize: 12 } },
            { text: fn(vb), options: { align: "right", color: GRAY, fontSize: 12 } },
            { text: dp.text, options: { align: "right", bold: true, color: dp.color, fontSize: 12 } },
          ]);
        });
        s.addTable(tbl, { x: 0.55, y: 1.6, w: 12.23, rowH: 0.5, border: { type: "solid", pt: 0.5, color: LINE }, fontFace: "Yu Gothic UI" });
      }

      // (마) 이상치 일자 (outliers)
      if (R.outliers && R.outliers.length) {
        const top = R.outliers.slice(0, 8);
        const s = p.addSlide(); slides.push(s);
        addPageHeader(s, "異常値 (IQR×1.5)");
        const tbl = [[
          { text: "日付", options: { bold: true, fill: { color: BG }, fontSize: 10, color: GRAY } },
          { text: "指標", options: { bold: true, fill: { color: BG }, fontSize: 10, color: GRAY } },
          { text: "値",   options: { bold: true, fill: { color: BG }, fontSize: 10, color: GRAY, align: "right" } },
          { text: "種別", options: { bold: true, fill: { color: BG }, fontSize: 10, color: GRAY, align: "center" } },
        ]];
        top.forEach(o => tbl.push([
          { text: o.date, options: { color: INK, fontSize: 11 } },
          { text: o.metric, options: { color: INK, fontSize: 11 } },
          { text: fmtN(o.value), options: { align: "right", color: INK, fontSize: 11 } },
          { text: o.kind === "high" ? "▲ 高" : "▼ 低",
            options: { align: "center", bold: true, color: o.kind === "high" ? GOOD : BAD, fontSize: 11 } },
        ]));
        s.addTable(tbl, { x: 0.55, y: 1.5, w: 12.23, rowH: 0.42, border: { type: "solid", pt: 0.5, color: LINE }, fontFace: "Yu Gothic UI" });
      }
    }

    /* ───────────── 비교 모드 전용 슬라이드 ───────────── */
    if (isCompare) {
      // (A) KPI 比較 — A vs B 메트릭 카드 가로 2컬럼
      {
        const s = p.addSlide(); slides.push(s);
        addPageHeader(s, "KPI 比較 (期間A vs 期間B)");
        s.addText(periodALabel, { x: 0.55, y: 1.18, w: 6.1, h: 0.3, fontSize: 10, bold: true, color: RED });
        s.addText(periodBLabel, { x: 6.7, y: 1.18, w: 6.1, h: 0.3, fontSize: 10, bold: true, color: ACC1 });
        const KEYS = [
          { k: "gms",     label: "売上 (GMS)",  fmt: yen },
          { k: "ad_cost", label: "広告費",       fmt: yen },
          { k: "clicks",  label: "クリック",     fmt: fmtN },
          { k: "cv",      label: "CV",          fmt: fmtN },
          { k: "roas",    label: "ROAS",        fmt: fmtRoasV },
          { k: "cpa",     label: "CPA",         fmt: yen },
        ];
        // 6행 × 4열 (라벨 / 期間A / 期間B / Δ)
        const tbl = [[
          { text: "指標",  options: { bold: true, fill: { color: BG }, fontSize: 10, color: GRAY } },
          { text: "期間A", options: { bold: true, fill: { color: BG }, fontSize: 10, color: RED, align: "right" } },
          { text: "期間B", options: { bold: true, fill: { color: BG }, fontSize: 10, color: ACC1, align: "right" } },
          { text: "差分",  options: { bold: true, fill: { color: BG }, fontSize: 10, color: GRAY, align: "right" } },
        ]];
        KEYS.forEach(K => {
          const va = c[K.k], vb = cB[K.k];
          const delta = (va != null && vb) ? Math.round((va - vb) / Math.abs(vb) * 1000) / 10 : null;
          const dp = dPill(delta);
          tbl.push([
            { text: K.label, options: { color: DARK, fontSize: 12, bold: true } },
            { text: K.fmt(va), options: { align: "right", color: INK, fontSize: 12 } },
            { text: K.fmt(vb), options: { align: "right", color: INK, fontSize: 12 } },
            { text: dp.text, options: { align: "right", bold: true, color: dp.color, fontSize: 12 } },
          ]);
        });
        s.addTable(tbl, { x: 0.55, y: 1.6, w: 12.23, rowH: 0.5, border: { type: "solid", pt: 0.5, color: LINE }, fontFace: "Yu Gothic UI" });
      }

      // (B) 売上 推移 比較 (A/B 두 라인)
      if (series.series.length || seriesB.length) {
        const s = p.addSlide(); slides.push(s);
        addPageHeader(s, "売上 推移 比較");
        const maxLen = Math.max(series.series.length, seriesB.length);
        const labels = Array.from({ length: maxLen }, (_, i) => `Day ${i + 1}`);
        const data = [
          { name: "期間A 売上", labels, values: series.series.map(r => r.gms || 0) },
          { name: "期間B 売上", labels, values: seriesB.map(r => r.gms || 0) },
        ];
        s.addChart(p.ChartType.line, data, {
          x: 0.55, y: 1.45, w: 12.23, h: 5.5,
          chartColors: [RED, ACC1],
          showLegend: true, legendPos: "t", legendFontSize: 11, legendColor: GRAY,
          catAxisLabelFontSize: 9, valAxisLabelFontSize: 9,
          lineSize: 2.5, lineDataSymbolSize: 5,
          valGridLine: { color: LINE, style: "solid" },
        });
      }

      // (C) キーワード 変化 (kwDiff: entered / gone)
      if (kwDiff && ((kwDiff.entered || []).length || (kwDiff.gone || []).length)) {
        const s = p.addSlide(); slides.push(s);
        addPageHeader(s, "キーワード 変化");
        s.addText("★ 新規キーワード (期間B → A)", { x: 0.55, y: 1.4, w: 6.1, h: 0.4, fontSize: 12, bold: true, color: GOOD });
        s.addText("◆ 消失キーワード (期間A のみ)", { x: 6.7, y: 1.4, w: 6.1, h: 0.4, fontSize: 12, bold: true, color: BAD });
        const mkTbl = (rows, accent) => {
          const T = [[
            { text: "キーワード", options: { bold: true, fill: { color: BG }, fontSize: 10, color: DARK } },
            { text: "広告費", options: { bold: true, fill: { color: BG }, fontSize: 10, color: DARK, align: "right" } },
            { text: "売上", options: { bold: true, fill: { color: BG }, fontSize: 10, color: DARK, align: "right" } },
          ]];
          rows.slice(0, 12).forEach(r => T.push([
            { text: (r.dimension_key || "—").slice(0, 30), options: { color: INK, fontSize: 10 } },
            { text: yen(r.cost), options: { align: "right", color: INK, fontSize: 10 } },
            { text: yen(r.gms), options: { align: "right", color: accent, fontSize: 10, bold: true } },
          ]));
          return T;
        };
        s.addTable(mkTbl(kwDiff.entered || [], GOOD),
                   { x: 0.55, y: 1.85, w: 6.1, rowH: 0.32, fontSize: 10, fontFace: "Yu Gothic UI",
                     border: { type: "solid", pt: 0.5, color: LINE } });
        s.addTable(mkTbl(kwDiff.gone || [], BAD),
                   { x: 6.7, y: 1.85, w: 6.13, rowH: 0.32, fontSize: 10, fontFace: "Yu Gothic UI",
                     border: { type: "solid", pt: 0.5, color: LINE } });
      }
    }

    /* ─────────────────────── ⑨ アクション提案 ─────────────────────── */
    if (actions && actions.length) {
      const s = p.addSlide(); slides.push(s);
      addPageHeader(s, "アクション 提案");
      let y = 1.5;
      actions.slice(0, 6).forEach((a, i) => {
        s.addShape(p.ShapeType.roundRect, { x: 0.55, y, w: 0.5, h: 0.5, fill: { color: RED }, line: { color: RED }, rectRadius: 0.08 });
        s.addText(String(i + 1), { x: 0.55, y, w: 0.5, h: 0.5, fontSize: 14, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
        s.addText(a, { x: 1.2, y, w: 11.6, h: 0.65, fontSize: 12.5, color: INK, valign: "top", lineSpacingMultiple: 1.35, fontFace: "Yu Gothic UI" });
        y += 0.8;
      });
    }

    /* ─────────────────────── ⑩ 終わり (감사) ─────────────────────── */
    {
      const s = p.addSlide(); slides.push(s);
      s.background = { color: DARK };
      s.addShape(p.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.18, fill: { color: RED } });
      s.addText("Thank you.", { x: 0.55, y: 3, w: 12.23, h: 1.2, fontSize: 60, bold: true, color: "FFFFFF", align: "center", fontFace: "Yu Gothic UI" });
      s.addText(client, { x: 0.55, y: 4.4, w: 12.23, h: 0.5, fontSize: 14, color: MUTED, align: "center", charSpacing: 2 });
      s.addText(new Date().toLocaleDateString("ja-JP"), { x: 0.55, y: 5.0, w: 12.23, h: 0.4, fontSize: 11, color: MUTED, align: "center" });
    }

    // 푸터 (표지/감사 제외)
    slides.forEach((s, i) => {
      if (i === 0 || i === slides.length - 1) return;
      addFooter(s, i + 1, slides.length);
    });

    const stamp = new Date().toISOString().slice(0, 10);
    await p.writeFile({ fileName: `report_${stamp}.pptx` });
    toast("PowerPoint を保存しました", "ok");
  } catch (e) {
    console.error("[exportPptx] failed:", e);
    toast("PPT 生成失敗: " + (e.message || e), true);
  }
}
async function runReport() {
  const f = readFilters("#rep-filters"), win = f.window || "720h", seg = f.segment || "all";
  const q = (fr, to) => `from=${fr}&to=${to}&product=${f.product}&window=${win}&segment=${seg}`;
  // 로딩 스켈레톤 (rep-shell의 grid 무시하고 풀폭 사용)
  $("#report-body").innerHTML = `<div class="rep-shell skel-mode">
    <article class="rep-doc">
      <div class="skel skel-title" style="width:55%;height:38px;margin-bottom:8px"></div>
      <div class="skel skel-line" style="width:30%;margin-bottom:28px"></div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:24px">
        ${Array(5).fill(0).map(() => `<div class="skel skel-kpi"></div>`).join("")}
      </div>
      <div class="skel skel-chart"></div>
      ${Array(2).fill(0).map(() => `<div class="skel-card">
        <div class="skel skel-title" style="width:30%"></div>
        <div class="skel skel-line"></div>
        <div class="skel skel-line" style="width:90%"></div>
        <div class="skel skel-line" style="width:70%"></div>
      </div>`).join("")}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px">
        <div class="skel skel-table" style="height:220px"></div>
        <div class="skel skel-table" style="height:220px"></div>
      </div>
    </article>
  </div>`;
  try {
    const days = (new Date(f.to) - new Date(f.from)) / 86400000 + 1;
    let pTo = addDays(f.from, -1), pFrom = addDays(pTo, -(days - 1));
    if (reportMode === "compare") {
      if (cmpPeriodPreset === "yoy") {
        // 전년 동기
        const yFrom = new Date(f.from); yFrom.setFullYear(yFrom.getFullYear() - 1);
        const yTo = new Date(f.to); yTo.setFullYear(yTo.getFullYear() - 1);
        pFrom = yFrom.toISOString().slice(0, 10); pTo = yTo.toISOString().slice(0, 10);
      } else if (cmpPeriodPreset === "custom") {
        const cf = $("#rep-cmp-from")?.value, ct = $("#rep-cmp-to")?.value;
        if (cf && ct) { pFrom = cf; pTo = ct; }
      }
      const info = $("#rep-cmp-info"); if (info) info.textContent = `${pFrom} 〜 ${pTo}`;
      // 커스텀 입력칸 기본값 채워두기
      if (cmpPeriodPreset !== "custom") {
        if ($("#rep-cmp-from") && !$("#rep-cmp-from").value) $("#rep-cmp-from").value = pFrom;
        if ($("#rep-cmp-to") && !$("#rep-cmp-to").value) $("#rep-cmp-to").value = pTo;
      }
      return runReportCompare(f, q, pFrom, pTo);
    }
    const qSeg = (fr, to, sg) => `from=${fr}&to=${to}&product=${f.product}&window=${win}&segment=${sg}`;
    const [ins, insP, series, tc, ti, tk, tcP, tiP, tkP, insNew, insExist, wk, outl, kwDiff, season, mx] = await Promise.all([
      api.get(`/api/kpis?${q(f.from, f.to)}&selection_type=1`),
      api.get(`/api/kpis?${q(pFrom, pTo)}&selection_type=1`),
      api.get(`/api/series?${q(f.from, f.to)}&selection_type=1`),
      api.get(`/api/top?${q(f.from, f.to)}&selection_type=2&order_by=ad_cost&limit=7`),
      api.get(`/api/top?${q(f.from, f.to)}&selection_type=3&order_by=ad_cost&limit=7`),
      api.get(`/api/top?${q(f.from, f.to)}&selection_type=4&order_by=ad_cost&limit=7`),
      api.get(`/api/top?${q(pFrom, pTo)}&selection_type=2&order_by=ad_cost&limit=50`),
      api.get(`/api/top?${q(pFrom, pTo)}&selection_type=3&order_by=ad_cost&limit=50`),
      api.get(`/api/top?${q(pFrom, pTo)}&selection_type=4&order_by=ad_cost&limit=50`),
      api.get(`/api/kpis?${qSeg(f.from, f.to, "new")}&selection_type=1`),
      api.get(`/api/kpis?${qSeg(f.from, f.to, "existing")}&selection_type=1`),
      api.get(`/api/weekday?${q(f.from, f.to)}`),
      api.get(`/api/outliers?${q(f.from, f.to)}&metric=gms`),
      api.get(`/api/keyword_diff?${q(f.from, f.to)}&aFrom=${pFrom}&aTo=${pTo}`),
      api.get(`/api/seasonality?${q(f.from, f.to)}`).catch(() => null),
      api.get(`/api/item_keywords?from=${f.from}&to=${f.to}&window=${win}&segment=${seg}`).catch(() => ({ items: [] }))]);
    // 마지막 렌더 결과 캐싱 — PPT/PDF 가 같은 데이터 사용
    LAST_REPORT = {
      mode: "normal",
      f, ins, insP, insNew, insExist,
      pFrom, pTo,
      series: series.series, tc: tc.rows, ti: ti.rows, tk: tk.rows,
      tcP: tcP.rows, tiP: tiP.rows, tkP: tkP.rows,
      wk: wk.weekday, outliers: outl.outliers, kwDiff, season, mx,
    };
    renderReport(f, { cur: ins, prev: insP, prevRange: { from: pFrom, to: pTo } }, series.series, tc.rows, ti.rows, tk.rows, insNew, insExist, wk.weekday, outl.outliers, kwDiff, season, null, { camp: tcP.rows, item: tiP.rows, kw: tkP.rows }, null, mx);
  } catch (e) { toast("レポート生成に失敗: " + e.message, true); }
}
function deltaPill(p) {
  if (p == null) return `<span class="rep-d flat">—</span>`;
  const cls = p > 0 ? "up" : (p < 0 ? "down" : "flat"), ar = p > 0 ? "▲" : (p < 0 ? "▼" : "—");
  return `<span class="rep-d ${cls}">${ar} ${Math.abs(p)}%</span>`;
}
function renderReport(f, R, series, camp, items, kws, insNew, insExist, weekday, outliers, kwDiff, season, cohort, prevTops, cmpData, mx) {
  const c = R.cur.current, d = R.cur.deltas;
  const cmpEnabled = !!cmpData;
  const freshBadge = R.cur.impressions_last_date
    ? `<span class="rep-fresh">⚠ CTR/表示回数 最終確定: ${R.cur.impressions_last_date}</span>` : "";
  const cmpBadge = cmpEnabled
    ? `<span class="rep-cmp-badge">期間比較 ON ・ 比較期間: ${cmpData.prevRange.from} 〜 ${cmpData.prevRange.to}</span>` : "";
  const logo = localStorage.getItem("rep_logo");
  const segL = { all: "全体", new: "新規顧客", existing: "既存顧客" }[f.segment || "all"];
  const period = `${f.from} 〜 ${f.to}`;
  const prevPeriod = `${R.prevRange.from} 〜 ${R.prevRange.to}`;
  const now = new Date(); const stamp = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
  // 통상 모드: 단순 한 줄 카드 (비교 모드는 별도 페이지에서 처리)
  const kpi = (l, v, dl, spark, sub, subv) => `<div class="rep-kpi${l === "ROAS" ? " rep-kpi-accent" : ""}"><div class="rep-kl">${l}</div><div class="rep-v">${v}</div><div class="rep-foot">${deltaPill(dl)}${sub ? `<span class="kpi-sub">${sub} <b>${subv}</b></span>` : ""}${spark ? `<canvas class="rep-spark" data-spark="${spark}"></canvas>` : ""}</div></div>`;
  // 인사이트 분류 — 첫 줄 헤드라인 / 나머지 비고
  const topT = (title, rows, dl, sid, prevRows) => {
    const totalCost = rows.reduce((a, b) => a + (b.ad_cost || 0), 0) || 1;
    const prevRank = new Map();
    (prevRows || []).forEach((r, i) => prevRank.set(r.dimension_key || r.campaign_name, i + 1));
    const moveBadge = (key, curRank) => {
      const pr = prevRank.get(key);
      if (pr == null) return `<span class="rk-move rk-new" title="新規ランクイン">★ NEW</span>`;
      const diff = pr - curRank;
      if (diff > 0) return `<span class="rk-move rk-up" title="比較期間 ${pr}位">▲ ${diff}</span>`;
      if (diff < 0) return `<span class="rk-move rk-down" title="比較期間 ${pr}位">▼ ${-diff}</span>`;
      return `<span class="rk-move rk-same" title="比較期間 ${pr}位">−</span>`;
    };
    return `<section class="rep-sec" id="${sid}">
      <div class="sec-head"><h3 class="rep-sub">${title}</h3></div>
      <table class="rep-tbl rep-tbl-wide"><thead><tr><th class="col-l">${dl}</th><th class="col-rk">比較</th><th>売上</th><th>広告費</th><th class="col-share">広告費シェア</th><th>クリック</th><th>CV</th><th>ROAS</th></tr></thead>
        <tbody>${rows.length ? rows.map((r, i) => {
          const pct = Math.round((r.ad_cost || 0) / totalCost * 100);
          const key = r.dimension_key || r.campaign_name || "—";
          return `<tr><td class="col-l"><span class="rep-rank">${i + 1}</span><span class="dim-name">${escapeHtml(key)}</span></td><td class="col-rk">${moveBadge(key, i + 1)}</td><td>${fmtMoney(r.gms)}</td><td>${fmtMoney(r.ad_cost)}</td><td class="col-share"><div class="share-bar"><div class="share-fill" style="width:${pct}%"></div><span class="share-pct">${pct}%</span></div></td><td>${fmt(r.clicks)}</td><td>${fmt(r.cv)}</td><td><b>${fmtRoas(r.roas)}</b></td></tr>`;
        }).join("") : "<tr><td>—</td></tr>"}</tbody>
      </table>
    </section>`;
  };
  const monthlyTarget = parseFloat(localStorage.getItem("rep_target_gms")) || 0;
  const sections = [
    { id: "exec", t: "サマリー" },
    { id: "trend", t: "パフォーマンス推移" }, { id: "insight", t: "主要インサイト" },
    { id: "risk", t: "リスク警告" },
    { id: "growth", t: "成長率ランキング" },
    { id: "seg", t: "新規 vs 既存" },
    { id: "top-item", t: "TOP 商品" }, { id: "top-kw", t: "TOP キーワード" },
    { id: "item-kw", t: "商品別キーワード" },
    { id: "wkday", t: "曜日別" }, { id: "segbars", t: "新規vs既存 比較" },
    { id: "outliers", t: "特異日" },
    { id: "season", t: "前年同期 (YoY)" },
  ];
  const tocHTML = `<nav class="rep-toc no-print">
    <div class="toc-h">目次</div>
    <ul>${sections.map(s => `<li><a href="#sec-${s.id}" data-toc="${s.id}">${s.t}</a></li>`).join("")}</ul>
  </nav>`;
  $("#report-body").innerHTML = `<div class="rep-shell">${tocHTML}
    <article class="rep-doc">
      <header class="rep-cover">
        ${logo ? `<img src="${logo}" class="rep-logo" alt="logo">` : ""}
        <div class="rep-eyebrow">${localStorage.getItem("rep_subtitle") || "広告パフォーマンス・レポート"}</div>
        <h1 class="rep-title">${escapeHtml(localStorage.getItem("rep_client") || "楽天RMS 広告アナリティクス")}</h1>
        <div class="rep-meta">
          <div><span class="ml">対象期間</span><b>${period}</b></div>
          <div><span class="ml">広告種別</span><b>${f.product === "ALL" ? "全広告" : f.product}</b></div>
          <div><span class="ml">集計対象</span><b>${segL}</b></div>
          <div><span class="ml">CV計測</span><b>${(f.window || "720h") === "720h" ? "720時間" : "12時間"}</b></div>
          <div><span class="ml">作成日</span><b>${stamp}</b></div>
        </div>
        ${freshBadge || cmpBadge ? `<div class="rep-badges" style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">${freshBadge}${cmpBadge}</div>` : ""}
      </header>

      <section class="rep-sec" id="sec-exec">
        <div class="sec-head"><h3 class="rep-sub">サマリー</h3></div>
        ${R.cur.narrative ? `<div class="rep-narrative" id="rep-narrative-edit" contenteditable="true" spellcheck="false" data-default="${escapeHtml(R.cur.narrative)}">${escapeHtml(localStorage.getItem("rep_narrative_" + f.from + "_" + f.to) || R.cur.narrative)}</div>
        <div class="muted small no-print" style="margin-top:6px;display:flex;gap:8px;align-items:center">
          <span>✎ 上の文章は直接編集できます（自動保存）</span>
          <button class="ghost-btn small" id="btn-narrative-reset">自動生成に戻す</button>
        </div>` : ""}
        <div class="rep-kpis rep-kpis-5">
          ${kpi("売上 (GMS)", fmtMoney(c.gms), d.gms, "gms")}
          ${kpi("広告費", fmtMoney(c.ad_cost), d.ad_cost, "ad_cost")}
          ${kpi("クリック", fmt(c.clicks), d.clicks, "clicks", "CTR", fmtPct(c.ctr))}
          ${kpi("CV", fmt(c.cv), d.cv, "cv", "CVR", fmtPct(c.cvr))}
          ${kpi("ROAS", fmtRoas(c.roas), d.roas, "roas", "CPC", fmtMoney(c.cpc))}
        </div>
        <div class="muted small" style="margin-top:8px">増減はすべて<b>比較期間（${prevPeriod}）比</b>。</div>
      </section>

      <section class="rep-sec" id="sec-trend">
        <div class="sec-head"><h3 class="rep-sub">パフォーマンス推移</h3></div>
        <div class="rep-trend">
          <div class="rep-trend-tabs">
            <button class="rep-tab active" data-rt="gms">売上</button>
            <button class="rep-tab" data-rt="ad_cost">広告費</button>
            <button class="rep-tab" data-rt="roas">ROAS</button>
            <button class="rep-tab" data-rt="clicks">クリック</button>
          </div>
          <canvas id="rep-trend" height="220"></canvas>
        </div>
      </section>

      <section class="rep-sec" id="sec-insight">
        <div class="sec-head"><h3 class="rep-sub">主要インサイト</h3></div>
        <ul class="rep-ul">${R.cur.bullets.map(b => `<li>${b}</li>`).join("")}</ul>
        ${R.cur.actions && R.cur.actions.length ? `<div class="rep-actions"><div class="rep-ah">⚡ 推奨アクション</div><ul class="rep-ul">${R.cur.actions.map(a => `<li>${a}</li>`).join("")}</ul></div>` : ""}
      </section>

      ${riskAlertsSection(mx)}
      ${growthRankingSection(items, (prevTops || {}).item)}

      <section class="rep-sec" id="sec-seg">
        <div class="sec-head"><h3 class="rep-sub">新規 vs 既存 顧客セグメント</h3></div>
        <div class="seg-with-donut">
          <canvas id="rep-seg-donut" width="180" height="180"></canvas>
          <table class="rep-tbl" style="flex:1"><thead><tr><th class="col-l">セグメント</th><th>売上 (GMS)</th><th>広告費</th><th>クリック</th><th>CV</th><th>ROAS</th><th>CPA</th></tr></thead><tbody>
          ${[["新規顧客", insNew.current], ["既存顧客", insExist.current], ["全体", c]].map(([l, x]) => `
            <tr><td class="col-l"><b>${l}</b></td><td>${fmtMoney(x.gms)}</td><td>${fmtMoney(x.ad_cost)}</td><td>${fmt(x.clicks)}</td><td>${fmt(x.cv)}</td><td><b>${fmtRoas(x.roas)}</b></td><td>${fmtMoney(x.cpa)}</td></tr>`).join("")}
        </tbody></table></div>
        <div class="muted small" style="margin-top:6px">${insExist.current.roas && insNew.current.roas ? (insExist.current.roas > insNew.current.roas ? "既存顧客のROASが新規を上回っています — リピーター向け施策が効率的です。" : "新規顧客のROASが既存を上回っています — 新規獲得に勢いがあります。") : "—"}</div>
      </section>

      ${topT("TOP 商品", items, "商品", "sec-top-item", (prevTops || {}).item)}
      ${topT("TOP キーワード", kws, "キーワード", "sec-top-kw", (prevTops || {}).kw)}

      ${itemKeywordSection(mx)}

      ${weekdaySection(weekday)}

      ${segmentBarsSection(insNew.current, insExist.current, c)}

      ${outliersSection(outliers, series)}

      ${seasonalitySection(season)}

      <footer class="rep-footer">
        <div>${R.cur.note}</div>
        <div class="muted">楽天RMS 内部レポートAPIに基づく自動生成 ・ ${stamp}</div>
      </footer>
    </article></div>`;
  bindReportSections();
  bindReportInline(f);
  // KPI 게이지 + 도넛 + 목표선 그리기
  setTimeout(() => {
    drawTargetOnTrend(series, monthlyTarget);
    drawSegDonut(insNew.current, insExist.current);
    if (cmpEnabled && cmpData.prevSeries) drawPrevOnTrend(cmpData.prevSeries);
  }, 50);
  // 차트들 그리기
  setTimeout(() => {
    drawRepTrend(series, "gms");
    if (_prevSeriesCache) _drawPrevOverlay();
    $$("#report-body .rep-tab").forEach(b => b.onclick = () => {
      $$("#report-body .rep-tab").forEach(x => x.classList.toggle("active", x === b));
      drawRepTrend(series, b.dataset.rt);
      if (_prevSeriesCache) _drawPrevOverlay();
    });
    // 스파크라인
    $$("#report-body .rep-spark").forEach(cv => {
      const m = cv.dataset.spark;
      drawSpark(cv, series.map(s => s[m] ?? (m === "roas" ? (s.ad_cost ? s.gms / s.ad_cost : 0) : 0)));
    });
    // (광고비 비중은 표 안쪽 미니바로 통합됨)
  }, 30);
}
async function runReportCompare(f, q, pFrom, pTo) {
  const win = f.window || "720h", seg = f.segment || "all";
  try {
    const [insA, insB, sA, sB, tcA, tcB, tiA, tiB, tkA, tkB, kwDiff, catA, catB, mxA, mxB] = await Promise.all([
      api.get(`/api/kpis?${q(f.from, f.to)}&selection_type=1`),
      api.get(`/api/kpis?${q(pFrom, pTo)}&selection_type=1`),
      api.get(`/api/series?${q(f.from, f.to)}&selection_type=1`),
      api.get(`/api/series?${q(pFrom, pTo)}&selection_type=1`),
      api.get(`/api/top?${q(f.from, f.to)}&selection_type=2&order_by=ad_cost&limit=30`),
      api.get(`/api/top?${q(pFrom, pTo)}&selection_type=2&order_by=ad_cost&limit=30`),
      api.get(`/api/top?${q(f.from, f.to)}&selection_type=3&order_by=ad_cost&limit=30`),
      api.get(`/api/top?${q(pFrom, pTo)}&selection_type=3&order_by=ad_cost&limit=30`),
      api.get(`/api/top?${q(f.from, f.to)}&selection_type=4&order_by=ad_cost&limit=30`),
      api.get(`/api/top?${q(pFrom, pTo)}&selection_type=4&order_by=ad_cost&limit=30`),
      api.get(`/api/keyword_diff?${q(f.from, f.to)}&aFrom=${pFrom}&aTo=${pTo}`),
      api.get(`/api/categories?${q(f.from, f.to)}`).catch(() => ({ categories: [] })),
      api.get(`/api/categories?${q(pFrom, pTo)}`).catch(() => ({ categories: [] })),
      api.get(`/api/item_keywords?from=${f.from}&to=${f.to}&window=${win}&segment=${seg}`).catch(() => ({ items: [] })),
      api.get(`/api/item_keywords?from=${pFrom}&to=${pTo}&window=${win}&segment=${seg}`).catch(() => ({ items: [] }))]);
    LAST_REPORT = {
      mode: "compare",
      f, pFrom, pTo,
      A: insA, B: insB,
      sA: sA.series, sB: sB.series,
      tcA: tcA.rows, tcB: tcB.rows,
      tiA: tiA.rows, tiB: tiB.rows,
      tkA: tkA.rows, tkB: tkB.rows,
      kwDiff, catA, catB, mxA, mxB,
    };
    renderReportCompareNew(f, {
      A: insA, B: insB, sA: sA.series, sB: sB.series,
      camp: { A: tcA.rows, B: tcB.rows }, item: { A: tiA.rows, B: tiB.rows }, kw: { A: tkA.rows, B: tkB.rows },
      kwDiff, prevRange: { from: pFrom, to: pTo }, mxA, mxB,
      cat: { A: catA.categories || [], B: catB.categories || [] },
    });
  } catch (e) { toast("比較レポート生成に失敗: " + e.message, true); }
}

function renderReportCompareNew(f, R) {
  const cA = R.A.current, cB = R.B.current, dA = R.A.deltas;
  const logo = localStorage.getItem("rep_logo");
  const stamp = new Date().toLocaleDateString("ja-JP");
  const segL = { all: "全体", new: "新規顧客", existing: "既存顧客" }[f.segment || "all"];
  const pct = (cur, prev) => {
    if (!prev) return null;
    return Math.round((cur - prev) / Math.abs(prev) * 1000) / 10;
  };
  // 변화 다이얼 (큰 숫자) — 売上·広告費·ROAS·CV
  const dial = (label, vA, vB, fn, isAccent) => {
    const p = pct(vA, vB);
    const cls = p == null ? "flat" : (p > 0 ? "up" : (p < 0 ? "down" : "flat"));
    const ar = p == null ? "—" : (p > 0 ? "▲" : (p < 0 ? "▼" : "—"));
    return `<div class="cmp-dial ${isAccent ? "cmp-dial-accent" : ""}">
      <div class="cmp-dial-l">${label}</div>
      <div class="cmp-dial-pct cmp-${cls}">${ar} ${p == null ? "—" : Math.abs(p) + "%"}</div>
      <div class="cmp-dial-row"><span class="cmp-dial-now">${fn(vA)}</span><span class="cmp-dial-prev">比較 ${fn(vB)}</span></div>
    </div>`;
  };

  // 변화 순위 — 캠페인/상품/키워드 각각 ▲▼ 변화율 순
  const buildChangeRows = (A, B, n) => {
    const mb = {}; B.forEach(r => mb[r.dimension_key || r.campaign_name] = r);
    const ma = {}; A.forEach(r => ma[r.dimension_key || r.campaign_name] = r);
    const all = [...new Set([...Object.keys(ma), ...Object.keys(mb)])];
    const rows = all.map(k => {
      const a = ma[k] || { gms: 0, ad_cost: 0, roas: null };
      const b = mb[k] || { gms: 0, ad_cost: 0, roas: null };
      return { key: k, a, b,
        cost_delta: pct(a.ad_cost || 0, b.ad_cost || 0),
        gms_delta: pct(a.gms || 0, b.gms || 0),
        roas_delta: (a.roas && b.roas) ? pct(a.roas, b.roas) : null,
        is_new: !mb[k], is_lost: !ma[k] };
    });
    return rows;
  };
  const changeTable = (rows, label) => {
    const withImpact = rows.map(r => ({ ...r, impact: Math.abs((r.a.gms || 0) - (r.b.gms || 0)) }));
    const maxImpact = Math.max(...withImpact.map(r => r.impact), 1);
    const sorted = withImpact.slice().sort((x, y) => y.impact - x.impact);
    const top = sorted.slice(0, 8);
    return `<table class="rep-tbl rep-tbl-wide cmp-change-tbl">
      <thead><tr><th class="col-l">${label}</th><th>売上</th><th>比較 売上</th><th>売上変化</th><th>影響度</th><th>広告費変化</th><th>ROAS変化</th><th>状態</th></tr></thead>
      <tbody>${top.length ? top.map(r => {
        const dpill = v => v == null ? `<span class="rk-move rk-same">—</span>` : `<span class="rk-move ${v > 0 ? "rk-up" : "rk-down"}">${v > 0 ? "▲" : "▼"} ${Math.abs(v)}%</span>`;
        const status = r.is_new ? `<span class="rk-move rk-new">★ NEW</span>` : (r.is_lost ? `<span class="rk-move rk-down">— 消失</span>` : `<span class="rk-move rk-same">継続</span>`);
        const impPct = Math.round(r.impact / maxImpact * 100);
        const impDir = (r.a.gms || 0) >= (r.b.gms || 0) ? "up" : "down";
        return `<tr><td class="col-l"><span class="dim-name">${escapeHtml(r.key)}</span></td>
          <td>${fmtMoney(r.a.gms)}</td><td class="muted-cell">${fmtMoney(r.b.gms)}</td>
          <td>${dpill(r.gms_delta)}</td>
          <td class="col-impact"><div class="impact-bar"><div class="impact-fill ${impDir}" style="width:${impPct}%"></div><span class="impact-v">${fmtMoney(r.impact)}</span></div></td>
          <td>${dpill(r.cost_delta)}</td><td>${dpill(r.roas_delta)}</td>
          <td>${status}</td></tr>`;
      }).join("") : "<tr><td>—</td></tr>"}</tbody></table>`;
  };

  const campChanges = buildChangeRows(R.camp.A, R.camp.B);
  const itemChanges = buildChangeRows(R.item.A, R.item.B);
  const kwChanges = buildChangeRows(R.kw.A, R.kw.B);

  // 인사이트(비교 전용 자연어)
  const lines = [];
  if (dA.gms !== null) lines.push(`売上は比較期間比 <b>${dA.gms > 0 ? "▲" : "▼"} ${Math.abs(dA.gms)}%</b>（${fmtMoney(cB.gms)} → ${fmtMoney(cA.gms)}）`);
  if (dA.roas !== null) lines.push(`ROASは比較期間比 <b>${dA.roas > 0 ? "▲" : "▼"} ${Math.abs(dA.roas)}%</b>（${cB.roas ? Math.round(cB.roas * 100) : "—"}% → ${cA.roas ? Math.round(cA.roas * 100) : "—"}%）`);
  // 売上 증감 TOP 상품 (캠페인 대신 상품으로 — 사용자 캠페인 섹션 제거 요청)
  const itemSortedDown = itemChanges.filter(r => r.gms_delta != null && r.gms_delta < 0).sort((x, y) => x.gms_delta - y.gms_delta);
  const itemSortedUp = itemChanges.filter(r => r.gms_delta != null && r.gms_delta > 0).sort((x, y) => y.gms_delta - x.gms_delta);
  if (itemSortedDown[0]) lines.push(`売上が最も減少した商品: <b>${escapeHtml(itemSortedDown[0].key)}</b> ▼${Math.abs(itemSortedDown[0].gms_delta)}%`);
  if (itemSortedUp[0]) lines.push(`売上が最も増加した商品: <b>${escapeHtml(itemSortedUp[0].key)}</b> ▲${itemSortedUp[0].gms_delta}%`);

  const sections = [
    { id: "summary", t: "サマリー" }, { id: "trend", t: "期間比較推移" },
    { id: "risk-cmp", t: "リスク警告" },
    { id: "growth-cmp", t: "成長率ランキング" },
    { id: "item-change", t: "商品別 TOP" },
    { id: "kw-change", t: "キーワード別 TOP" },
    { id: "item-kw", t: "商品別キーワード" },
  ];
  const tocHTML = `<nav class="rep-toc no-print">
    <div class="toc-h">目次（比較）</div>
    <ul>${sections.map(s => `<li><a href="#sec-${s.id}" data-toc="${s.id}">${s.t}</a></li>`).join("")}</ul>
  </nav>`;

  $("#report-body").innerHTML = `<div class="rep-shell">${tocHTML}
    <article class="rep-doc rep-doc-compare-v2">
      <header class="rep-cover">
        ${logo ? `<img src="${logo}" class="rep-logo" alt="logo">` : ""}
        <div class="rep-eyebrow">期間比較レポート — 変化を見る</div>
        <h1 class="rep-title">${escapeHtml(localStorage.getItem("rep_client") || "楽天RMS 広告アナリティクス")}</h1>
        <div class="rep-meta">
          <div><span class="ml">対象期間</span><b>${f.from} 〜 ${f.to}</b></div>
          <div><span class="ml">比較期間</span><b>${R.prevRange.from} 〜 ${R.prevRange.to}</b></div>
          <div><span class="ml">広告種別</span><b>${f.product === "ALL" ? "全広告" : f.product}</b></div>
          <div><span class="ml">集計対象</span><b>${segL}</b></div>
          <div><span class="ml">作成日</span><b>${stamp}</b></div>
        </div>
      </header>

      <section class="rep-sec" id="sec-summary">
        <div class="sec-head"><h3 class="rep-sub">サマリー</h3></div>
        <div class="cmp-dials">
          ${dial("売上 (GMS)", cA.gms, cB.gms, fmtMoney, true)}
          ${dial("広告費", cA.ad_cost, cB.ad_cost, fmtMoney)}
          ${dial("ROAS", cA.roas, cB.roas, fmtRoas, true)}
          ${dial("CV", cA.cv, cB.cv, fmt)}
        </div>
        <div class="cmp-narrative-card">
          <div class="cmp-narr-h">📊 主な変化点</div>
          <ul class="rep-ul">${lines.map(l => `<li>${l}</li>`).join("")}</ul>
        </div>
      </section>

      <section class="rep-sec" id="sec-trend">
        <div class="sec-head"><h3 class="rep-sub">期間比較推移 <span class="muted small">${f.from}〜${f.to} vs ${R.prevRange.from}〜${R.prevRange.to}</span></h3>
          <div class="seg small" id="rep-cmp-metric">
            <button class="seg-btn active" data-metric="gms">売上</button>
            <button class="seg-btn" data-metric="ad_cost">広告費</button>
            <button class="seg-btn" data-metric="roas">ROAS</button>
            <button class="seg-btn" data-metric="clicks">クリック</button>
          </div>
        </div>
        <div class="chart-wrap"><canvas id="rep-cmp-overlay" height="260"></canvas></div>
      </section>

      ${riskAlertsSectionCmp(R.mxA, R.mxB)}
      ${growthRankingSectionCmp(R.item.A, R.item.B)}

      <section class="rep-sec" id="sec-item-change">
        <div class="sec-head"><h3 class="rep-sub">商品別 TOP <span class="muted small">変化幅が大きい順</span></h3></div>
        ${changeTable(itemChanges, "商品")}
      </section>

      <section class="rep-sec" id="sec-kw-change">
        <div class="sec-head"><h3 class="rep-sub">キーワード別 TOP <span class="muted small">変化幅が大きい順</span></h3></div>
        ${changeTable(kwChanges, "キーワード")}
      </section>

      ${itemKeywordCompareSection(R.mxA, R.mxB)}

      <footer class="rep-footer">
        <div>${R.A.note || ""}</div>
        <div class="muted">楽天RMS 内部レポートAPIに基づく自動生成 ・ ${stamp}</div>
      </footer>
    </article></div>`;

  bindReportSections(); bindReportInline(f);
  // 추이 오버레이 — twoSeriesChart 활용
  let cmpMet = "gms";
  const draw = () => {
    const a = R.sA.map(d => ({ x: d.report_date, y: cmpMet === "roas" ? (d.ad_cost ? d.gms / d.ad_cost : 0) : (d[cmpMet] ?? 0) }));
    const b = R.sB.map(d => ({ x: d.report_date, y: cmpMet === "roas" ? (d.ad_cost ? d.gms / d.ad_cost : 0) : (d[cmpMet] ?? 0) }));
    twoSeriesChart($("#rep-cmp-overlay"), a, b, cmpMet);
  };
  setTimeout(draw, 30);
  $$("#rep-cmp-metric .seg-btn").forEach(b => b.onclick = () => {
    cmpMet = b.dataset.metric;
    $$("#rep-cmp-metric .seg-btn").forEach(x => x.classList.toggle("active", x === b));
    draw();
  });
}
function renderReportCompare(f, R) {
  const cA = R.A.current, cB = R.B.current, dA = R.A.deltas;
  const segL = { all: "全体", new: "新規顧客", existing: "既存顧客" }[f.segment || "all"];
  const now = new Date(); const stamp = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
  const logo = localStorage.getItem("rep_logo");
  // KPI 비교 행
  const kpiRow = (label, key, fn) => {
    const va = cA[key], vb = cB[key]; let diff = "—", cls = "";
    if (typeof va === "number" && typeof vb === "number" && vb) {
      const p = Math.round((va - vb) / Math.abs(vb) * 1000) / 10;
      cls = p > 0 ? "pos" : (p < 0 ? "neg" : ""); diff = `${p > 0 ? "▲" : (p < 0 ? "▼" : "—")} ${Math.abs(p)}%`;
    }
    return `<tr><td class="col-l"><b>${label}</b></td><td class="cmp-val cmp-now">${fn(va)}</td><td class="cmp-val cmp-prev">${fn(vb)}</td><td class="${cls}">${diff}</td></tr>`;
  };
  const topRow = (rowsA, rowsB) => {
    const maxLen = Math.max(rowsA.length, rowsB.length);
    let html = "";
    for (let i = 0; i < maxLen; i++) {
      const a = rowsA[i], b = rowsB[i];
      html += `<tr>
        <td class="col-l">${a ? `<span class="rep-rank">${i + 1}</span>${escapeHtml(a.dimension_key || a.campaign_name || "—")}` : "—"}</td>
        <td>${a ? fmtMoney(a.gms) : "—"}</td><td>${a ? fmtRoas(a.roas) : "—"}</td>
        <td class="col-l">${b ? `<span class="rep-rank rep-rank-prev">${i + 1}</span>${escapeHtml(b.dimension_key || b.campaign_name || "—")}` : "—"}</td>
        <td>${b ? fmtMoney(b.gms) : "—"}</td><td>${b ? fmtRoas(b.roas) : "—"}</td>
      </tr>`;
    }
    return html;
  };
  const topT = (title, rowsA, rowsB) => `
    <section class="rep-sec" id="sec-${title.replace(/\s/g, '').toLowerCase()}">
      <div class="sec-head"><h3 class="rep-sub">${title}</h3></div>
      <table class="rep-tbl"><thead>
        <tr><th colspan="3" class="th-now">対象 (${f.from} 〜 ${f.to})</th><th colspan="3" class="th-prev">比較 (${R.prevRange.from} 〜 ${R.prevRange.to})</th></tr>
        <tr><th class="col-l">項目</th><th>売上</th><th>ROAS</th><th class="col-l">項目</th><th>売上</th><th>ROAS</th></tr>
      </thead><tbody>${topRow(rowsA, rowsB)}</tbody></table>
    </section>`;

  const sections = [{ id: "summary", t: "サマリー" }, { id: "kpis", t: "KPI比較" }, { id: "trend", t: "推移比較" },
    { id: "topキャンペーン", t: "TOPキャンペーン" }, { id: "top商品(sku)", t: "TOP商品" }, { id: "topキーワード", t: "TOPキーワード" }];
  const tocHTML = `<nav class="rep-toc no-print">
    <div class="toc-h">目次</div>
    <ul>${sections.map(s => `<li><a href="#sec-${s.id}" data-toc="${s.id}">${s.t}</a></li>`).join("")}</ul>
  </nav>`;

  $("#report-body").innerHTML = `<div class="rep-shell">${tocHTML}
    <article class="rep-doc rep-doc-compare">
      <header class="rep-cover">
        ${logo ? `<img src="${logo}" class="rep-logo" alt="logo">` : ""}
        <div class="rep-eyebrow">期間比較レポート</div>
        <h1 class="rep-title">${escapeHtml(localStorage.getItem("rep_client") || "楽天RMS 広告アナリティクス")}</h1>
        <div class="rep-meta">
          <div><span class="ml">対象期間</span><b>${f.from} 〜 ${f.to}</b></div>
          <div><span class="ml">比較期間</span><b>${R.prevRange.from} 〜 ${R.prevRange.to}</b></div>
          <div><span class="ml">広告種別</span><b>${f.product === "ALL" ? "全広告" : f.product}</b></div>
          <div><span class="ml">集計対象</span><b>${segL}</b></div>
          <div><span class="ml">作成日</span><b>${stamp}</b></div>
        </div>
      </header>

      <section class="rep-sec" id="sec-summary">
        <div class="sec-head"><h3 class="rep-sub">サマリー</h3></div>
        <div class="rep-narrative">${escapeHtml(R.A.narrative || R.A.headline)}</div>
      </section>

      <section class="rep-sec" id="sec-kpis">
        <div class="sec-head"><h3 class="rep-sub">KPI 比較</h3></div>
        <table class="rep-tbl"><thead>
          <tr><th class="col-l">指標</th><th class="th-now">対象</th><th class="th-prev">比較</th><th>変化</th></tr>
        </thead><tbody>
          ${kpiRow("売上 (GMS)", "gms", fmtMoney)}
          ${kpiRow("広告費", "ad_cost", fmtMoney)}
          ${kpiRow("クリック", "clicks", fmt)}
          ${kpiRow("CTR", "ctr", fmtPct)}
          ${kpiRow("CV", "cv", fmt)}
          ${kpiRow("CVR", "cvr", fmtPct)}
          ${kpiRow("ROAS", "roas", fmtRoas)}
          ${kpiRow("CPC", "cpc", fmtMoney)}
          ${kpiRow("CPA", "cpa", fmtMoney)}
        </tbody></table>
      </section>

      <section class="rep-sec" id="sec-trend">
        <div class="sec-head"><h3 class="rep-sub">推移 (対象 vs 比較)</h3>
          <div class="seg small" id="rep-cmp-metric">
            <button class="seg-btn active" data-metric="gms">売上</button>
            <button class="seg-btn" data-metric="ad_cost">広告費</button>
            <button class="seg-btn" data-metric="roas">ROAS</button>
            <button class="seg-btn" data-metric="clicks">クリック</button>
          </div>
        </div>
        <div class="chart-wrap"><canvas id="rep-cmp-chart" height="240"></canvas></div>
        <div class="muted small" style="margin-top:8px"><b style="color:#bf0000">━</b> 対象 ・ <b style="color:#9aa0ad">┅</b> 比較</div>
      </section>

      ${topT("TOPキャンペーン", R.tcA, R.tcB)}
      ${topT("TOP商品", R.tiA, R.tiB)}
      ${topT("TOPキーワード", R.tkA, R.tkB)}

      <footer class="rep-footer">
        <div>${R.A.note}</div>
        <div class="muted">楽天RMS 内部レポートAPIに基づく自動生成 ・ ${stamp}</div>
      </footer>
    </article></div>`;
  bindReportSections(); bindReportInline(f);
  // 추이 비교 차트
  let cmpRepMetric = "gms";
  const draw = () => {
    const a = R.sA.map(d => ({ x: d.report_date, y: d[cmpRepMetric] ?? 0 }));
    const b = R.sB.map(d => ({ x: d.report_date, y: d[cmpRepMetric] ?? 0 }));
    twoSeriesChart($("#rep-cmp-chart"), a, b, cmpRepMetric);
  };
  setTimeout(draw, 30);
  $$("#rep-cmp-metric .seg-btn").forEach(b => b.onclick = () => {
    cmpRepMetric = b.dataset.metric;
    $$("#rep-cmp-metric .seg-btn").forEach(x => x.classList.toggle("active", x === b));
    draw();
  });
}

function seasonalitySection(s) {
  if (!s || !s.has_prev) return `<section class="rep-sec" id="sec-season"><div class="sec-head"><h3 class="rep-sub">前年同期 (YoY) <span class="muted small">${s ? `(${s.prev_range.from}〜${s.prev_range.to})` : ""}</span></h3></div><p class="muted small">前年同期のデータが不足しているため、YoY比較は利用できません。</p></section>`;
  const rows = [["売上", "gms", fmtMoney], ["広告費", "ad_cost", fmtMoney], ["クリック", "clicks", fmt], ["CV", "cv", fmt], ["ROAS", "roas", fmtRoas]];
  return `<section class="rep-sec" id="sec-season">
    <div class="sec-head"><h3 class="rep-sub">前年同期 (YoY) <span class="muted small">(${s.prev_range.from}〜${s.prev_range.to})</span></h3></div>
    <table class="rep-tbl"><thead><tr><th class="col-l">指標</th><th>対象</th><th>前年同期</th><th>YoY 差</th></tr></thead><tbody>
      ${rows.map(([l, k, fn]) => {
        const y = s.yoy[k]; const cls = y > 0 ? "pos" : (y < 0 ? "neg" : "");
        const diff = y == null ? "—" : `${y > 0 ? "▲" : "▼"} ${Math.abs(y)}%`;
        return `<tr><td class="col-l">${l}</td><td>${fn(s.current[k])}</td><td>${fn(s.prev_year[k])}</td><td class="${cls}">${diff}</td></tr>`;
      }).join("")}
    </tbody></table>
  </section>`;
}
function cohortSection(c) {
  if (!c || !c.cohorts || !c.cohorts.length) return "";
  const maxOffset = Math.max(...c.cohorts.flatMap(co => co.trajectory.map(t => t.offset)));
  return `<section class="rep-sec" id="sec-cohort">
    <div class="sec-head"><h3 class="rep-sub">キーワードコホート <span class="muted small">(初登場週を基準とした週次ROAS推移)</span></h3></div>
    <table class="rep-tbl"><thead><tr><th class="col-l">初登場週</th><th>キーワード数</th>${Array.from({ length: maxOffset + 1 }, (_, i) => `<th>W${i}</th>`).join("")}</tr></thead><tbody>
      ${c.cohorts.map(co => {
        const traj = {}; co.trajectory.forEach(t => { traj[t.offset] = t; });
        return `<tr><td class="col-l">${co.entry_week}</td><td>${co.kw_count}</td>${Array.from({ length: maxOffset + 1 }, (_, i) => {
          const t = traj[i]; if (!t) return `<td class="muted">—</td>`;
          const bg = t.roas ? `background:rgba(14,163,107,${Math.min(0.5, t.roas / 10)})` : "";
          return `<td style="${bg}">${fmtRoas(t.roas)}</td>`;
        }).join("")}</tr>`;
      }).join("")}
    </tbody></table>
    <p class="muted small" style="margin-top:8px">緑が濃いほどROASが高い。新規進入キーワードの「成長 / 成熟 / 衰退」フェーズが視覚的に把握できます。</p>
  </section>`;
}
function bindReportInline(f) {
  // narrative 인라인 편집 자동저장
  const nv = document.getElementById("rep-narrative-edit");
  if (nv) {
    const key = `rep_narrative_${f.from}_${f.to}`;
    nv.addEventListener("input", () => {
      clearTimeout(nv._tm);
      nv._tm = setTimeout(() => localStorage.setItem(key, nv.innerText), 400);
    });
    const reset = document.getElementById("btn-narrative-reset");
    if (reset) reset.onclick = () => {
      localStorage.removeItem(key);
      nv.innerText = nv.dataset.default || nv.innerText;
      toast("自動生成に戻しました");
    };
  }
  // 각 섹션 헤더에 「+ メモ」 버튼만. 클릭 시 그 위치에 메모가 추가됨 (워드 스타일).
  $$(".rep-sec[id]").forEach(sec => {
    const head = sec.querySelector(".sec-head"); if (!head) return;
    if (head.querySelector(".memo-add-btn")) return;
    const id = sec.id, key = `rep_memo_${id}_${f.from}_${f.to}`;
    const saved = localStorage.getItem(key) || "";
    const btn = document.createElement("button");
    btn.className = "memo-add-btn no-print"; btn.title = "メモを追加";
    btn.innerHTML = saved ? "📝 メモ編集" : "📝 メモ追加";
    head.appendChild(btn);
    btn.onclick = () => openMemo(sec, key, btn);
    if (saved) renderMemo(sec, key, saved);
  });
}
function openMemo(sec, key, btn) {
  let m = sec.querySelector(".memo-block");
  if (!m) {
    m = document.createElement("div"); m.className = "memo-block";
    sec.appendChild(m);
  }
  const cur = localStorage.getItem(key) || "";
  m.innerHTML = `<div class="memo-edit no-print">
    <textarea class="memo-ta" placeholder="メモを入力（自動保存・PDF/印刷時に表示されます）" rows="3">${escapeHtml(cur)}</textarea>
    <div class="memo-actions">
      <button class="ghost-btn small memo-save">確定</button>
      <button class="ghost-btn small memo-cancel">キャンセル</button>
      ${cur ? `<button class="ghost-btn small memo-del" style="margin-left:auto;color:#c8312b">削除</button>` : ""}
    </div>
  </div>`;
  const ta = m.querySelector(".memo-ta"); ta.focus();
  m.querySelector(".memo-save").onclick = () => {
    const v = ta.value.trim();
    if (v) { localStorage.setItem(key, v); renderMemo(sec, key, v); btn.innerHTML = "📝 メモ編集"; }
    else { localStorage.removeItem(key); m.remove(); btn.innerHTML = "📝 メモ追加"; }
  };
  m.querySelector(".memo-cancel").onclick = () => {
    if (cur) renderMemo(sec, key, cur); else m.remove();
  };
  const del = m.querySelector(".memo-del");
  if (del) del.onclick = () => { localStorage.removeItem(key); m.remove(); btn.innerHTML = "📝 メモ追加"; };
}
function renderMemo(sec, key, text) {
  let m = sec.querySelector(".memo-block");
  if (!m) { m = document.createElement("div"); m.className = "memo-block"; sec.appendChild(m); }
  m.innerHTML = `<blockquote class="memo-view">📝 ${escapeHtml(text).replace(/\n/g, "<br>")}<button class="memo-edit-btn no-print" title="編集">✎</button></blockquote>`;
  m.querySelector(".memo-edit-btn").onclick = () => openMemo(sec, key, sec.querySelector(".memo-add-btn"));
}
function bindReportSections() {
  // 섹션 헤더 클릭으로 접기/펼치기
  $$(".rep-sec .sec-head, .rep-sec .rep-sub").forEach(h => {
    const sec = h.closest(".rep-sec"); if (!sec || sec.dataset.bound) return;
    sec.dataset.bound = "1";
    const head = sec.querySelector(".sec-head") || sec.querySelector(".rep-sub");
    if (head && !head.querySelector(".sec-toggle")) {
      const tog = document.createElement("button"); tog.className = "sec-toggle"; tog.textContent = "▼"; tog.title = "セクション折りたたみ";
      tog.onclick = e => { e.stopPropagation(); sec.classList.toggle("collapsed"); tog.textContent = sec.classList.contains("collapsed") ? "▶" : "▼"; };
      head.appendChild(tog);
    }
  });
  // TOC 클릭 — html의 scroll-padding-top이 자동으로 sticky topbar 보정
  $$(".rep-toc a[data-toc]").forEach(a => a.onclick = e => {
    e.preventDefault();
    const el = document.getElementById("sec-" + a.dataset.toc);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  // 스크롤 위치에 따라 현재 섹션 하이라이트
  const tocLinks = $$(".rep-toc a[data-toc]");
  const observer = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        const id = en.target.id.replace("sec-", "");
        tocLinks.forEach(a => a.classList.toggle("current", a.dataset.toc === id));
      }
    });
  }, { rootMargin: "-30% 0% -60% 0%" });
  $$(".rep-sec[id]").forEach(s => observer.observe(s));
}
let _prevSeriesCache = null;
function drawPrevOnTrend(prevSeries) {
  _prevSeriesCache = prevSeries; _drawPrevOverlay();
}
function _drawPrevOverlay() {
  const ps = _prevSeriesCache; if (!ps || !ps.length) return;
  const cv = $("#rep-trend"); if (!cv) return;
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const pad = { l: 64, r: 14, t: 12, b: 26 };
  // 현재 그려진 추이 메트릭은 .rep-tab.active 의 data-rt
  const activeTab = document.querySelector("#report-body .rep-tab.active");
  const metric = activeTab ? activeTab.dataset.rt : "gms";
  const get = d => metric === "roas" ? (d.ad_cost ? d.gms / d.ad_cost : 0) : (d[metric] ?? 0);
  const cur = ps.map(d => ({ y: get(d) }));
  // 현재 데이터의 maxY/minY를 다시 추정 (간단히 0..max*1.1)
  const seriesEl = document.querySelector("#report-body");
  if (!seriesEl) return;
  // 보조 차트 데이터를 화면의 y스케일에 맞추기 위해, 이미 그려진 라인 위에 추가로 그림
  const all = cur.map(d => d.y);
  const maxY = Math.max(...all) * 1.1 || 1, minY = Math.min(...all, 0);
  const px = i => pad.l + (W - pad.l - pad.r) * (cur.length === 1 ? .5 : i / (cur.length - 1));
  const py = v => pad.t + (H - pad.t - pad.b) * (1 - (v - minY) / (maxY - minY || 1));
  ctx.save();
  ctx.strokeStyle = "#9aa0ad"; ctx.lineWidth = 1.8; ctx.setLineDash([5, 4]); ctx.beginPath();
  cur.forEach((d, i) => { const X = px(i), Y = py(d.y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#9aa0ad"; ctx.font = "bold 10.5px sans-serif"; ctx.textAlign = "left";
  ctx.fillText("比較 ┅", pad.l + 4, pad.t + 14);
  ctx.restore();
}
function drawTargetOnTrend(series, target) {
  // 추이차트에 月次目標線 오버레이 (목표는 일평균으로 환산)
  if (!target || !series || !series.length) return;
  const cv = $("#rep-trend"); if (!cv) return;
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const pad = { l: 64, r: 14, t: 12, b: 26 };
  const ys = series.map(d => d.gms ?? 0);
  const maxY = Math.max(...ys) * 1.1 || 1, minY = Math.min(...ys, 0);
  const dailyTarget = target / 30;
  if (dailyTarget < minY || dailyTarget > maxY) return;
  const py = v => pad.t + (H - pad.t - pad.b) * (1 - (v - minY) / (maxY - minY || 1));
  const y = py(dailyTarget);
  ctx.save();
  ctx.setLineDash([6, 4]); ctx.strokeStyle = "#0ea36b"; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#0ea36b"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "right";
  ctx.fillText(`日次目標 ${fmtMoney(dailyTarget)}`, W - pad.r - 4, y - 5);
  ctx.restore();
}
function drawSegDonut(n, e) {
  // 신규vs기존 매출 비중 도넛
  const cv = document.getElementById("rep-seg-donut"); if (!cv) return;
  cv.width = 180; cv.height = 180;
  const ctx = cv.getContext("2d");
  const ng = n?.gms || 0, eg = e?.gms || 0, tot = ng + eg;
  const cx = cv.width / 2, cy = cv.height / 2, R = 70, r = 42;
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!tot) { ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center"; ctx.fillText("データなし", cx, cy); return; }
  const arcs = [
    { v: ng, color: "#3b4aa3", label: "新規" },
    { v: eg, color: "#bf0000", label: "既存" },
  ];
  let start = -Math.PI / 2;
  arcs.forEach(a => {
    const ang = a.v / tot * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, start, start + ang); ctx.closePath();
    ctx.fillStyle = a.color; ctx.fill();
    start += ang;
  });
  // 가운데 구멍
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
  ctx.fillStyle = "#15181e"; ctx.font = "bold 13px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("売上構成", cx, cy - 6);
  ctx.fillStyle = "#0c5a99"; ctx.font = "bold 11px sans-serif";
  ctx.fillText(`新規 ${Math.round(ng / tot * 100)}%`, cx, cy + 8);
  ctx.fillStyle = "#bf0000";
  ctx.fillText(`既存 ${Math.round(eg / tot * 100)}%`, cx, cy + 22);
}
/* ========== リスク警告 ========== */
function riskAlertsSection(mx) {
  const items = mx?.items || [];
  if (!items.length) return "";
  const risks = [];
  // 1) ROAS<100% + 광고비 ¥500↑
  items.filter(it => it.roas != null && it.roas < 1 && (it.total_cost || 0) > 500)
       .sort((a, b) => (b.total_cost || 0) - (a.total_cost || 0)).slice(0, 5)
       .forEach(it => risks.push({
         lvl: "high", title: "赤字 (ROAS < 100%)",
         target: it.item_label || "—",
         detail: `広告費 ${fmtMoney(it.total_cost)} ・ 売上 ${fmtMoney(it.total_gms)} ・ ROAS ${fmtRoas(it.roas)}`,
         action: "入札を下げる / 不採算キーワードを除外"
       }));
  // 2) CV=0 + 광고비 키워드
  const wasteKws = [];
  items.forEach(it => (it.keywords || []).forEach(k => {
    if ((k.cv || 0) === 0 && (k.ad_cost || 0) > 500) {
      wasteKws.push({ ...k, parent: it.item_label });
    }
  }));
  wasteKws.sort((a, b) => (b.ad_cost || 0) - (a.ad_cost || 0)).slice(0, 5).forEach(k => {
    risks.push({
      lvl: "high", title: "CV 0 で広告費発生",
      target: `${k.keyword || k.dimension_key || "—"} （${k.parent || ""}）`,
      detail: `広告費 ${fmtMoney(k.ad_cost)} ・ クリック ${fmt(k.clicks)} ・ CV 0`,
      action: "キーワード除外 / 入札最低化"
    });
  });
  // 3) CTR 異常低 + IMP 多 키워드
  const allKws = items.flatMap(it => (it.keywords || []).map(k => ({ ...k, parent: it.item_label })));
  allKws.filter(k => (k.impressions || 0) > 10000 && k.ctr != null && k.ctr < 0.002)
        .sort((a, b) => (b.impressions || 0) - (a.impressions || 0)).slice(0, 3)
        .forEach(k => risks.push({
          lvl: "mid", title: "CTR 異常低 (< 0.2%)",
          target: `${k.keyword || k.dimension_key || "—"} （${k.parent || ""}）`,
          detail: `IMP ${fmt(k.impressions)} ・ クリック ${fmt(k.clicks)} ・ CTR ${fmtPct(k.ctr)}`,
          action: "キーワードと商品の関連性を見直し"
        }));
  if (!risks.length) {
    return `<section class="rep-sec" id="sec-risk">
      <div class="sec-head"><h3 class="rep-sub">リスク警告</h3></div>
      <div class="risk-empty">✅ 注意が必要な項目は検出されませんでした</div>
    </section>`;
  }
  const cards = risks.map(r => `
    <div class="risk-card risk-${r.lvl}">
      <div class="risk-head">
        <span class="risk-badge">${r.lvl === "high" ? "高" : "中"}</span>
        <span class="risk-title">${escapeHtml(r.title)}</span>
      </div>
      <div class="risk-target">${escapeHtml(r.target)}</div>
      <div class="risk-detail">${r.detail}</div>
      <div class="risk-action"><b>推奨:</b> ${escapeHtml(r.action)}</div>
    </div>`).join("");
  return `<section class="rep-sec" id="sec-risk">
    <div class="sec-head"><h3 class="rep-sub">リスク警告 <span class="muted small">広告費の損失や非効率を自動検出</span></h3></div>
    <div class="risk-grid">${cards}</div>
  </section>`;
}

/* ========== 機会損失分析 ========== */
function opportunitySection(mx) {
  const items = mx?.items || [];
  const allKws = items.flatMap(it => (it.keywords || []).map(k => ({ ...k, parent: it.item_label })));
  if (!allKws.length) return "";
  // 전 키워드 평균 CVR (가중)
  const totClicks = allKws.reduce((s, k) => s + (k.clicks || 0), 0);
  const totCv = allKws.reduce((s, k) => s + (k.cv || 0), 0);
  const avgCvr = totClicks ? totCv / totClicks : 0;
  const avgAov = totCv ? allKws.reduce((s, k) => s + (k.gms || 0), 0) / totCv : 0;
  if (!avgCvr || !avgAov) return "";
  // IMP가 크고 CTR/CVR이 평균보다 낮은 키워드 = 잠재력 큰 키워드
  const opps = allKws
    .filter(k => (k.impressions || 0) > 1000 && (k.clicks || 0) > 0)
    .map(k => {
      const curCv = k.cv || 0;
      const potentialCv = (k.clicks || 0) * avgCvr;
      const gain = Math.max(0, potentialCv - curCv) * avgAov;
      return { ...k, gain };
    })
    .filter(k => k.gain > 1000)
    .sort((a, b) => b.gain - a.gain).slice(0, 8);
  if (!opps.length) return "";
  const totalGain = opps.reduce((s, k) => s + k.gain, 0);
  const rows = opps.map((k, i) => `<tr>
    <td class="col-l"><span class="ik-kw-rank">${i + 1}</span>${escapeHtml(k.keyword || k.dimension_key || "—")} <span class="muted small">（${escapeHtml(k.parent || "")}）</span></td>
    <td>${fmt(k.impressions)}</td>
    <td>${fmt(k.clicks)}</td>
    <td>${fmtPct(k.clicks ? (k.cv || 0) / k.clicks : null)}</td>
    <td><b class="opp-gain">+${fmtMoney(k.gain)}</b></td>
  </tr>`).join("");
  return `<section class="rep-sec" id="sec-opp">
    <div class="sec-head"><h3 class="rep-sub">💡 機会損失分析 <span class="muted small">CVRを全体平均(${fmtPct(avgCvr)})に引上げ時の潜在売上</span></h3></div>
    <div class="opp-headline">推定潜在売上合計 <b>+${fmtMoney(totalGain)}</b></div>
    <table class="rep-tbl"><thead><tr>
      <th class="col-l">キーワード</th><th>IMP</th><th>クリック</th><th>CVR</th><th>潜在売上</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <div class="muted small" style="margin-top:8px">※ 平均客単価 ${fmtMoney(avgAov)} × （平均CVR − 現CVR） × クリック数で算出</div>
  </section>`;
}

/* ========== 投資効率マップ ========== */
function investmentMapSection(mx) {
  const items = (mx?.items || []).filter(it => (it.total_cost || 0) > 0 && it.roas != null);
  if (items.length < 4) return "";
  const sec = `<section class="rep-sec" id="sec-map">
    <div class="sec-head"><h3 class="rep-sub">📊 投資効率マップ <span class="muted small">広告費×ROAS で各商品の位置を把握</span></h3></div>
    <div class="map-wrap"><canvas id="rep-map" height="380"></canvas></div>
    <div class="map-legend">
      <span class="ml ml-star">⭐ 主力</span><span class="muted small">高広告費・高ROAS — 維持＋強化</span>
      <span class="ml ml-grow">🌱 育成</span><span class="muted small">低広告費・高ROAS — 予算増額の余地</span>
      <span class="ml ml-review">🔧 見直し</span><span class="muted small">高広告費・低ROAS — 入札最適化必須</span>
      <span class="ml ml-watch">👀 観察</span><span class="muted small">低広告費・低ROAS — 廃止判断</span>
    </div>
  </section>`;
  setTimeout(() => drawInvestmentMap(items), 80);
  return sec;
}

function drawInvestmentMap(items, canvasId = "rep-map") {
  const cv = document.getElementById(canvasId); if (!cv) return;
  const ctx = cv.getContext("2d");
  const W = cv.width = cv.clientWidth, H = cv.height = 380;
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 70, r: 24, t: 24, b: 50 };
  const costs = items.map(it => it.total_cost || 0);
  const roases = items.map(it => Math.max(0.1, it.roas || 0.1));
  const minC = Math.min(...costs), maxC = Math.max(...costs);
  const minR = Math.min(...roases, 0.5), maxR = Math.max(...roases, 5);
  // log scale
  const logC = v => Math.log10(Math.max(1, v));
  const logR = v => Math.log10(Math.max(0.1, v));
  const xMin = logC(Math.max(1, minC)), xMax = logC(maxC || 1) + 0.1;
  const yMin = logR(minR), yMax = logR(maxR) + 0.1;
  const px = v => pad.l + (logC(v) - xMin) / (xMax - xMin) * (W - pad.l - pad.r);
  const py = v => pad.t + (1 - (logR(v) - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  // 사분면 — 중앙선 (광고비 중앙값, ROAS 200%)
  const sortedCosts = [...costs].sort((a, b) => a - b);
  const midCost = sortedCosts[Math.floor(sortedCosts.length / 2)] || 1;
  const midRoas = 2.0;
  // 배경 사분면
  const xMid = px(midCost), yMid = py(midRoas);
  ctx.fillStyle = "rgba(76,175,80,0.06)"; ctx.fillRect(pad.l, pad.t, xMid - pad.l, yMid - pad.t); // 좌상=육성
  ctx.fillStyle = "rgba(255,193,7,0.06)"; ctx.fillRect(xMid, pad.t, W - pad.r - xMid, yMid - pad.t); // 우상=주력
  ctx.fillStyle = "rgba(244,67,54,0.06)"; ctx.fillRect(xMid, yMid, W - pad.r - xMid, H - pad.b - yMid); // 우하=재검토
  ctx.fillStyle = "rgba(158,158,158,0.06)"; ctx.fillRect(pad.l, yMid, xMid - pad.l, H - pad.b - yMid); // 좌하=관찰
  // 중앙선
  ctx.strokeStyle = "#cfd5e0"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(xMid, pad.t); ctx.lineTo(xMid, H - pad.b); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pad.l, yMid); ctx.lineTo(W - pad.r, yMid); ctx.stroke();
  ctx.setLineDash([]);
  // 축
  ctx.strokeStyle = "#b8c0cc"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b); ctx.stroke();
  // 점
  const maxCostVal = maxC, maxR2 = items.reduce((m, it) => Math.max(m, it.total_gms || 0), 1);
  items.forEach(it => {
    const x = px(it.total_cost || 1), y = py(it.roas || 0.1);
    const r = 4 + Math.sqrt((it.total_gms || 0) / maxR2) * 14;
    const isStar = (it.total_cost || 0) >= midCost && (it.roas || 0) >= midRoas;
    const isGrow = (it.total_cost || 0) < midCost && (it.roas || 0) >= midRoas;
    const isReview = (it.total_cost || 0) >= midCost && (it.roas || 0) < midRoas;
    const color = isStar ? "#bf6f00" : isGrow ? "#0c7a3e" : isReview ? "#8a1c17" : "#5a6173";
    ctx.fillStyle = color + "cc";
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
    ctx.stroke();
  });
  // 라벨 (TOP3 매출만)
  const top3 = items.slice().sort((a, b) => (b.total_gms || 0) - (a.total_gms || 0)).slice(0, 3);
  ctx.fillStyle = "#15181e"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center";
  top3.forEach(it => {
    const x = px(it.total_cost || 1), y = py(it.roas || 0.1);
    const lbl = (it.item_label || "").slice(0, 16);
    ctx.fillStyle = "#fff"; ctx.fillRect(x - lbl.length * 3.5, y - 24, lbl.length * 7, 14);
    ctx.fillStyle = "#15181e"; ctx.fillText(lbl, x, y - 14);
  });
  // 축 라벨
  ctx.fillStyle = "#5a6173"; ctx.font = "11px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("広告費 →", (pad.l + W - pad.r) / 2, H - 10);
  ctx.save(); ctx.translate(20, (pad.t + H - pad.b) / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText("ROAS →", 0, 0); ctx.restore();
  // 사분면 텍스트
  ctx.font = "bold 10px sans-serif"; ctx.fillStyle = "#bf6f00";
  ctx.fillText("⭐ 主力", (xMid + W - pad.r) / 2, pad.t + 12);
  ctx.fillStyle = "#0c7a3e"; ctx.fillText("🌱 育成", (pad.l + xMid) / 2, pad.t + 12);
  ctx.fillStyle = "#8a1c17"; ctx.fillText("🔧 見直し", (xMid + W - pad.r) / 2, H - pad.b - 5);
  ctx.fillStyle = "#5a6173"; ctx.fillText("👀 観察", (pad.l + xMid) / 2, H - pad.b - 5);
}

/* ========== 成長率ランキング (일반: 期間 vs 直前 同期間) ========== */
function growthRankingSection(items, prevItems) {
  if (!items || !items.length) return "";
  const mapPrev = {};
  (prevItems || []).forEach(r => { mapPrev[r.dimension_key || ""] = r; });
  const merged = items.map(it => {
    const key = it.dimension_key || "";
    const p = mapPrev[key];
    const cur = it.gms || 0, prev = p?.gms || 0;
    const pct = prev ? Math.round((cur - prev) / Math.abs(prev) * 1000) / 10 : null;
    return { name: key, cur, prev, pct, isNew: !p };
  });
  // 진짜 성장(pct>0)/감소(pct<0)만 분류
  const ups = merged.filter(r => r.pct != null && r.pct > 0 && r.cur > 0)
                    .sort((a, b) => b.pct - a.pct).slice(0, 5);
  const downs = merged.filter(r => r.pct != null && r.pct < 0)
                      .sort((a, b) => a.pct - b.pct).slice(0, 5);
  const newItems = merged.filter(r => r.isNew && r.cur > 0).slice(0, 5);
  const renderList = (rows, lblColor) => rows.map((r, i) => `<tr>
    <td class="col-l"><span class="ik-kw-rank">${i + 1}</span>${escapeHtml(r.name)}</td>
    <td>${fmtMoney(r.cur)}</td>
    <td class="muted-cell">${fmtMoney(r.prev)}</td>
    <td><span class="rk-move ${lblColor}">${r.pct > 0 ? "▲" : "▼"} ${Math.abs(r.pct)}%</span></td>
  </tr>`).join("") || `<tr class="growth-empty"><td colspan="4">該当なし</td></tr>`;
  return `<section class="rep-sec" id="sec-growth">
    <div class="sec-head"><h3 class="rep-sub">成長率ランキング <span class="muted small">比較期間比 売上成長率 TOP/WORST</span></h3></div>
    <div class="growth-grid">
      <div class="growth-col">
        <div class="growth-h growth-h-up">▲ 成長 TOP 5</div>
        <table class="rep-tbl growth-tbl"><thead><tr><th class="col-l">商品</th><th>売上</th><th>比較</th><th>変化</th></tr></thead>
        <tbody>${renderList(ups, "rk-up")}</tbody></table>
      </div>
      <div class="growth-col">
        <div class="growth-h growth-h-down">▼ 減少 WORST 5</div>
        <table class="rep-tbl growth-tbl"><thead><tr><th class="col-l">商品</th><th>売上</th><th>比較</th><th>変化</th></tr></thead>
        <tbody>${renderList(downs, "rk-down")}</tbody></table>
      </div>
      ${newItems.length ? `<div class="growth-col">
        <div class="growth-h growth-h-new">★ 新規 ${newItems.length}</div>
        <table class="rep-tbl growth-tbl"><thead><tr><th class="col-l">商品</th><th>売上</th><th></th><th></th></tr></thead>
        <tbody>${newItems.map((r, i) => `<tr><td class="col-l"><span class="ik-kw-rank">${i + 1}</span>${escapeHtml(r.name)}</td><td>${fmtMoney(r.cur)}</td><td class="muted-cell">—</td><td><span class="rk-move rk-new">★ NEW</span></td></tr>`).join("")}</tbody></table>
      </div>` : ""}
    </div>
  </section>`;
}

function itemKeywordSection(mx) {
  const items = (mx && mx.items) || [];
  if (!items.length) return "";
  // 매출 큰 순 + 상위 15개
  const top = items.slice().sort((a, b) => (b.total_gms || 0) - (a.total_gms || 0)).slice(0, 15);
  const totalGmsAll = top.reduce((s, it) => s + (it.total_gms || 0), 0) || 1;
  const rows = top.map((it, i) => {
    const label = it.item_label || it.item_url || "—";
    const kws = (it.keywords || []).slice().sort((a, b) => (b.gms || 0) - (a.gms || 0)).slice(0, 10);
    const sharePct = Math.round((it.total_gms || 0) / totalGmsAll * 100);
    const summary = `
      <div class="ik-rank">${i + 1}</div>
      <div class="ik-main">
        <div class="ik-name">${escapeHtml(label)}</div>
        <div class="ik-meta">
          <span>KW × ${it.keyword_count || 0}</span>
          ${it.pure && it.pure.share != null ? `<span>外部漏出 ${Math.round(it.pure.share * 100)}%</span>` : ""}
        </div>
      </div>
      <div class="ik-kpi ik-kpi-main"><span class="ik-kpi-l">売上</span><span class="ik-kpi-v">${fmtMoney(it.total_gms)}</span></div>
      <div class="ik-kpi"><span class="ik-kpi-l">広告費</span><span class="ik-kpi-v">${fmtMoney(it.total_cost)}</span></div>
      <div class="ik-kpi"><span class="ik-kpi-l">ROAS</span><span class="ik-kpi-v ik-roas">${fmtRoas(it.roas)}</span></div>
      <div class="ik-share" title="期間内シェア"><div class="ik-share-bar"><div class="ik-share-fill" style="width:${sharePct}%"></div></div><span class="ik-share-pct">${sharePct}%</span></div>`;
    if (!kws.length) {
      return `<details class="ik-row"><summary>${summary}</summary>
        <div class="ik-empty muted small">紐付くキーワード広告がありません — 商品ページ直接表示のみ</div></details>`;
    }
    const kwRows = kws.map((k, ki) => `<tr>
      <td class="col-l"><span class="ik-kw-rank">${ki + 1}</span><span class="ik-kw-name">${escapeHtml(k.keyword || k.dimension_key || "—")}</span></td>
      <td>${fmtMoney(k.gms)}</td>
      <td class="muted-cell">${fmtMoney(k.ad_cost)}</td>
      <td class="muted-cell">${fmt(k.impressions)}</td>
      <td>${fmt(k.clicks)}</td>
      <td>${fmtPct(k.ctr)}</td>
      <td>${fmt(k.cv)}</td>
      <td class="ik-roas-cell"><b>${fmtRoas(k.roas)}</b></td>
    </tr>`).join("");
    return `<details class="ik-row"><summary>${summary}</summary>
      <div class="ik-body">
        <table class="rep-tbl ik-tbl"><thead><tr>
          <th class="col-l">キーワード</th><th>売上</th><th>広告費</th><th>IMP</th><th>クリック</th><th>CTR</th><th>CV</th><th>ROAS</th>
        </tr></thead><tbody>${kwRows}</tbody></table>
      </div>
    </details>`;
  }).join("");
  return `<section class="rep-sec" id="sec-item-kw">
    <div class="sec-head"><h3 class="rep-sub">商品別キーワード <span class="muted small">売上 TOP 15 ・ 商品行をクリックで展開</span></h3></div>
    <div class="ik-list">${rows}</div>
  </section>`;
}

/* ========== 기간비교 전용 4섹션 ========== */

function riskAlertsSectionCmp(mxA, mxB) {
  const itemsA = mxA?.items || [];
  const mapB = {};
  (mxB?.items || []).forEach(it => { if (it.item_url) mapB[it.item_url] = it; });
  const risks = [];
  // ROAS 급락
  itemsA.forEach(itA => {
    const itB = mapB[itA.item_url]; if (!itB) return;
    const rA = itA.roas, rB = itB.roas;
    if (rA != null && rB != null && rB >= 1 && rA < rB * 0.6 && (itA.total_cost || 0) > 1000) {
      risks.push({
        lvl: "high", title: "ROAS 急落 (40% 以上ダウン)",
        target: itA.item_label || "—",
        detail: `ROAS ${fmtRoas(rB)} → ${fmtRoas(rA)} (${Math.round((rA-rB)/rB*100)}%) ・ 広告費 ${fmtMoney(itA.total_cost)}`,
        action: "競合・入札状況を確認 / キーワード見直し"
      });
    }
  });
  // 광고비 급증
  itemsA.forEach(itA => {
    const itB = mapB[itA.item_url]; if (!itB) return;
    const cA = itA.total_cost || 0, cB = itB.total_cost || 0;
    if (cB > 0 && cA > cB * 2 && cA > 5000) {
      risks.push({
        lvl: "mid", title: "広告費 急増 (2倍以上)",
        target: itA.item_label || "—",
        detail: `広告費 ${fmtMoney(cB)} → ${fmtMoney(cA)} (+${Math.round((cA-cB)/cB*100)}%) ・ ROAS ${fmtRoas(itA.roas)}`,
        action: "ROASとの整合性を確認"
      });
    }
  });
  // 매출 급락
  itemsA.forEach(itA => {
    const itB = mapB[itA.item_url]; if (!itB) return;
    const gA = itA.total_gms || 0, gB = itB.total_gms || 0;
    if (gB > 5000 && gA < gB * 0.5) {
      risks.push({
        lvl: "high", title: "売上 半減以下",
        target: itA.item_label || "—",
        detail: `売上 ${fmtMoney(gB)} → ${fmtMoney(gA)} (${Math.round((gA-gB)/gB*100)}%)`,
        action: "在庫・露出・競合要因を確認"
      });
    }
  });
  // 신규 적자
  itemsA.forEach(itA => {
    if (!mapB[itA.item_url] && itA.roas != null && itA.roas < 1 && (itA.total_cost || 0) > 1000) {
      risks.push({
        lvl: "mid", title: "新規 + 赤字",
        target: itA.item_label || "—",
        detail: `広告費 ${fmtMoney(itA.total_cost)} ・ ROAS ${fmtRoas(itA.roas)}`,
        action: "予算配分の見直し"
      });
    }
  });
  if (!risks.length) {
    return `<section class="rep-sec" id="sec-risk-cmp">
      <div class="sec-head"><h3 class="rep-sub">リスク警告</h3></div>
      <div class="risk-empty">✅ 比較期間に対して急変リスクは検出されませんでした</div>
    </section>`;
  }
  const cards = risks.slice(0, 8).map(r => `
    <div class="risk-card risk-${r.lvl}">
      <div class="risk-head"><span class="risk-badge">${r.lvl === "high" ? "高" : "中"}</span><span class="risk-title">${escapeHtml(r.title)}</span></div>
      <div class="risk-target">${escapeHtml(r.target)}</div>
      <div class="risk-detail">${r.detail}</div>
      <div class="risk-action"><b>推奨:</b> ${escapeHtml(r.action)}</div>
    </div>`).join("");
  return `<section class="rep-sec" id="sec-risk-cmp">
    <div class="sec-head"><h3 class="rep-sub">リスク警告 <span class="muted small">比較期間との差分から急変を検出</span></h3></div>
    <div class="risk-grid">${cards}</div>
  </section>`;
}

function growthRankingSectionCmp(itemsA, itemsB) {
  if (!itemsA?.length) return "";
  const mapB = {};
  (itemsB || []).forEach(r => { mapB[r.dimension_key || ""] = r; });
  const merged = itemsA.map(it => {
    const key = it.dimension_key || "";
    const p = mapB[key];
    const cur = it.gms || 0, prev = p?.gms || 0;
    const pct = prev ? Math.round((cur - prev) / Math.abs(prev) * 1000) / 10 : null;
    return { name: key, cur, prev, pct, isNew: !p, absChange: cur - prev };
  });
  // 진짜 성장(pct>0)/감소(pct<0)만 분류
  const ups = merged.filter(r => r.pct != null && r.pct > 0 && r.cur > 0)
                    .sort((a, b) => b.pct - a.pct).slice(0, 5);
  const downs = merged.filter(r => r.pct != null && r.pct < 0)
                      .sort((a, b) => a.pct - b.pct).slice(0, 5);
  const newItems = merged.filter(r => r.isNew && r.cur > 0).sort((a,b)=>b.cur-a.cur).slice(0, 5);
  const renderItems = (rows, dir) => rows.map((r, i) => {
    const diff = r.cur - r.prev;
    const sign = diff >= 0 ? "+" : "−";
    return `<div class="gr-item" title="比較期間 ${fmtMoney(r.prev)} → ${fmtMoney(r.cur)}">
      <div class="gr-item-top">
        <span class="gr-rank">${i + 1}</span>
        <span class="gr-name">${escapeHtml(r.name)}</span>
        <span class="gr-pct gr-${dir}">${(r.pct||0) > 0 ? "▲" : "▼"} ${Math.abs(r.pct||0)}%</span>
      </div>
      <div class="gr-item-bot">
        <span class="gr-cur">${fmtMoney(r.cur)}</span>
        <span class="gr-arrow">←</span>
        <span class="gr-prev">${fmtMoney(r.prev)}</span>
        <span class="gr-diff gr-${dir}">${sign}${fmtMoney(Math.abs(diff))}</span>
      </div>
    </div>`;
  }).join("") || `<div class="gr-empty muted small">該当なし</div>`;
  const renderNew = rows => rows.map((r, i) => `<div class="gr-item gr-item-new">
    <div class="gr-item-top">
      <span class="gr-rank">${i + 1}</span>
      <span class="gr-name">${escapeHtml(r.name)}</span>
      <span class="gr-pct gr-new">★ NEW</span>
    </div>
    <div class="gr-item-bot">
      <span class="gr-cur">${fmtMoney(r.cur)}</span>
    </div>
  </div>`).join("") || `<div class="gr-empty muted small">該当なし</div>`;
  return `<section class="rep-sec" id="sec-growth-cmp">
    <div class="sec-head"><h3 class="rep-sub">成長率ランキング <span class="muted small">比較期間との売上変動</span></h3></div>
    <div class="gr-grid">
      <div class="gr-col">
        <div class="gr-h gr-h-up">成長 TOP 5</div>
        ${renderItems(ups, "up")}
      </div>
      <div class="gr-col">
        <div class="gr-h gr-h-down">減少 WORST 5</div>
        ${renderItems(downs, "down")}
      </div>
      ${newItems.length ? `<div class="gr-col">
        <div class="gr-h gr-h-new">新規 ${newItems.length}</div>
        ${renderNew(newItems)}
      </div>` : ""}
    </div>
  </section>`;
}

function investmentMapSectionCmp(mxA, mxB) {
  const items = (mxA?.items || []).filter(it => (it.total_cost || 0) > 0 && it.roas != null);
  if (items.length < 4) return "";
  setTimeout(() => drawInvestmentMap(items, "rep-map-cmp"), 80);
  return `<section class="rep-sec" id="sec-map-cmp">
    <div class="sec-head"><h3 class="rep-sub">📊 投資効率マップ <span class="muted small">対象期間の広告費×ROAS 分布</span></h3></div>
    <div class="map-wrap"><canvas id="rep-map-cmp" height="380"></canvas></div>
    <div class="map-legend">
      <span class="ml ml-star">⭐ 主力</span><span class="muted small">高広告費・高ROAS</span>
      <span class="ml ml-grow">🌱 育成</span><span class="muted small">低広告費・高ROAS</span>
      <span class="ml ml-review">🔧 見直し</span><span class="muted small">高広告費・低ROAS</span>
      <span class="ml ml-watch">👀 観察</span><span class="muted small">低広告費・低ROAS</span>
    </div>
  </section>`;
}

function itemKeywordCompareSection(mxA, mxB) {
  const itemsA = (mxA && mxA.items) || [];
  const itemsB = (mxB && mxB.items) || [];
  if (!itemsA.length && !itemsB.length) return "";
  const mapB = {};
  itemsB.forEach(it => { if (it.item_url) mapB[it.item_url] = it; });
  // A 기준 + B에만 있는 항목 추가
  const seen = new Set();
  const merged = [];
  itemsA.forEach(itA => {
    seen.add(itA.item_url);
    merged.push({ a: itA, b: mapB[itA.item_url] || null });
  });
  itemsB.forEach(itB => {
    if (!seen.has(itB.item_url)) merged.push({ a: null, b: itB });
  });
  // 今期 매출 큰 순
  merged.sort((x, y) => (y.a?.total_gms || 0) - (x.a?.total_gms || 0));
  const top = merged.slice(0, 15);
  const pct = (a, b) => (b ? Math.round((a - b) / Math.abs(b) * 1000) / 10 : null);
  const dpill = (v) => v == null ? `<span class="rk-move rk-same">—</span>`
    : v > 0 ? `<span class="rk-move rk-up">▲ ${v}%</span>`
    : v < 0 ? `<span class="rk-move rk-down">▼ ${Math.abs(v)}%</span>`
    : `<span class="rk-move rk-same">—</span>`;
  const rows = top.map((row, i) => {
    const it = row.a || row.b;
    const label = it.item_label || it.item_url || "—";
    const aG = row.a?.total_gms || 0, bG = row.b?.total_gms || 0;
    const aC = row.a?.total_cost || 0, bC = row.b?.total_cost || 0;
    const aR = row.a?.roas, bR = row.b?.roas;
    const statusTag = !row.b ? `<span class="rk-move rk-new">★ NEW</span>`
                   : !row.a ? `<span class="rk-move rk-down">— 消失</span>` : "";
    const summary = `
      <div class="ik-rank">${i + 1}</div>
      <div class="ik-main">
        <div class="ik-name">${escapeHtml(label)} ${statusTag}</div>
        <div class="ik-meta"><span>KW × ${(row.a?.keyword_count || 0)}（比較 ${row.b?.keyword_count || 0}）</span></div>
      </div>
      <div class="ik-kpi ik-kpi-main">
        <span class="ik-kpi-l">売上</span>
        <span class="ik-kpi-v">${fmtMoney(aG)}</span>
        <span class="ik-kpi-prev">比較 ${fmtMoney(bG)} ${dpill(pct(aG, bG))}</span>
      </div>
      <div class="ik-kpi">
        <span class="ik-kpi-l">広告費</span>
        <span class="ik-kpi-v">${fmtMoney(aC)}</span>
        <span class="ik-kpi-prev">比較 ${fmtMoney(bC)} ${dpill(pct(aC, bC))}</span>
      </div>
      <div class="ik-kpi">
        <span class="ik-kpi-l">ROAS</span>
        <span class="ik-kpi-v ik-roas">${fmtRoas(aR)}</span>
        <span class="ik-kpi-prev">比較 ${fmtRoas(bR)} ${dpill(aR && bR ? pct(aR, bR) : null)}</span>
      </div>`;
    // 키워드 비교 표
    const kwA = (row.a?.keywords || []);
    const kwB = (row.b?.keywords || []);
    const kwMapB = {};
    kwB.forEach(k => { kwMapB[k.keyword || k.dimension_key || ""] = k; });
    const kwSet = new Set();
    const kwMerged = [];
    kwA.forEach(k => {
      const key = k.keyword || k.dimension_key || "";
      kwSet.add(key);
      kwMerged.push({ name: key, a: k, b: kwMapB[key] || null });
    });
    kwB.forEach(k => {
      const key = k.keyword || k.dimension_key || "";
      if (!kwSet.has(key)) kwMerged.push({ name: key, a: null, b: k });
    });
    kwMerged.sort((x, y) => (y.a?.gms || 0) - (x.a?.gms || 0));
    const topKw = kwMerged.slice(0, 10);
    if (!topKw.length) {
      return `<details class="ik-row ik-row-cmp"><summary>${summary}</summary>
        <div class="ik-empty muted small">紐付くキーワード広告がありません</div></details>`;
    }
    const kwRows = topKw.map((kr, ki) => {
      const ka = kr.a, kb = kr.b;
      const aGms = ka?.gms || 0, bGms = kb?.gms || 0;
      const aCost = ka?.ad_cost || 0, bCost = kb?.ad_cost || 0;
      const aRoas = ka?.roas, bRoas = kb?.roas;
      const stTag = !kb ? `<span class="rk-move rk-new">★</span>`
                  : !ka ? `<span class="rk-move rk-down">消失</span>` : "";
      return `<tr>
        <td class="col-l"><span class="ik-kw-rank">${ki + 1}</span><span class="ik-kw-name">${escapeHtml(kr.name)}</span> ${stTag}</td>
        <td>${fmtMoney(aGms)}</td>
        <td class="muted-cell">${fmtMoney(bGms)}</td>
        <td>${dpill(pct(aGms, bGms))}</td>
        <td>${fmtMoney(aCost)}</td>
        <td>${dpill(pct(aCost, bCost))}</td>
        <td class="ik-roas-cell"><b>${fmtRoas(aRoas)}</b></td>
        <td>${dpill(aRoas && bRoas ? pct(aRoas, bRoas) : null)}</td>
      </tr>`;
    }).join("");
    return `<details class="ik-row ik-row-cmp"><summary>${summary}</summary>
      <div class="ik-body">
        <table class="rep-tbl ik-tbl"><thead><tr>
          <th class="col-l">キーワード</th>
          <th>売上</th><th>比較 売上</th><th>売上変化</th>
          <th>広告費</th><th>広告費変化</th>
          <th>ROAS</th><th>ROAS変化</th>
        </tr></thead><tbody>${kwRows}</tbody></table>
      </div>
    </details>`;
  }).join("");
  return `<section class="rep-sec" id="sec-item-kw">
    <div class="sec-head"><h3 class="rep-sub">商品別キーワード 比較 <span class="muted small">売上 TOP 15 ・ 商品行をクリックで展開</span></h3></div>
    <div class="ik-list">${rows}</div>
  </section>`;
}

function weekdaySection(wk) {
  if (!wk || !wk.length) return "";
  const maxR = Math.max(...wk.map(w => w.roas || 0));
  const maxG = Math.max(...wk.map(w => w.avg_gms || 0));
  const cell = w => {
    const rIntensity = w.roas ? w.roas / maxR : 0;
    const gIntensity = w.avg_gms ? w.avg_gms / maxG : 0;
    return `<div class="wk-cell">
      <div class="wk-d">${w.weekday}</div>
      <div class="wk-roas" style="background:rgba(14,163,107,${(rIntensity * 0.65).toFixed(2)})">
        <span class="wk-lab">ROAS</span><b>${fmtRoas(w.roas)}</b>
      </div>
      <div class="wk-gms" style="background:rgba(191,0,0,${(gIntensity * 0.5).toFixed(2)})">
        <span class="wk-lab">日均売上</span><b>${fmtMoney(w.avg_gms)}</b>
      </div>
      <div class="wk-cnt muted small">${w.days}日</div>
    </div>`;
  };
  const best = wk.filter(w => w.roas).sort((a, b) => b.roas - a.roas)[0];
  const worst = wk.filter(w => w.roas).sort((a, b) => a.roas - b.roas)[0];
  const comment = best && worst && best.weekday !== worst.weekday
    ? `効率トップは <b>${best.weekday}曜日</b>（ROAS ${fmtRoas(best.roas)}）、最低は <b>${worst.weekday}曜日</b>（${fmtRoas(worst.roas)}）。曜日別の予算配分の見直し余地があります。`
    : "";
  return `<section class="rep-sec" id="sec-wkday">
    <div class="sec-head"><h3 class="rep-sub">曜日別パフォーマンス</h3></div>
    <div class="wk-grid">${wk.map(cell).join("")}</div>
    ${comment ? `<p class="muted small" style="margin-top:10px">${comment}</p>` : ""}
  </section>`;
}
function segmentBarsSection(n, e, t) {
  if (!n || !e) return "";
  const metrics = [["ROAS", "roas", v => fmtRoas(v), v => v || 0],
                   ["売上 (GMS)", "gms", v => fmtMoney(v), v => v || 0],
                   ["CV", "cv", v => fmt(v), v => v || 0]];
  return `<section class="rep-sec" id="sec-segbars">
    <div class="sec-head"><h3 class="rep-sub">新規 vs 既存 セグメント比較</h3></div>
    <div class="seg-bars">
      ${metrics.map(([l, k, fn, val]) => {
        const newV = val(n[k]), exV = val(e[k]);
        const max = Math.max(newV, exV) || 1;
        return `<div class="sgb-row">
          <div class="sgb-lab">${l}</div>
          <div class="sgb-track">
            <div class="sgb-bar new" style="width:${(newV / max * 100).toFixed(1)}%"><span>新規 ${fn(n[k])}</span></div>
            <div class="sgb-bar ex" style="width:${(exV / max * 100).toFixed(1)}%"><span>既存 ${fn(e[k])}</span></div>
          </div>
        </div>`;
      }).join("")}
    </div>
    <p class="muted small" style="margin-top:10px">${e.roas > n.roas ? "既存顧客のROASが新規を上回っています — リピーター施策の効率が高い局面。" : "新規顧客のROASが既存を上回っています — 新規獲得が好調。"}</p>
  </section>`;
}
function outliersSection(outl, series) {
  if (!outl || !outl.length) return `<section class="rep-sec" id="sec-outliers"><div class="sec-head"><h3 class="rep-sub">特異日（外れ値）</h3></div><p class="muted small">期間内に統計的な外れ値は検出されませんでした。</p></section>`;
  const map = {}; series.forEach(s => { map[s.report_date] = s; });
  const wd = ["月", "火", "水", "木", "金", "土", "日"];
  const wdOf = d => { const [y, m, dd] = d.split("-").map(Number); return wd[new Date(y, m - 1, dd).getDay() === 0 ? 6 : new Date(y, m - 1, dd).getDay() - 1]; };
  return `<section class="rep-sec" id="sec-outliers">
    <div class="sec-head"><h3 class="rep-sub">特異日（外れ値）<span class="muted small" style="margin-left:8px">${outl.length}件検出</span></h3></div>
    <table class="rep-tbl rep-tbl-wide">
      <thead><tr><th class="col-l">日付</th><th>曜日</th><th>傾向</th><th>売上</th><th>広告費</th><th>クリック</th><th>所見</th></tr></thead>
      <tbody>${outl.map(o => {
        const s = map[o.date] || {};
        const isHi = o.kind === "high";
        const note = isHi ? "通常より<b>高い</b>売上 — 要因確認の上、再現施策の検討" : "通常より<b>低い</b>売上 — 異常検知・原因分析";
        return `<tr><td class="col-l"><b>${o.date}</b></td><td>${wdOf(o.date)}</td><td><span class="ol-pill ${isHi ? "hi" : "lo"}">${isHi ? "▲ 上振れ" : "▼ 下振れ"}</span></td><td>${fmtMoney(s.gms)}</td><td>${fmtMoney(s.ad_cost)}</td><td>${fmt(s.clicks)}</td><td>${note}</td></tr>`;
      }).join("")}</tbody>
    </table>
  </section>`;
}
function keywordDiffSection(diff) {
  if (!diff) return "";
  const list = (rows, label, cls) => rows && rows.length ? `<div class="kwd-card ${cls}">
    <div class="kwd-h"><span class="kwd-badge ${cls}">${label}</span><span class="muted small">${rows.length}件</span></div>
    <ul class="kwd-list">${rows.slice(0, 10).map(r => `<li><b>${escapeHtml(r.dimension_key)}</b><span class="muted small">広告費 ${fmtMoney(r.cost)}${r.roas != null ? ` ・ ROAS ${fmtRoas(r.roas)}` : ""}</span></li>`).join("")}</ul>
  </div>` : `<div class="kwd-card ${cls}"><div class="kwd-h"><span class="kwd-badge ${cls}">${label}</span><span class="muted small">0件</span></div><div class="muted small" style="padding:8px 4px">該当なし</div></div>`;
  return `<section class="rep-sec" id="sec-kwdiff">
    <div class="sec-head"><h3 class="rep-sub">キーワード動向 <span class="muted small">比較</span></h3></div>
    <div class="kwd-grid">
      ${list(diff.entered, "▲ 新規進入", "new")}
      ${list(diff.gone, "▼ 消失", "gone")}
    </div>
    <p class="muted small" style="margin-top:10px">継続キーワード <b>${diff.kept_count}件</b>。新規進入はテスト段階の可能性、消失は機会損失または意図的停止の確認が必要。</p>
  </section>`;
}
function drawSpark(cv, ys) {
  cv.width = cv.clientWidth || 110; cv.height = cv.clientHeight || 28;
  const ctx = cv.getContext("2d"); ctx.clearRect(0, 0, cv.width, cv.height);
  if (!ys.length) return;
  const max = Math.max(...ys, 1), min = Math.min(...ys, 0);
  const px = i => (cv.width - 2) * i / (ys.length - 1 || 1) + 1;
  const py = v => 2 + (cv.height - 4) * (1 - (v - min) / (max - min || 1));
  ctx.strokeStyle = "#bf0000"; ctx.lineWidth = 1.8; ctx.lineJoin = "round"; ctx.beginPath();
  ys.forEach((y, i) => i ? ctx.lineTo(px(i), py(y)) : ctx.moveTo(px(i), py(y))); ctx.stroke();
}
function drawRepTrend(series, metric) {
  const cv = $("#rep-trend"); if (!cv) return;
  const ctx = cv.getContext("2d");
  const W = cv.width = cv.clientWidth, H = cv.height = 220;
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 64, r: 14, t: 12, b: 26 };
  const get = d => metric === "roas" ? (d.ad_cost ? d.gms / d.ad_cost : 0) : (d[metric] ?? 0);
  const data = series.map(d => ({ x: d.report_date, y: get(d) }));
  if (!data.length) { ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center"; ctx.fillText("データなし", W / 2, H / 2); return; }
  const ys = data.map(d => d.y), maxY = Math.max(...ys) * 1.1 || 1, minY = Math.min(...ys, 0);
  const px = i => pad.l + (W - pad.l - pad.r) * (data.length === 1 ? .5 : i / (data.length - 1));
  const py = v => pad.t + (H - pad.t - pad.b) * (1 - (v - minY) / (maxY - minY || 1));
  const money = metric === "gms" || metric === "ad_cost";
  const ax = v => money ? abbr(v) : (metric === "roas" ? Math.round(v * 100) + "%" : Math.round(v).toLocaleString());
  ctx.font = "11px sans-serif"; ctx.textAlign = "right"; ctx.strokeStyle = "#eef0f3";
  for (let i = 0; i <= 4; i++) { const v = minY + (maxY - minY) * i / 4, y = py(v); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke(); ctx.fillStyle = "#9ca3af"; ctx.fillText(ax(v), pad.l - 8, y + 4); }
  // 면적
  ctx.beginPath(); data.forEach((d, i) => { const X = px(i), Y = py(d.y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
  ctx.lineTo(px(data.length - 1), H - pad.b); ctx.lineTo(px(0), H - pad.b); ctx.closePath();
  const g = ctx.createLinearGradient(0, pad.t, 0, H - pad.b); g.addColorStop(0, "rgba(191,0,0,.16)"); g.addColorStop(1, "rgba(191,0,0,0)");
  ctx.fillStyle = g; ctx.fill();
  // 라인
  ctx.strokeStyle = "#bf0000"; ctx.lineWidth = 2.2; ctx.lineJoin = "round"; ctx.beginPath();
  data.forEach((d, i) => { const X = px(i), Y = py(d.y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }); ctx.stroke();
  // 이상치 검출 (IQR 1.5x 또는 평균±2σ)
  const sorted = ys.slice().sort((a, b) => a - b);
  const Q = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const q1 = Q(0.25), q3 = Q(0.75), iqr = q3 - q1;
  const hi = q3 + iqr * 1.5, lo = q1 - iqr * 1.5;
  const fmtV = metric === "roas" ? v => Math.round(v * 100) + "%" : (metric === "gms" || metric === "ad_cost") ? v => abbr(v) : v => Math.round(v).toLocaleString();
  data.forEach((d, i) => {
    const isHi = d.y > hi, isLo = d.y < lo;
    if (!isHi && !isLo) return;
    const X = px(i), Y = py(d.y);
    ctx.beginPath(); ctx.arc(X, Y, 6, 0, 7);
    ctx.fillStyle = isHi ? "rgba(14,163,107,.18)" : "rgba(226,59,59,.18)"; ctx.fill();
    ctx.strokeStyle = isHi ? "#0ea36b" : "#e23b3b"; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.fillStyle = isHi ? "#0ea36b" : "#e23b3b"; ctx.font = "bold 10.5px sans-serif"; ctx.textAlign = "center";
    const above = Y > pad.t + 22; const ty = above ? Y - 11 : Y + 18;
    ctx.fillText(fmtV(d.y), X, ty);
  });
  // 점 + x축
  ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center"; ctx.font = "11px sans-serif";
  const step = Math.ceil(data.length / 7);
  data.forEach((d, i) => { if (i % step === 0 || i === data.length - 1) ctx.fillText(d.x.slice(5), px(i), H - 8); });
}
function drawRepBar(sel, rows, dimKey) {
  const cv = $(sel); if (!cv) return;
  cv.width = cv.clientWidth || 280; cv.height = 180;
  const ctx = cv.getContext("2d"); ctx.clearRect(0, 0, cv.width, cv.height);
  const data = rows.slice(0, 5).map(r => ({ label: r[dimKey] || r.campaign_name || "—", value: r.ad_cost || 0 }));
  if (!data.length || data[0].value === 0) { ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center"; ctx.fillText("データなし", cv.width / 2, cv.height / 2); return; }
  const total = data.reduce((a, b) => a + b.value, 0), max = Math.max(...data.map(d => d.value));
  const bh = 22, gap = 8, pad = 6;
  ctx.font = "11.5px " + getComputedStyle(document.body).fontFamily;
  data.forEach((d, i) => {
    const y = pad + i * (bh + gap), w = (cv.width - 120) * (d.value / max);
    ctx.fillStyle = "#fceaea"; ctx.fillRect(110, y, cv.width - 120, bh);
    ctx.fillStyle = "#bf0000"; ctx.fillRect(110, y, w, bh);
    ctx.fillStyle = "#15181e"; ctx.textAlign = "right"; ctx.fillText(trunc(d.label, 14), 104, y + 15);
    ctx.fillStyle = "#fff"; ctx.textAlign = "left";
    const pct = Math.round(d.value / total * 100);
    if (w > 60) ctx.fillText(`${pct}%`, 116, y + 15);
    else { ctx.fillStyle = "#15181e"; ctx.fillText(`${pct}%`, 114 + w, y + 15); }
  });
}

/* ---------------- 설정 ---------------- */
// 목표 + 임계값 통합 헬퍼
function loadGoals() {
  return JSON.parse(localStorage.getItem("rep_goals") || "{}");
}
function saveGoals(g) {
  localStorage.setItem("rep_goals", JSON.stringify(g));
}
$("#btn-save-goals")?.addEventListener("click", () => {
  const g = {
    target_gms: parseFloat($("#goal-gms").value) || null,
    target_roas: parseFloat($("#goal-roas").value) / 100 || null,
    target_cv: parseFloat($("#goal-cv").value) || null,
    target_cpa: parseFloat($("#goal-cpa").value) || null,
    thr_roas_down: parseFloat($("#thr-roas-down").value) || null,
    thr_clicks_down: parseFloat($("#thr-clicks-down").value) || null,
    thr_low_roas: parseFloat($("#thr-low-roas").value) / 100 || null,
    thr_iqr: parseFloat($("#thr-iqr").value) || null,
  };
  saveGoals(g);
  // target_gms는 기존 rep_target_gms와 동기화
  if (g.target_gms) localStorage.setItem("rep_target_gms", String(g.target_gms));
  $("#goals-msg").textContent = "✅ 保存しました";
  toast("目標と閾値を保存しました", "ok");
});
$("#btn-settings").onclick = async () => {
  $("#cfg-shop").value = STATUS.shop_id || "";
  $("#cfg-db").value = STATUS.db_path || "";
  $("#cfg-client").value = localStorage.getItem("rep_client") || "";
  $("#cfg-subtitle").value = localStorage.getItem("rep_subtitle") || "";
  $("#cfg-target-gms").value = localStorage.getItem("rep_target_gms") || "";
  // 목표/임계값 폼 로드
  const g = loadGoals();
  $("#goal-gms").value = g.target_gms || "";
  $("#goal-roas").value = g.target_roas ? Math.round(g.target_roas * 100) : "";
  $("#goal-cv").value = g.target_cv || "";
  $("#goal-cpa").value = g.target_cpa || "";
  $("#thr-roas-down").value = g.thr_roas_down || "";
  $("#thr-clicks-down").value = g.thr_clicks_down || "";
  $("#thr-low-roas").value = g.thr_low_roas ? Math.round(g.thr_low_roas * 100) : "";
  $("#thr-iqr").value = g.thr_iqr || "";
  renderLogoPreview();
  // 카테고리 매핑 로드
  try {
    const r = await api.post("/api/categories/mapping", {});
    const m = r.mapping || {};
    $("#cfg-cat").value = Object.entries(m).map(([k, v]) => `${k}=${v}`).join("\n");
  } catch (_) { $("#cfg-cat").value = ""; }
  $("#settings-modal").classList.remove("hidden");
};
$("#btn-auto-cat")?.addEventListener("click", async () => {
  $("#cfg-cat-msg").textContent = "推定中…";
  try {
    const r = await api.post("/api/categories/auto_suggest", {});
    const sug = r.suggested || {};
    // 기존 입력에 추가 (사용자 매핑 우선 유지)
    const existing = {};
    ($("#cfg-cat").value || "").split("\n").forEach(line => {
      const m = line.match(/^\s*([^=]+?)\s*=\s*(.+?)\s*$/);
      if (m) existing[m[1]] = m[2];
    });
    Object.entries(sug).forEach(([k, v]) => { if (!(k in existing)) existing[k] = v; });
    $("#cfg-cat").value = Object.entries(existing).map(([k, v]) => `${k}=${v}`).join("\n");
    $("#cfg-cat-msg").textContent = `✅ ${r.new_count}件を自動推定しました（既存マッピングは保持）。確認して保存してください。`;
  } catch (e) { $("#cfg-cat-msg").textContent = "❌ " + e.message; }
});
$("#btn-save-cat")?.addEventListener("click", async () => {
  const text = $("#cfg-cat").value || "";
  const mapping = {};
  text.split("\n").forEach(line => {
    const m = line.match(/^\s*([^=]+?)\s*=\s*(.+?)\s*$/);
    if (m) mapping[m[1]] = m[2];
  });
  try {
    const r = await api.post("/api/categories/mapping", { mapping });
    $("#cfg-cat-msg").textContent = `✅ ${Object.keys(r.mapping).length}件 保存しました`;
    toast("カテゴリマッピングを保存しました", "ok");
  } catch (e) { $("#cfg-cat-msg").textContent = "❌ " + e.message; }
});
function renderLogoPreview() {
  const d = localStorage.getItem("rep_logo");
  $("#cfg-logo-preview").innerHTML = d
    ? `<img src="${d}" style="max-height:50px;max-width:200px;object-fit:contain">`
    : `<span class="muted small">未設定</span>`;
}
$("#cfg-logo")?.addEventListener("change", e => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 500 * 1024) return toast("ロゴ画像は500KB以下にしてください", true);
  const r = new FileReader();
  r.onload = () => { localStorage.setItem("rep_logo", r.result); renderLogoPreview(); toast("ロゴを保存しました", "ok"); };
  r.readAsDataURL(f);
});
$("#btn-logo-clear")?.addEventListener("click", () => { localStorage.removeItem("rep_logo"); renderLogoPreview(); toast("ロゴを削除しました"); });
$("#btn-close-settings").onclick = () => $("#settings-modal").classList.add("hidden");
$("#settings-modal").onclick = e => { if (e.target.id === "settings-modal") $("#settings-modal").classList.add("hidden"); };
// 모달 탭 전환
$$(".modal-tab").forEach(b => b.onclick = () => {
  $$(".modal-tab").forEach(x => x.classList.toggle("active", x === b));
  $$(".modal-pane").forEach(p => p.classList.toggle("hidden", p.dataset.pane !== b.dataset.tab));
});
$("#btn-save-config").onclick = async () => {
  try {
    await api.post("/api/config", {
      shop_id: $("#cfg-shop").value.trim(), db_path: $("#cfg-db").value.trim(),
      storage_state_path: $("#cfg-state").value.trim() || undefined,
    });
    localStorage.setItem("rep_client", $("#cfg-client").value.trim());
    localStorage.setItem("rep_subtitle", $("#cfg-subtitle").value.trim());
    const tg = ($("#cfg-target-gms").value || "").replace(/[^\d.]/g, "");
    if (tg) localStorage.setItem("rep_target_gms", tg); else localStorage.removeItem("rep_target_gms");
    $("#cfg-msg").textContent = "✅ 保存しました"; toast("設定を保存しました"); loadStatus();
  } catch (e) { $("#cfg-msg").textContent = "❌ " + e.message; }
};
$("#btn-export").onclick = async () => {
  const dir = $("#cfg-export").value.trim(); if (!dir) return ($("#cfg-msg").textContent = "フォルダのパスを入力してください");
  try { const r = await api.post("/api/export", { target_dir: dir }); $("#cfg-msg").textContent = "✅ 保存: " + r.saved; }
  catch (e) { $("#cfg-msg").textContent = "❌ " + e.message; }
};

/* ---------------- 초기화 ---------------- */
$("#in-day").value = addDays(today(), -1);
$("#in-from").value = addDays(today(), -7);
$("#in-to").value = addDays(today(), -1);
// 백필 기본값: 약 4년 전 ~ 이번 달
(function () {
  const now = new Date(today());
  const ym = d => d.toISOString().slice(0, 7);
  const past = new Date(now); past.setMonth(past.getMonth() - 47);
  $("#bf-from").value = ym(past);
  $("#bf-to").value = ym(now);
})();
// 정적 날짜 입력에 커스텀 피커 부착
$$("[data-dp]").forEach(el => attachPicker(el, el.dataset.dp));
// 백필 기간 picker: 항상 「2년전 그 달 ~ 이번 달」 로 강제 (사용자가 이전 값으로 비활성 구간 들어가지 못하게)
(function setBackfillDefaults() {
  const td = new Date();
  const minYM = `${td.getFullYear() - 2}-${String(td.getMonth() + 1).padStart(2, "0")}`;
  const curYM = `${td.getFullYear()}-${String(td.getMonth() + 1).padStart(2, "0")}`;
  const from = document.getElementById("bf-from"), to = document.getElementById("bf-to");
  // 비활성 구간 / 빈값 / 미래값 모두 reset
  if (from && (!from.value || from.value < minYM || from.value > curYM)) from.value = minYM;
  if (to && (!to.value || to.value < minYM || to.value > curYM)) to.value = curYM;
})();
// 진행 중이던 백필이 있으면 복귀 시 이어서 표시
loadStatus().then(() => { loadCoverage(); pollBackfillIfRunning(); loadDashboard(); });
async function pollBackfillIfRunning() {
  try { const s = await api.get("/api/backfill/status"); if (s.running) { $("#bf-progress").classList.remove("hidden"); $("#btn-backfill").disabled = true; $("#btn-backfill-cancel").style.display = ""; pollBackfill(); } } catch (e) { }
}
