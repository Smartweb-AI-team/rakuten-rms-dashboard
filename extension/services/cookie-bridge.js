/**
 * Cookie Bridge — 楽天 RMS Cookie をローカル広告ダッシュボードに送信
 *  - 経路別 (/rpp, /cpa, /tda) で XSRF-TOKEN が異なる → URL ごとに getAll
 *  - getAll({domain}) で全部取ると Cookie ヘッダが 10KB↑ → 楽天 WAF 400
 */

const DEFAULT_SERVER = 'http://127.0.0.1:8765';
async function getDashboardEndpoint() {
  const s = await chrome.storage.local.get(['dashboardServer', 'extensionToken']);
  const base = (s.dashboardServer || DEFAULT_SERVER).replace(/\/$/, '');
  return { url: base + '/api/session', token: s.extensionToken || '' };
}
// 경로별 XSRF-TOKEN 보존용 (path 가 /rpp, /cpa, /tda 로 따로 발급됨)
const PATH_URLS = [
  'https://ad.rms.rakuten.co.jp/',
  'https://ad.rms.rakuten.co.jp/rpp/',
  'https://ad.rms.rakuten.co.jp/cpa/',
  'https://ad.rms.rakuten.co.jp/tda/',
  'https://ad.rms.rakuten.co.jp/shared/',
];
// 추가로 도메인 전체 (로그인/세션 쿠키 등)
const DOMAINS = [
  '.rakuten.co.jp',
  'ad.rms.rakuten.co.jp',
  'rms.rakuten.co.jp',
  'login.rakuten.co.jp',
];
const DEBOUNCE_MS = 60 * 1000;

async function collectCookies() {
  const byKey = {};
  // ① 경로별 (XSRF-TOKEN per path 보존)
  for (const url of PATH_URLS) {
    for (const c of await chrome.cookies.getAll({ url })) {
      byKey[c.name + '\n' + c.path] = {
        name: c.name, value: c.value, path: c.path, domain: c.domain,
      };
    }
  }
  // ② 도메인 전체 (로그인/세션 쿠키 등 보충)
  for (const domain of DOMAINS) {
    for (const c of await chrome.cookies.getAll({ domain })) {
      const k = c.name + '\n' + c.path;
      if (!byKey[k]) {
        byKey[k] = { name: c.name, value: c.value, path: c.path, domain: c.domain };
      }
    }
  }
  return Object.values(byKey);
}

export async function sendDashboardCookies() {
  const cookieList = await collectCookies();
  const xsrfPaths = cookieList.filter(c => c.name === 'XSRF-TOKEN').map(c => c.path);
  const ep = await getDashboardEndpoint();
  const headers = { 'Content-Type': 'application/json' };
  if (ep.token) headers['Authorization'] = 'Bearer ' + ep.token;
  const res = await fetch(ep.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cookieList }),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) {
    const msg = data.detail || data.error || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return { count: cookieList.length, hasXsrf: xsrfPaths.length > 0, xsrfPaths, server: data, endpoint: ep.url };
}

function setBadge(ok, count) {
  if (ok) {
    chrome.action.setBadgeText({ text: String(count > 99 ? '99+' : count) });
    chrome.action.setBadgeBackgroundColor({ color: '#0c7a3e' });
    chrome.action.setTitle({ title: `Cookie送信OK (${count}件) - ${new Date().toLocaleTimeString('ja-JP')}` });
  } else {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#bf0000' });
    chrome.action.setTitle({ title: 'Cookie送信失敗 - サーバ確認' });
  }
}

let lastAutoSend = 0;
async function autoSend(reason) {
  const now = Date.now();
  if (now - lastAutoSend < DEBOUNCE_MS) return;
  lastAutoSend = now;
  try {
    const r = await sendDashboardCookies();
    setBadge(true, r.count);
    console.log(`[cookie-bridge:${reason}] OK ${r.count} cookies`);
  } catch (e) {
    setBadge(false);
    console.warn(`[cookie-bridge:${reason}] failed:`, e);
  }
}

// ============================================================
// 멤버 전환을 위한 楽天 Cookie 저장/복원/삭제 (옛 rpp-bridge-extension 의 utils/cookie.js 이식)
// ============================================================
const RAKUTEN_COOKIE_DOMAIN = '.rakuten.co.jp';

// 전체 楽天 cookie 수집 (storeId 포함, 복원 가능 형태)
export async function collectAllRakutenCookiesFull() {
  const all = await chrome.cookies.getAll({ domain: RAKUTEN_COOKIE_DOMAIN });
  const extra = await Promise.all(PATH_URLS.map(url => chrome.cookies.getAll({ url })));
  // 중복 제거 (name + domain + path 키)
  const map = new Map();
  [all, ...extra].flat().forEach(c => {
    if (!(c.domain || '').includes('rakuten.co.jp')) return;
    map.set(`${c.name}|${c.domain}|${c.path}`, c);
  });
  return Array.from(map.values());
}

// 전체 楽天 cookie 삭제 (로그아웃 시)
export async function removeAllRakutenCookies() {
  const all = await chrome.cookies.getAll({ domain: RAKUTEN_COOKIE_DOMAIN });
  let removed = 0;
  for (const c of all) {
    const dom = c.domain.startsWith('.') ? c.domain.substring(1) : c.domain;
    const url = `https://${dom}${c.path}`;
    try {
      await chrome.cookies.remove({ url, name: c.name });
      removed++;
    } catch (e) {
      console.warn(`[cookie-bridge] 削除失敗 ${c.name}:`, e);
    }
  }
  console.log(`[cookie-bridge] removed ${removed} rakuten cookies`);
  return removed;
}

