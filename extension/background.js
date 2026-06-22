/**
 * Rakuten RMS Analytics — Background Service Worker
 * 기능:
 *  - 楽天 RMS 광고 페이지 진입 시 cookies 자동 송신 (대시보드로)
 *  - 대시보드 발 백필 트리거 → 楽天 API 직접 호출 → 결과 업로드
 *  - 현재 楽天 로그인 shop_id 자동 추출
 */

import {
  startAutoSend, sendDashboardCookies,
  collectAllRakutenCookiesFull, removeAllRakutenCookies, setBulkRakutenCookies,
  reloadAllRakutenTabs, hasRakutenTab, openRakutenTab,
} from './services/cookie-bridge.js';
import { runBackfill, getCurrentRakutenShopId } from './services/rakuten-collector.js';

console.log('[bg] Rakuten RMS Analytics 起動 v1.0.0');
startAutoSend();
console.log('[bg] 📡 Cookie 自動送信 ON');

// 백필 진행률 push
const _backfillProgressByTask = new Map();
const _backfillSubscribers = new Map();

function _pushProgress(taskId, info) {
  _backfillProgressByTask.set(taskId, info);
  const tabs = _backfillSubscribers.get(taskId);
  if (tabs) {
    for (const tabId of tabs) {
      chrome.tabs.sendMessage(tabId, { type: 'BACKFILL_PROGRESS', taskId, ...info })
        .catch(() => {});
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // Cookie 수동 송신 (popup → background)
  if (msg.type === 'SEND_COOKIES') {
    sendDashboardCookies()
      .then(r => sendResponse({ ok: true, ...r }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // 대시보드 → background: URL/JWT 동기화
  if (msg.type === 'DASHBOARD_CONFIG') {
    chrome.storage.local.set({
      dashboardServer: msg.dashboardServer,
      extensionToken: msg.extensionToken,
    }, () => sendResponse({ ok: true }));
    return true;
  }

  // 백필 시작
  if (msg.type === 'START_BACKFILL') {
    const task = {
      taskId: msg.taskId || ('bf_' + Date.now()),
      shop_id: msg.shop_id,
      from: msg.from,
      to: msg.to,
      sels: msg.sels,
      vercelUrl: msg.vercelUrl,
      jwt: msg.jwt,
    };
    if (sender.tab?.id) {
      if (!_backfillSubscribers.has(task.taskId)) {
        _backfillSubscribers.set(task.taskId, new Set());
      }
      _backfillSubscribers.get(task.taskId).add(sender.tab.id);
    }
    runBackfill(task, (info) => _pushProgress(task.taskId, info))
      .then(result => _pushProgress(task.taskId, { done: true, current: '完了', ...result }))
      .catch(err => _pushProgress(task.taskId, { done: true, error: String(err) }));
    sendResponse({ ok: true, taskId: task.taskId });
    return true;
  }

  if (msg.type === 'GET_BACKFILL_PROGRESS') {
    sendResponse(_backfillProgressByTask.get(msg.taskId) || null);
    return false;
  }

  if (msg.type === 'GET_RAKUTEN_SHOP_ID') {
    getCurrentRakutenShopId()
      .then(shopId => sendResponse({ shopId }))
      .catch(() => sendResponse({ shopId: null }));
    return true;
  }

  // ── 멤버 전환을 위한 楽天 cookie 백업 / 복원 / 삭제 ──
  if (msg.type === 'GET_RAKUTEN_COOKIES_FULL') {
    collectAllRakutenCookiesFull()
      .then(async cookies => {
        const shopId = await getCurrentRakutenShopId().catch(() => null);
        sendResponse({ ok: true, cookies, shopId });
      })
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'SET_RAKUTEN_COOKIES') {
    setBulkRakutenCookies(msg.cookies || [])
      .then(r => sendResponse({ ok: true, ...r }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'CLEAR_RAKUTEN_COOKIES') {
    removeAllRakutenCookies()
      .then(n => sendResponse({ ok: true, removed: n }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'RELOAD_RAKUTEN_TABS') {
    reloadAllRakutenTabs()
      .then(n => sendResponse({ ok: true, reloaded: n }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'OPEN_RAKUTEN_TAB') {
    openRakutenTab()
      .then(id => sendResponse({ ok: true, tabId: id }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'HAS_RAKUTEN_TAB') {
    hasRakutenTab()
      .then(yes => sendResponse({ ok: true, hasTab: yes }))
      .catch(() => sendResponse({ ok: true, hasTab: false }));
    return true;
  }
});
