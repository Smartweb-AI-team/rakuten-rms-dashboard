/**
 * rakuten-collector.js
 * 楽天 RMS 광고 데이터 수집 (브라우저 워커).
 *
 * 책임:
 *  - 楽天 API 호출 (downloadAsync, list, downloadCsv, search)
 *  - 응답 (ZIP/JSON) 을 Vercel /api/ingest 에 그대로 업로드
 *  - 진행률 callback
 *
 * 비책임 (Vercel 측):
 *  - CSV 파싱 (cp932)
 *  - normalize (rows 변환)
 *  - DB upsert
 */

const BASE = 'https://ad.rms.rakuten.co.jp';

// ---------- shop_id 자동 감지 ----------
// 楽天 RMS 의 `shop` 쿠키 = base64('<shopId>&...&<ts>')
export async function getCurrentRakutenShopId() {
  const c = await chrome.cookies.get({ url: 'https://ad.rms.rakuten.co.jp/', name: 'shop' });
  if (!c || !c.value) return null;
  try {
    const decoded = atob(c.value);
    return decoded.split('&')[0] || null;
  } catch (_) {
    return null;
  }
}

// ---------- XSRF 자동 갱신 ----------
let xsrfByPath = {};

async function getXsrfCookies() {
  // 楽天 cookies 에서 XSRF-TOKEN 모두 path별 캐싱
  const cookies = await chrome.cookies.getAll({ domain: '.rakuten.co.jp' });
  for (const c of cookies) {
    if (c.name === 'XSRF-TOKEN') {
      xsrfByPath[c.path || '/'] = c.value;
    }
  }
}

function getXsrfForPath(reqPath) {
  // 가장 긴 prefix 매칭
  let best = null, bestLen = -1;
  for (const [p, v] of Object.entries(xsrfByPath)) {
    if (reqPath.startsWith(p) && p.length > bestLen) {
      best = v; bestLen = p.length;
    }
  }
  return best || Object.values(xsrfByPath)[0] || '';
}

// ---------- HTTP helpers ----------
// 楽天 가 Origin 검증 → background fetch 의 chrome-extension:// origin 거부.
// 해결: chrome.scripting 으로 ad.rms.rakuten.co.jp 탭 안에서 fetch 실행
// (Origin = https://ad.rms.rakuten.co.jp 가 됨)
async function findRakutenTab() {
  const tabs = await chrome.tabs.query({ url: 'https://ad.rms.rakuten.co.jp/*' });
  if (!tabs.length) {
    throw new Error('楽天 RMS タブが開いていません — RMS広告ページを開いてから再実行してください');
  }
  return tabs[0];
}

async function _execFetchInTab(tab, url, opts) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [url, opts],
    func: async (url, opts) => {
      // page context 의 document.cookie 에서 XSRF 추출 (path-specific 최우선 매칭)
      const m = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
      const xsrf = m ? decodeURIComponent(m[1]) : '';
      const headers = {
        'Accept': 'application/json',
        'X-XSRF-TOKEN': xsrf,
        ...(opts.headers || {}),
      };
      if (opts.method === 'POST' || opts.body) {
        headers['Content-Type'] = 'application/json';
      }
      const r = await fetch(url, { method: opts.method || 'GET',
                                    headers, body: opts.body, credentials: 'include' });
      const ct = r.headers.get('content-type') || '';
      const out = { status: r.status, ok: r.ok, contentType: ct, xsrfUsed: xsrf.slice(0,12) };
      if (opts.responseType === 'arrayBuffer' || ct.includes('octet-stream') || ct.includes('zip')) {
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        out.bodyB64 = btoa(bin);
      } else {
        out.bodyText = await r.text();
      }
      return out;
    },
    world: 'MAIN',
  });
  return result;
}

