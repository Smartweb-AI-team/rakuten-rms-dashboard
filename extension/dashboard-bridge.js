/**
 * dashboard-bridge.js — 대시보드 페이지에서 실행되는 Content Script
 *
 * 동작:
 *  - 페이지 origin 을 「dashboardServer」 로 자동 저장
 *  - localStorage 의 `sb_access_token` (Supabase JWT) 을 「extensionToken」 으로 저장
 *  - 5초마다 갱신 (JWT 만료 시 대시보드가 자동 refresh 한 새 토큰 따라감)
 *
 * 결과: 멤버는 대시보드 로그인 한 번이면 확장이 알아서 URL/토큰 다 압니다.
 */
(() => {
  // 우리 대시보드만 (다른 vercel/localhost 앱은 건들지 않음)
  // 마커: <meta name="rakuten-rms-dashboard" content="1"> 가 있어야 동작
  if (!document.querySelector('meta[name="rakuten-rms-dashboard"]')) {
    return;  // 다른 사이트면 즉시 종료 — postMessage / sync 모두 안 함
  }
  console.log('[dashboard-bridge] loaded on', window.location.origin);

  // 대시보드 페이지가 보내는 message 를 background 로 forward
  // (대시보드 JS 는 chrome.runtime 못 부르니까 postMessage 다리)
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;
    if (e.data.__rpp_bridge !== 'request') return;
    chrome.runtime.sendMessage(e.data.payload, (response) => {
      window.postMessage({
        __rpp_bridge: 'response',
        reqId: e.data.reqId,
        response,
        error: chrome.runtime.lastError?.message,
      }, '*');
    });
  });

  // background 의 push (BACKFILL_PROGRESS) → 대시보드로 전달
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'BACKFILL_PROGRESS') {
      window.postMessage({ __rpp_bridge: 'event', payload: msg }, '*');
    }
  });

  // 대시보드 페이지에 확장이 설치되어 있음을 알림
  window.postMessage({ __rpp_bridge: 'ready', extensionId: chrome.runtime.id }, '*');

  let lastSync = '';

  function syncToExtension() {
    try {
      const url = window.location.origin;
      const jwt = localStorage.getItem('sb_access_token') || '';
      const key = url + '|' + jwt.slice(-20);
      if (key === lastSync) return;
      lastSync = key;

      // JWT 없어도 URL 은 동기화 (로컬 서버 등 인증 없는 환경 대응)
      chrome.runtime.sendMessage({
        type: 'DASHBOARD_CONFIG',
        dashboardServer: url,
        extensionToken: jwt,
      }, (r) => {
        console.log('[dashboard-bridge] sync →', url, 'jwt:', jwt ? jwt.slice(0, 12) + '…' : '(none)', r);
      });
      // 현재 楽天 shop_id 도 페이지에 알림
      chrome.runtime.sendMessage({ type: 'GET_RAKUTEN_SHOP_ID' }, (resp) => {
        if (resp && resp.shopId) {
          window.postMessage({ __rpp_bridge: 'event',
            payload: { type: 'RAKUTEN_SHOP_ID', shopId: resp.shopId } }, '*');
        }
      });
    } catch (e) {
      console.warn('[dashboard-bridge] error:', e);
    }
  }

  syncToExtension();
  setInterval(syncToExtension, 5000);
  window.addEventListener('storage', (e) => {
    if (e.key === 'sb_access_token') syncToExtension();
  });
})();
