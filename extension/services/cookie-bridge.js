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