async function rakutenFetchInTab(path, opts = {}) {
  const tab = await findRakutenTab();

  let result = await _execFetchInTab(tab, BASE + path, opts);

  // 403 시 800ms 대기 + 1회만 재시도 (페이지 context 가 새 cookie 받았을 수도)
  if (result.status === 403 && (opts.method || 'GET') === 'POST') {
    await new Promise(r => setTimeout(r, 800));
    console.log(`[rakutenFetch] 403 → 1 retry; first xsrf used: ${result.xsrfUsed}…`);
    result = await _execFetchInTab(tab, BASE + path, opts);
    console.log(`[rakutenFetch] retry status: ${result.status}, xsrf used: ${result.xsrfUsed}…`);
  }

  return {
    status: result.status, ok: result.ok,
    text: async () => result.bodyText || '',
    json: async () => JSON.parse(result.bodyText || '{}'),
    arrayBuffer: async () => {
      if (!result.bodyB64) return new ArrayBuffer(0);
      const bin = atob(result.bodyB64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return buf.buffer;
    },
    headers: { get: () => result.contentType }
  };
}

const rakutenFetch = rakutenFetchInTab;

// ---------- 楽天 API ----------
async function requestDownloadAsync(selectionType, startISO, endISO) {
  const payload = {
    page: 1, selectionType, periodType: 0,
    startDate: startISO, endDate: endISO,
    reportFilter: 1, campaignType: '1', rankType: 1,
    allUsers: true, newUsers: true, existingUsers: true,
    noOfClicks: true, adsalesBefore: true, cpc: true,
    h12: true, h720: true,
    gms: true, roas: true, cv: true, cvr: true, cpa: true,
  };
  const r = await rakutenFetch('/rpp/api/reports/downloadAsync', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: r.ok ? await r.json() : await r.text() };
}

let _firstListLogged = false;
async function fetchDownloadList() {
  const r = await rakutenFetch('/rpp/api/download/list');
  if (!r.ok) {
    console.warn('[fetchDownloadList] status', r.status);
    return [];
  }
  let j;
  try { j = await r.json(); } catch (e) {
    console.warn('[fetchDownloadList] json parse fail', e);
    return [];
  }
  if (!_firstListLogged) {
    _firstListLogged = true;
    console.log('[fetchDownloadList] raw response:', JSON.stringify(j).slice(0, 2000));
  }
  const tryReturn = (arr, source) => {
    if (Array.isArray(arr) && arr.length) {
      if (!_firstArrayLogged) {
        _firstArrayLogged = true;
        console.log(`[fetchDownloadList] using ${source}, sample[0]:`, JSON.stringify(arr[0]).slice(0, 1000));
      }
      return arr;
    }
    return null;
  };
  if (Array.isArray(j)) return j;
  const data = j && typeof j === 'object' ? j.data : null;
  let res;
  if ((res = tryReturn(data, 'data'))) return res;
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if ((res = tryReturn(v, `data.${k}`))) return res;
    }
  }
  if (j && typeof j === 'object') {
    for (const [k, v] of Object.entries(j)) {
      if ((res = tryReturn(v, k))) return res;
    }
  }
  return [];
}
let _firstArrayLogged = false;

async function fetchDownloadCsvZip(downloadId, reportType) {
  const r = await rakutenFetch(
    `/rpp/api/download/report?downloadId=${downloadId}&reportType=${reportType}`
  );
  if (!r.ok) throw new Error(`download/report ${r.status}`);
  return await r.arrayBuffer();  // ZIP 바이너리
}

