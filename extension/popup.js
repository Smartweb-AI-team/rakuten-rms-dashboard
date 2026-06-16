const msg = document.getElementById("msg");
document.getElementById("send").onclick = () => {
  msg.textContent = "送信中…"; msg.className = "";
  chrome.runtime.sendMessage({ type: "SEND_COOKIES" }, (r) => {
    if (!r) { msg.textContent = "❌ バックグラウンド応答なし"; msg.className = "err"; return; }
    if (!r.ok) { msg.textContent = "❌ " + r.error; msg.className = "err"; return; }
    const s = r.server || {};
    if (s.ok) {
      msg.className = "ok";
      msg.textContent = `✅ 送信完了\nCookie ${r.count}件 · XSRFパス [${(r.xsrfPaths || []).join(", ") || "なし"}]\nセッション: ${s.msg}`;
    } else {
      msg.className = "err";
      msg.textContent = `⚠ サーバー応答: ${s.msg || JSON.stringify(s)}\n(Cookie ${r.count}件, XSRF ${r.hasXsrf ? "あり" : "なし"})`;
    }
  });
};
