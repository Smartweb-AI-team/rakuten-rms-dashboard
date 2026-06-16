// 楽天 RMS 광고는 経路마다 Path=/rpp, /cpa, /tda 로 XSRF-TOKEN 가 따로
// → 経路別 URL 로 getAll. domain 전체 긁으면 Cookie 헤더 10KB↑ → WAF 400
const SERVER = "http://127.0.0.1:8765/api/session";
const URLS = [
  "https://ad.rms.rakuten.co.jp/",
  "https://ad.rms.rakuten.co.jp/rpp/",
  "https://ad.rms.rakuten.co.jp/cpa/",
  "https://ad.rms.rakuten.co.jp/tda/",
  "https://ad.rms.rakuten.co.jp/shared/",
];
const DEBOUNCE_MS = 60 * 1000; // 1分

async function collectCookies() {
  const byKey = {};
  for (const url of URLS) {
    for (const c of await chrome.cookies.getAll({ url })) {
      byKey[c.name + "\n" + c.path] = {
        name: c.name, value: c.value, path: c.path, domain: c.domain,
      };
    }
  }
  return Object.values(byKey);
}

async function sendCookies() {
  const cookieList = await collectCookies();
  const xsrfPaths = cookieList.filter(c => c.name === "XSRF-TOKEN").map(c => c.path);
  const res = await fetch(SERVER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cookieList }),
  });
  const data = await res.json();
  return { count: cookieList.length, hasXsrf: xsrfPaths.length > 0, xsrfPaths, server: data };
}

function setBadge(ok, count) {
  if (ok) {
    chrome.action.setBadgeText({ text: String(count > 99 ? "99+" : count) });
    chrome.action.setBadgeBackgroundColor({ color: "#0c7a3e" });
    chrome.action.setTitle({ title: `Cookie送信OK (${count}件) - ${new Date().toLocaleTimeString("ja-JP")}` });
  } else {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#bf0000" });
    chrome.action.setTitle({ title: "Cookie送信失敗 - サーバ確認" });
  }
}

// 팝업에서 호출
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SEND_COOKIES") {
    sendCookies()
      .then(r => { setBadge(true, r.count); sendResponse({ ok: true, ...r }); })
      .catch(e => { setBadge(false); sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
});

let lastAutoSend = 0;
async function autoSend(reason) {
  const now = Date.now();
  if (now - lastAutoSend < DEBOUNCE_MS) return;
  lastAutoSend = now;
  try {
    const r = await sendCookies();
    setBadge(true, r.count);
    console.log(`[auto-send:${reason}] OK ${r.count} cookies`);
  } catch (e) {
    setBadge(false);
    console.warn(`[auto-send:${reason}] failed:`, e);
  }
}

// ① 페이지 이동 / 새 탭에서 RMS광고 열기
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const url = tab.url || "";
  if (!url.startsWith("https://ad.rms.rakuten.co.jp/")) return;
  autoSend("tab-update");
});

// ② SW 起動時 (브라우저 재시작/확장 리로드) 이미 열린 RMS탭 있으면 즉시 송신
(async () => {
  const tabs = await chrome.tabs.query({ url: "https://ad.rms.rakuten.co.jp/*" });
  if (tabs.length > 0) autoSend("startup");
})();

// ③ 탭 전환 시에도 확인 (5분 이상 지났으면 갱신)
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if ((tab.url || "").startsWith("https://ad.rms.rakuten.co.jp/")) {
      autoSend("tab-activate");
    }
  } catch (_) { /* ignore */ }
});