async function fetchRppSearch(selectionType, periodType, startISO, endISO) {
  const allRows = [];
  for (let page = 1; page < 200; page++) {
    const payload = {
      page, pageNum: page, pageNo: page, pageIndex: page,
      pageSize: 500, limit: 500, noOfRows: 500, rowsPerPage: 500,
      selectionType, periodType,
      startDate: startISO, endDate: endISO,
      reportFilter: 1, campaignType: '1', rankType: 1,
      allUsers: true, newUsers: true, existingUsers: true,
      noOfClicks: true, adsalesBefore: true, cpc: true,
      h12: true, h720: true,
      gms: true, roas: true, cv: true, cvr: true, cpa: true,
    };
    const r = await rakutenFetch('/rpp/api/reports/search', {
      method: 'POST', body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`search ${r.status}: ${(await r.text()).slice(0,200)}`);
    const j = await r.json();
    const rows = j?.data?.rppReports || [];
    if (!rows.length) break;
    allRows.push(...rows);
    if (rows.length < 500) break;
  }
  return allRows;
}

// ---------- 업로드 to Vercel ----------
// sel=1/2 search rows (JSON)
async function uploadToVercel(vercelUrl, jwt, payload) {
  const r = await fetch(vercelUrl + '/api/ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + jwt,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`ingest ${r.status}: ${t.slice(0,200)}`);
  }
  return await r.json();
}

// sel=3/4 ZIP — 5개 배치 + multipart binary (base64 inflate 제거)
async function uploadZipsBatchToVercel(vercelUrl, jwt, batch) {
  // batch = [{shop_id, sel, dateISO, zipBuf}, ...]
  const form = new FormData();
  form.append('manifest', JSON.stringify(batch.map(it => ({
    shop_id: it.shop_id, selection_type: it.sel, report_date: it.dateISO,
  }))));
  batch.forEach((it, i) => {
    form.append(`zip_${i}`, new Blob([it.zipBuf], { type: 'application/zip' }));
  });
  const r = await fetch(vercelUrl + '/api/ingest_zip_batch', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + jwt },
    body: form,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`ingest_zip_batch ${r.status}: ${t.slice(0,200)}`);
  }
  return await r.json();  // {results: [{report_date, inserted}, ...]}
}

// ---------- 메인: 백필 실행 ----------
/**
 * runBackfill: 멤버가 「백필」 누르면 실행되는 본체.
 * @param {Object} task - {shop_id, from, to, sels, vercelUrl, jwt, taskId}
 * @param {Function} onProgress - (info) => {}
 */
// 로컬 시간 기준 YYYY-MM-DD (toISOString 은 UTC 라 timezone shift 발생)
function _ymd(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth()+1).padStart(2,'0') + '-' +
    String(d.getDate()).padStart(2,'0');
}

