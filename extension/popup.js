// popup.js — chrome.storage 의 dashboardServer/extensionToken 상태 표시 + 수동 송신
function refresh() {
  chrome.storage.local.get(['dashboardServer', 'extensionToken'], (s) => {
    const url = s.dashboardServer || '';
    const tok = s.extensionToken || '';
    const urlEl = document.getElementById('cfgUrlDisplay');
    const authEl = document.getElementById('cfgAuthStatus');
    const hint = document.getElementById('setupHint');
    if (url) {
      urlEl.textContent = url;
      urlEl.classList.remove('empty');
    } else {
      urlEl.textContent = '未接続';
      urlEl.classList.add('empty');
    }
    if (tok) {
      authEl.textContent = '✓ ログイン済み (' + tok.slice(0, 10) + '…)';
      authEl.style.color = '#0c7a3e';
      hint.textContent = '';
    } else {
      authEl.textContent = '未ログイン';
      authEl.style.color = '#bf0000';
      hint.textContent = url
        ? '→ ダッシュボードでログインしてください'
        : '→ まずダッシュボードを開いてください';
    }
  });
}
refresh();
chrome.storage.onChanged.addListener(refresh);

document.getElementById('btnSendNow').addEventListener('click', () => {
  const el = document.getElementById('sendResult');
  el.textContent = '送信中…';
  el.className = 'status';
  chrome.runtime.sendMessage({ type: 'SEND_COOKIES' }, (r) => {
    if (!r) { el.textContent = '⚠ SW無応答'; el.className = 'status err'; return; }
    if (r.ok) {
      el.textContent = `✓ ${r.count}件 / XSRF: ${r.hasXsrf ? 'OK' : 'なし'}`;
      el.className = 'status ok';
    } else {
      el.textContent = '⚠ ' + (r.error || '失敗');
      el.className = 'status err';
    }
  });
});