// 단일 cookie 설정 (chrome.cookies.set)
async function setOneCookie(cookie) {
  try {
    const dom = (cookie.domain || '').startsWith('.')
      ? cookie.domain.substring(1) : cookie.domain;
    const url = `https://${dom}${cookie.path || '/'}`;
    const param = {
      url,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      httpOnly: !!cookie.httpOnly,
      sameSite: 'no_restriction',
    };
    if (cookie.storeId) param.storeId = cookie.storeId;
    if (!cookie.hostOnly && cookie.domain) param.domain = cookie.domain;
    if (cookie.expirationDate) {
      const now = Date.now() / 1000;
      param.expirationDate = cookie.expirationDate > now
        ? cookie.expirationDate : now + 86400;
    }
    await chrome.cookies.set(param);
    return true;
  } catch (e) {
    console.warn(`[cookie-bridge] set失敗 ${cookie.name}:`, e);
    return false;
  }
}

// 모든 楽天 탭 강제 새로고침 (bypassCache) — cookie 변경 후 화면 갱신용
export async function reloadAllRakutenTabs() {
  const tabs = await chrome.tabs.query({ url: '*://*.rakuten.co.jp/*' });
  let reloaded = 0;
  for (const tab of tabs) {
    try {
      await chrome.tabs.reload(tab.id, { bypassCache: true });
      reloaded++;
    } catch (e) {
      console.warn(`[cookie-bridge] reload失敗 tab ${tab.id}:`, e);
    }
  }
  console.log(`[cookie-bridge] reloaded ${reloaded} rakuten tabs`);
  return reloaded;
}

// 楽天 RMS 탭이 1개라도 열려있는지
export async function hasRakutenTab() {
  const tabs = await chrome.tabs.query({ url: 'https://ad.rms.rakuten.co.jp/*' });
  return tabs.length > 0;
}

// 楽天 RMS RPP 페이지 열기 — 기존 탭 있으면 active + reload, 없으면 새 탭 (active=true)
export async function openRakutenTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://ad.rms.rakuten.co.jp/*' });
    if (tabs.length > 0) {
      const t = tabs[0];
      await chrome.tabs.update(t.id, { active: true });
      if (t.windowId != null) {
        try { await chrome.windows.update(t.windowId, { focused: true }); } catch {}
      }
      await chrome.tabs.reload(t.id, { bypassCache: true });
      console.log('[cookie-bridge] reused existing RMS tab', t.id);
      return t.id;
    }
    const newTab = await chrome.tabs.create({
      url: 'https://ad.rms.rakuten.co.jp/rpp/',
      active: true,
    });
    console.log('[cookie-bridge] opened new RMS tab', newTab.id);
    return newTab.id;
  } catch (e) {
    console.error('[cookie-bridge] openRakutenTab failed:', e);
    throw e;
  }
}

// cookie 변경 감지 → dashboard-bridge 가 polling 으로 가져가지만 즉시 알림하려면 이 함수 사용.
// chrome.cookies.onChanged 리스너에서 호출 가능.
let _cookieChangeListenerOn = false;
export function startCookieChangeWatcher() {
  if (_cookieChangeListenerOn) return;
  _cookieChangeListenerOn = true;
  chrome.cookies.onChanged.addListener((info) => {
    if (!info.cookie || !info.cookie.domain) return;
    if (!info.cookie.domain.includes('rakuten.co.jp')) return;
    // 'shop' cookie 변경 시 = 楽天 로그인/로그아웃/계정 전환 → 모든 RMS 탭에 알림
    if (info.cookie.name === 'shop' || info.cookie.name === 'XSRF-TOKEN') {
      console.log(`[cookie-bridge] rakuten cookie ${info.removed ? 'removed' : 'set'}: ${info.cookie.name}`);
      // background 가 모든 우리 앱 탭에 'cookie-changed' 이벤트 broadcast
      _broadcastRakutenCookieChange().catch(() => {});
    }
  });
}
async function _broadcastRakutenCookieChange() {
  // 모든 우리 앱 탭 (dashboard-bridge 가 로드된) 에 메시지 전송
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    const url = t.url || '';
    if (url.includes('vercel.app') || url.includes('localhost') || url.includes('127.0.0.1')) {
      try { await chrome.tabs.sendMessage(t.id, { type: 'RAKUTEN_COOKIE_CHANGED' }); } catch {}
    }
  }
}

// 다수 cookie 일괄 복원
export async function setBulkRakutenCookies(cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return { success: 0, failed: 0 };
  let success = 0, failed = 0;
  for (const c of cookies) {
    if (await setOneCookie(c)) success++;
    else failed++;
  }
  console.log(`[cookie-bridge] restored ${success}/${cookies.length} (failed: ${failed})`);
  return { success, failed };
}

export function startAutoSend() {
  // ① 페이지 이동
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!(tab.url || '').startsWith('https://ad.rms.rakuten.co.jp/')) return;
    autoSend('tab-update');
  });

  // ② SW 起動時 이미 열린 RMS 탭 있으면 즉시
  (async () => {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://ad.rms.rakuten.co.jp/*' });
      if (tabs.length > 0) autoSend('startup');
    } catch (_) { /* ignore */ }
  })();

  // ③ 탭 전환
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if ((tab.url || '').startsWith('https://ad.rms.rakuten.co.jp/')) {
        autoSend('tab-activate');
      }
    } catch (_) { /* ignore */ }
  });
}