export async function runBackfill(task, onProgress) {
  const { from, to, vercelUrl, jwt, taskId } = task;
  // shop_id 는 항상 楽天 쿠키에서 자동 감지 (멀티숍: 멤버가 楽天에 로그인한 그 숍의 데이터)
  let shop_id = await getCurrentRakutenShopId();
  if (!shop_id) {
    onProgress({ taskId, done: true, error: '楽天 RMS にログインしてください (shop cookie なし)' });
    return;
  }
  const sels = task.sels || [1, 2, 3, 4];
  const tStart = Date.now();
  const startDate = new Date(from + 'T00:00:00');
  const endDate = new Date(to + 'T00:00:00');
  const today = new Date();
  today.setHours(0,0,0,0);
  // 楽天은 今日 거부 → 어제까지 (local 시간 기준)
  const yesterday = new Date(today.getTime() - 86400000);
  const effEnd = endDate > yesterday ? yesterday : endDate;

  const totals = { '全体広告': 0, 'キャンペーン別': 0, '商品別': 0, 'キーワード別': 0 };
  let totalRows = 0, ok = 0, failed = 0;
  let totalUnits = 0;  // 전체 작업 수 (sel=1/2 각 1개 + sel=3/4 일별)
  const log = [];

  function pushLog(line) {
    log.push(line);
    if (log.length > 100) log.shift();
  }
  function progress(extra = {}) {
    const doneNow = ok + failed;
    onProgress({
      taskId, totals,
      rows: totalRows, ok, failed,
      done_count: doneNow, total_count: totalUnits,
      progress_pct: totalUnits ? Math.floor((doneNow / totalUnits) * 100) : 0,
      elapsed_seconds: Math.floor((Date.now() - tStart) / 1000),
      log: log.slice(),
      ...extra,
    });
  }

  // 전체 작업 수 미리 계산
  const sel12Count = [1, 2].filter(s => sels.includes(s)).length;
  // sel=3/4 는 일별 — 아래에서 dayJobs 만들면서 더해짐 (지금은 sel12 만)
  totalUnits = sel12Count;

  // ============ sel=1, 2 (search API — 즉시 JSON) ============
  for (const sel of [1, 2].filter(s => sels.includes(s))) {
    const label = sel === 1 ? '全体広告' : 'キャンペーン別';
    progress({ current: `${label} 取得中` });
    try {
      const rows = await fetchRppSearch(sel, /* periodType */ 2, from, _ymd(effEnd));
      progress({ current: `${label} アップロード中 (${rows.length}件)` });
      const r = await uploadToVercel(vercelUrl, jwt, {
        type: 'rpp_search',
        shop_id, selection_type: sel,
        rows,
      });
      const inserted = r.inserted || rows.length;
      totals[label] = inserted;
      totalRows += inserted;
      ok++;
      pushLog(`${label}: ${inserted}件`);
    } catch (e) {
      console.error(`[backfill] ${label} fail:`, e);
      failed++;
      pushLog(`${label}: 失敗 (${String(e).slice(0,80)})`);
    }
    progress();
  }

  // ============ sel=3, 4 (downloadAsync — 일별) ============
  // 일자별로 (st=ed=d) downloadAsync 등록 → list 폴링 → CSV ZIP 다운로드 → 업로드
  const dayJobs = [];
  for (const sel of [3, 4].filter(s => sels.includes(s))) {
    const rt = sel === 3 ? 13 : 14;
    let d = new Date(startDate);
    while (d <= effEnd) {
      dayJobs.push({ sel, rt, dateISO: _ymd(d) });
      d = new Date(d.getTime() + 86400000);
    }
  }

  totalUnits = sel12Count + dayJobs.length;
  if (dayJobs.length === 0) {
    progress({ current: '完了', done: true });
    return;
  }

  // 5-parallel pipeline + 5개씩 ZIP 배치 업로드 (다운로드/업로드 비동기)
  const MAX_CONCURRENT = 5;
  const POLL_INTERVAL = 5000;
  const BATCH_SIZE = 5;
  const zipBuffer = [];
  const pendingTasks = new Set();  // 진행 중인 다운로드 + 업로드 promise 추적

  async function flushBatch() {
    if (!zipBuffer.length) return;
    const batch = zipBuffer.splice(0, zipBuffer.length);  // 통째로 떠냄
    try {
      const res = await uploadZipsBatchToVercel(vercelUrl, jwt, batch);
      const results = res.results || [];
      // 메타 join (manifest order 유지)
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const r = results[i] || {};
        const inserted = r.inserted || 0;
        totals[item.label] = (totals[item.label] || 0) + inserted;
        totalRows += inserted;
        if (inserted > 0 || r.ok !== false) {
          ok++;
          pushLog(`${item.label} ${item.dateISO}: ${inserted}件`);
        } else {
          failed++;
          pushLog(`${item.label} ${item.dateISO}: アップロード失敗`);
        }
      }
    } catch (e) {
      console.error('[batch upload] fail:', e);
      for (const item of batch) {
        failed++;
        pushLog(`${item.label} ${item.dateISO}: バッチ送信失敗`);
      }
    }
  }
  const queue = [...dayJobs];
  const inFlight = new Map();  // rakutenId → {sel, rt, dateISO}
  let doneInPipe = 0;
  const beforeList = await fetchDownloadList();
  const beforeIds = new Set(beforeList.map(r => r.id));

  const MAX_WAIT = Math.max(7200000, dayJobs.length * 60000);

  const registeredButUnmatched = new Map();  // job key → tries

  while ((queue.length || inFlight.size) && (Date.now() - tStart) < MAX_WAIT) {
    // 큐에 여유 있으면 새 작업 등록 — 일괄로 여러 개 등록 후 한 번에 list 확인
    const justRegistered = [];
    while (inFlight.size + justRegistered.length < MAX_CONCURRENT && queue.length) {
      const job = queue.shift();
      const label = job.sel === 3 ? '商品別' : 'キーワード別';
      try {
        const reg = await requestDownloadAsync(job.sel, job.dateISO, job.dateISO);
        if (reg.status >= 400) {
          job._retry = (job._retry || 0) + 1;
          if (job._retry < 2) {
            queue.push(job);
          } else {
            pushLog(`${label} ${job.dateISO}: 登録失敗 ${reg.status}`);
            failed++; doneInPipe++;
          }
          continue;
        }
        justRegistered.push(job);
      } catch (e) {
        job._retry = (job._retry || 0) + 1;
        if (job._retry < 2) queue.push(job);
        else { pushLog(`${label} ${job.dateISO}: 登録例外`); failed++; doneInPipe++; }
        continue;
      }
      await new Promise(r => setTimeout(r, 400));
    }
    // 등록 후 楽天 가 list 에 반영하는 시간 (~2sec)
    if (justRegistered.length) {
      progress({ current: `登録 ${justRegistered.length}件 → list 確認中` });
      await new Promise(r => setTimeout(r, 2000));
      const rows = await fetchDownloadList();
      for (const job of justRegistered) {
        const matches = rows.filter(r => !beforeIds.has(r.id) && !inFlight.has(r.id)
          && r.reportType === job.rt
          && r.startDate === job.dateISO
          && r.endDate === job.dateISO);
        const label = job.sel === 3 ? '商品別' : 'キーワード別';
        if (matches.length) {
          const id = Math.max(...matches.map(r => r.id));
          inFlight.set(id, job);
        } else {
          // 등록은 됐으나 list 에 아직 안 보임 — 다시 list 확인 sequence 에서 잡힐 것
          registeredButUnmatched.set(`${job.sel}_${job.dateISO}`, (registeredButUnmatched.get(`${job.sel}_${job.dateISO}`) || 0) + 1);
          if ((registeredButUnmatched.get(`${job.sel}_${job.dateISO}`) || 0) > 5) {
            pushLog(`${label} ${job.dateISO}: 楽天 list 未表示`);
            failed++; doneInPipe++;
          } else {
            queue.push(job);  // 다시 시도
          }
        }
      }
    }

    // 폴링 — 대시보드에 「待機中」 + elapsed tick 보내기
    progress({ current: `商品・キーワード ${doneInPipe}/${dayJobs.length} (待機中…)` });
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    const list = await fetchDownloadList();
    for (const [id, job] of [...inFlight]) {
      const row = list.find(r => r.id === id);
      if (!row) continue;
      if (row.status === 2) {  // 완료 → 비동기로 다운로드+배치 처리 (블로킹 X)
        const label = job.sel === 3 ? '商品別' : 'キーワード別';
        const jid = id, jobCopy = { ...job };
        inFlight.delete(id);
        doneInPipe++;
        // 다운로드는 fire-and-forget — 폴링/등록 진행 막지 않음
        const task = (async () => {
          try {
            const zipBuf = await fetchDownloadCsvZip(jid, jobCopy.rt);
            zipBuffer.push({ shop_id, sel: jobCopy.sel, dateISO: jobCopy.dateISO, zipBuf, label });
            if (zipBuffer.length >= BATCH_SIZE) {
              const ut = flushBatch();
              pendingTasks.add(ut);
              ut.finally(() => pendingTasks.delete(ut));
            }
          } catch (e) {
            console.error(`[backfill] day ${jobCopy.dateISO} sel=${jobCopy.sel} download fail:`, e);
            failed++;
            pushLog(`${label} ${jobCopy.dateISO}: ダウンロード失敗`);
          }
        })();
        pendingTasks.add(task);
        task.finally(() => pendingTasks.delete(task));
        progress({ current: `商品・キーワード ${doneInPipe}/${dayJobs.length}` });
      } else if (row.status === 3 || row.status === 9) {  // 실패
        inFlight.delete(id);
        const label = job.sel === 3 ? '商品別' : 'キーワード別';
        pushLog(`${label} ${job.dateISO}: 楽天側エラー`);
        failed++;
        doneInPipe++;
      }
    }
  }
  // 진행 중인 다운로드/업로드 모두 완료될 때까지 대기
  if (pendingTasks.size) {
    progress({ current: `${pendingTasks.size}件 完了待ち` });
    await Promise.all([...pendingTasks]);
  }
  // 남은 ZIP 마지막 flush (5개 미만)
  if (zipBuffer.length) {
    progress({ current: `${zipBuffer.length}件 最終バッチ送信中` });
    await flushBatch();
  }

  progress({ current: '完了', done: true });
  return { totals, rows: totalRows, ok, failed };
}
