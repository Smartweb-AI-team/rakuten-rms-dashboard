"""
server.py — SmartProfit 로컬 대시보드 백엔드 (표준 라이브러리만 사용)

  py server.py        # http://127.0.0.1:8765 실행

역할:
  - static/ 의 HTML 대시보드 서빙
  - 라쿠텐 RMS 일별 데이터 '딸깍' 수집 (POST /api/collect)
  - 세션 쿠키 수신 (브라우저 확장 → POST /api/session)
  - DB 조회/집계/KPI/추이/상위N (GET /api/*)
  - 규칙기반 인사이트 (키 불필요) + AI챗 (ANTHROPIC_API_KEY 있을 때)
  - DB 경로 = Google Drive 동기화 폴더로 설정 가능 (POST /api/config)

외부 패키지(requests/anthropic)는 '필요할 때만' 지연 import 하므로,
미설치 상태에서도 서버는 뜨고 UI/샘플 데이터로 둘러볼 수 있다.
"""
from __future__ import annotations

# .env 자동 로드 (SUPABASE_URL / DATABASE_URL 등 — 로컬에서도 인증/Postgres 가능)
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

import json
import os
import shutil
import threading
import time
import traceback
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

from db import DB

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
STATIC_DIR = os.path.join(HERE, "static")

# ----------------------------- 설정 -----------------------------
def load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)

def save_config(cfg: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

CONFIG = load_config()

def db_path() -> str:
    p = CONFIG.get("db_path") or "rms_ads.db"
    full = p if os.path.isabs(p) else os.path.join(HERE, p)
    # Drive 경로가 지정됐지만 실제로 마운트 안 됨(= 부모 폴더 부재)이면 로컬 폴백
    parent = os.path.dirname(full) or "."
    if os.path.isabs(p) and not os.path.exists(parent):
        # 만들 수 있으면 만들어 보고, 실패하면 로컬로
        try:
            os.makedirs(parent, exist_ok=True)
        except Exception:
            local = os.path.join(HERE, os.path.basename(p) or "rms_ads.db")
            print(f"⚠ Drive 経路が見つからないためローカルにフォールバック: {local}")
            return local
    return full

def get_db() -> DB:
    # 스레드별 안전: 매 요청마다 새 연결
    p = db_path()
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    return DB(p)


# ---- collector_id: PC 마다 고유 ID ----
def _get_collector_id() -> str:
    """config.json에 collector_id 없으면 자동 생성(UUID4) + 저장."""
    cid = CONFIG.get("collector_id")
    if cid:
        return cid
    import uuid
    cid = uuid.uuid4().hex[:12]
    CONFIG["collector_id"] = cid
    CONFIG.setdefault("collector_label", "")
    try:
        save_config(CONFIG)
    except Exception:
        pass
    return cid

def collector_id() -> str:
    return _get_collector_id()

def collector_label() -> str:
    return CONFIG.get("collector_label") or _get_collector_id()


# ---- Drive Lock: 같은 폴더에 lock.json 으로 동시 수집 방지 ----
LOCK_STALE_SEC = 1800  # 30 분 이상 오래된 lock 은 무효 (PC 충돌 회피)

def _lock_path() -> str:
    p = db_path()
    return os.path.join(os.path.dirname(p) or ".", "rms_ads.lock.json")

def lock_status() -> dict:
    """현재 lock 상태. {locked, by, started_at, age_seconds, stale}"""
    import time as _t
    lp = _lock_path()
    if not os.path.exists(lp):
        return {"locked": False}
    try:
        with open(lp, encoding="utf-8") as f:
            lk = json.load(f)
        ts = lk.get("started_ts", 0)
        age = int(_t.time() - ts) if ts else 0
        return {"locked": True, "by": lk.get("by"), "label": lk.get("label"),
                "started_at": lk.get("started_at"), "age_seconds": age,
                "stale": age > LOCK_STALE_SEC}
    except Exception:
        return {"locked": False}

def acquire_lock(reason: str = "collect") -> tuple[bool, dict]:
    """수집 시작 전 호출. 다른 PC가 lock 잡고 있으면 (False, status). 자기 PC면 강제 갱신."""
    import time as _t
    st = lock_status()
    me = collector_id()
    if st.get("locked") and not st.get("stale") and st.get("by") != me:
        return False, st
    lk = {"by": me, "label": collector_label(), "reason": reason,
          "started_ts": _t.time(),
          "started_at": __import__("datetime").datetime.now().isoformat(timespec="seconds")}
    try:
        with open(_lock_path(), "w", encoding="utf-8") as f:
            json.dump(lk, f, ensure_ascii=False)
        return True, lk
    except Exception as e:
        return False, {"error": str(e)}

def release_lock() -> None:
    try:
        if os.path.exists(_lock_path()):
            os.remove(_lock_path())
    except Exception:
        pass


# ------------------------- 세션(쿠키) 관리 -------------------------
# 브라우저 확장 또는 수동 입력으로 받은 라쿠텐 쿠키를 메모리 + 파일에 보관(재시작해도 유지).
SESSION: dict[str, str] = {}          # name -> value (호환/표시용; 경로 무시 평탄화)
SESSION_COOKIES: list[dict] = []      # [{name,value,path,domain}] (경로별 XSRF 보존 → 클라이언트 빌드용)
SESSION_FILE = os.path.join(HERE, "session_cookies.json")

def _sync_flat():
    SESSION.clear()
    for c in SESSION_COOKIES:
        SESSION[c["name"]] = c["value"]

def save_session():
    try:
        with open(SESSION_FILE, "w", encoding="utf-8") as f:
            json.dump({"cookieList": SESSION_COOKIES}, f)
    except Exception:
        pass

def load_session_file():
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and "cookieList" in data:
                SESSION_COOKIES[:] = data["cookieList"]
            elif isinstance(data, dict):  # 구버전: 평탄 dict
                SESSION_COOKIES[:] = [{"name": k, "value": v, "path": "/",
                                       "domain": ".rakuten.co.jp"} for k, v in data.items()]
            _sync_flat()
        except Exception:
            pass

def _load_session_from_state():
    """시작 시 storage_state.json 이 있으면 자동 로드."""
    path = CONFIG.get("storage_state_path")
    if path and not os.path.isabs(path):
        path = os.path.join(HERE, path)
    if path and os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                state = json.load(f)
            for c in state.get("cookies", []):
                if "rakuten.co.jp" in c.get("domain", ""):
                    SESSION[c["name"]] = c["value"]
        except Exception:
            pass

def build_client():
    """현재 세션 쿠키(경로 포함)로 RakutenAdClient 생성 (requests 필요)."""
    from rakuten_client import RakutenAdClient
    return RakutenAdClient(list(SESSION_COOKIES) if SESSION_COOKIES else dict(SESSION))

def session_ok() -> tuple[bool, str]:
    if "XSRF-TOKEN" not in SESSION:
        return False, "クッキー未受信 (XSRF-TOKEN なし)"
    try:
        if build_client().check_session():
            return True, "有効"
        return False, "セッション期限切れ（再ログインが必要）"
    except ModuleNotFoundError:
        return False, "requests 未インストール (pip install requests)"
    except Exception as e:
        return False, f"確認に失敗: {e}"


# ----------------------- 샘플 데이터 생성 -----------------------
def generate_sample(shop_id: str, start: date, end: date) -> dict:
    """실로그인 없이 UI를 둘러보기 위한 가짜 일별 데이터.
    selection_type 1(전체)/2(캠페인)을 채운다. 결정적(날짜 기반)이라 재현 가능."""
    db = get_db()
    campaigns = [("自動_全体最適化", "1001"), ("ブランドキーワード", "1002"),
                 ("新商品_ローンチ", "1003"), ("季節_セール", "1004"), ("リターゲティング", "1005")]
    perf = []
    d = start
    while d <= end:
        seed = int(d.strftime("%Y%m%d"))
        wday = d.weekday()
        weekend = 1.25 if wday >= 5 else 1.0  # 주말 가중
        # 전체(selection_type=1)
        base_clicks = int((800 + (seed % 137) * 3) * weekend)
        cpc = 42 + (seed % 11)
        cost = base_clicks * cpc
        gms = cost * (3.5 + ((seed % 23) / 10.0))
        cv = max(1, int(base_clicks * (0.018 + (seed % 7) / 1000.0)))
        perf.append(dict(shop_id=shop_id, ad_product="RPP", selection_type=1,
                         report_date=d.isoformat(), campaign_id="", dimension_key="",
                         campaign_name="全体", user_segment="all", cv_window="720h",
                         clicks=base_clicks, ad_cost=cost, gms=round(gms),
                         cv=cv, cvr=round(cv / base_clicks, 4),
                         roas=round(gms / cost, 2), cpc=cpc,
                         cpa=round(cost / cv)))
        # 캠페인별(selection_type=2)
        for i, (name, cid) in enumerate(campaigns):
            share = [0.40, 0.22, 0.15, 0.13, 0.10][i]
            c = max(1, int(base_clicks * share))
            cc = cpc + (i * 3) - 4
            co = c * cc
            g = co * (2.0 + ((seed + i * 7) % 40) / 10.0)
            v = max(0, int(c * (0.012 + ((seed + i) % 9) / 1000.0)))
            perf.append(dict(shop_id=shop_id, ad_product="RPP", selection_type=2,
                             report_date=d.isoformat(), campaign_id=cid, dimension_key="",
                             campaign_name=name, user_segment="all", cv_window="720h",
                             clicks=c, ad_cost=co, gms=round(g), cv=v,
                             cvr=round(v / c, 4) if c else 0,
                             roas=round(g / co, 2) if co else 0, cpc=cc,
                             cpa=round(co / v) if v else None))
        d += timedelta(days=1)
    n = db.upsert_performance(perf)
    report = {"mode": "sample", "date_from": start.isoformat(),
              "date_to": end.isoformat(), "RPP_sel1+2": n}
    db.log_collect(shop_id, start.isoformat(), end.isoformat(), "sample", report)
    return report


# --------------------------- 기간 백필(월 단위 청크) ---------------------------
BACKFILL = {"running": False, "total": 0, "done": 0, "current": "",
            "ok": 0, "failed": 0, "rows": 0, "log": [], "error": None,
            "cancel": False, "from": None, "to": None,
            "totals": {}, "skips": {}, "notes": [],
            "started_at": None, "ended_at": None, "elapsed_seconds": 0}

PRODUCT_LABELS = [("RPP_sel1", "全体広告"), ("RPP_sel2", "キャンペーン別"),
                  ("RPP_item", "商品別"), ("RPP_keyword", "キーワード別"),
                  ("CPA_rows", "CPA"), ("TDA_rows", "TDA")]

def month_chunks(start: date, end: date):
    """[start, end] 을 달력 월 경계로 분할."""
    chunks, s = [], start
    while s <= end:
        nxt = date(s.year + 1, 1, 1) if s.month == 12 else date(s.year, s.month + 1, 1)
        chunks.append((s, min(end, nxt - timedelta(days=1))))
        s = nxt
    return chunks

def _run_backfill_with_lock(shop: str, start: date, end: date, delay: float):
    try:
        run_backfill(shop, start, end, delay)
    finally:
        release_lock()

def run_backfill(shop: str, start: date, end: date, delay: float):
    from collector import collect_range
    import time as _t
    t0 = _t.time()
    try:
        client = build_client()
        db = get_db()
        chunks = month_chunks(start, end)
        BACKFILL.update(running=True, total=len(chunks), done=0, ok=0, failed=0,
                        rows=0, log=[], error=None, cancel=False, current="",
                        totals={lbl: 0 for _, lbl in PRODUCT_LABELS}, skips={}, notes=[],
                        started_at=t0, ended_at=None, elapsed_seconds=0,
                        **{"from": start.isoformat(), "to": end.isoformat()})
        for cs, ce in chunks:
            if BACKFILL["cancel"]:
                BACKFILL["log"].append(f"⏹ キャンセル（{cs.strftime('%Y-%m')}以降を中断）")
                break
            label = cs.strftime("%Y-%m")
            BACKFILL["current"] = label
            try:
                rep = collect_range(client, db, shop, cs, ce)
                # 상품별 누적 내역 / 사유 / 노트 집계
                for key, lbl in PRODUCT_LABELS:
                    BACKFILL["totals"][lbl] += rep.get(key, 0)
                for reason, cnt in rep.get("skips", {}).items():
                    BACKFILL["skips"][reason] = BACKFILL["skips"].get(reason, 0) + cnt
                for note in rep.get("notes", []):
                    if note not in BACKFILL["notes"]:
                        BACKFILL["notes"].append(note)
                n = (rep["RPP_sel1"] + rep["RPP_sel2"] + rep["RPP_item"]
                     + rep.get("RPP_keyword", 0) + rep["CPA_rows"] + rep["TDA_rows"])
                if n > 0:
                    BACKFILL["ok"] += 1; BACKFILL["rows"] += n
                    extra = f"（一部未取得 {rep['skipped_calls']}件）" if rep.get("skipped_calls") else ""
                    BACKFILL["log"].append(f"{label}: {n}件{extra}")
                else:
                    BACKFILL["failed"] += 1
                    BACKFILL["log"].append(f"{label}: スキップ（4年上限超過/データなし）")
            except Exception as e:
                BACKFILL["failed"] += 1
                BACKFILL["log"].append(f"{label}: 失敗（{str(e)[:70]}）")
            BACKFILL["done"] += 1
            BACKFILL["log"] = BACKFILL["log"][-300:]
            time.sleep(max(0.0, delay))
    except Exception as e:
        BACKFILL["error"] = str(e)
    finally:
        BACKFILL["running"] = False
        BACKFILL["current"] = ""
        BACKFILL["ended_at"] = _t.time()
        if BACKFILL.get("started_at"):
            BACKFILL["elapsed_seconds"] = int(BACKFILL["ended_at"] - BACKFILL["started_at"])


# --------------------------- 미수집 채우기(갭필) ---------------------------
# 수집 가능한 윈도(전체/캠페인 ~4년, 상품/키워드 ~2년) 안에서 '빠진 날짜'만 다시 수집.
# 한도 초과 등 영구 불가 구간은 윈도에서 제외하므로 헛수고 재시도를 안 한다.
ALL_REFILL_DAYS = 1450     # 전체/캠페인: 약 4년 안쪽(경계 회피)
ITEM_REFILL_DAYS = 715     # 상품/키워드: 약 2년 안쪽(경계 회피)
REFILL_SELS = [(1, "全体広告", ALL_REFILL_DAYS), (2, "キャンペーン別", ALL_REFILL_DAYS),
               (3, "商品別", ITEM_REFILL_DAYS), (4, "キーワード別", ITEM_REFILL_DAYS)]

def _date_runs(days_sorted):
    """정렬된 date 리스트 → 연속 구간 (start, end) 리스트."""
    runs = []
    for d in days_sorted:
        if runs and d == runs[-1][1] + timedelta(days=1):
            runs[-1][1] = d
        else:
            runs.append([d, d])
    return [(a, b) for a, b in runs]

def find_gaps(db, shop):
    """(sel, label, [빠진 날짜]) 목록. 각 상품의 수집가능 윈도 안에서만."""
    today = date.today()
    yest = today - timedelta(days=1)
    bounds = db.date_bounds(shop)
    span_min = date.fromisoformat(bounds["min"]) if bounds["min"] else None
    gaps = []
    for sel, label, win_days in REFILL_SELS:
        win_start = today - timedelta(days=win_days)
        if span_min:
            win_start = max(win_start, span_min)  # 수집한 적 있는 범위 안의 구멍만
        if win_start > yest:
            gaps.append((sel, label, [])); continue
        present = db.present_dates(shop, sel)
        missing, d = [], win_start
        while d <= yest:
            if d.isoformat() not in present:
                missing.append(d)
            d += timedelta(days=1)
        gaps.append((sel, label, missing))
    return gaps

from rakuten_client import (normalize_rpp_keyword_csv as _normalize_kw_csv,
                            normalize_rpp_item_csv as _normalize_item_csv)


def download_worker_loop():
    """백그라운드 워커: download_jobs 큐를 30초 간격으로 처리.
    pending → 라쿠텐 downloadAsync 등록 + rakuten_id 발견 → registered
    registered → 라쿠텐 list 폴링 → status=2 (완료) 발견 시 CSV 다운로드 + 파싱 + DB upsert → completed
    실패 시 failed, error_msg 저장."""
    import time as _t

    while True:
        try:
            db = get_db()
            jobs = db.get_active_jobs()
            if not jobs:
                _t.sleep(30)
                continue
            # 세션 확인
            ok, _msg = session_ok()
            if not ok:
                _t.sleep(60)
                continue
            client = build_client()
            # 라쿠텐 list 한 번만 받아서 모든 작업에 재사용 (호출 줄임)
            try:
                cached_rows = client._extract_download_rows(client.fetch_rpp_download_list_raw())
            except Exception:
                cached_rows = None
            for job in jobs:
                try:
                    _process_download_job(client, db, job, cached_rows=cached_rows)
                except Exception as e:
                    db.update_download_job(job["id"], status="failed",
                                           error_msg=str(e)[:300])
            _t.sleep(30)
        except Exception as e:
            print(f"[worker] loop error: {e}")
            _t.sleep(60)


def _process_download_job(client, db, job: dict, cached_rows=None):
    """단일 작업 한 단계 진행. 라쿠텐 list에 이미 완료된 매칭 row가 있으면 즉시 CSV 받음."""
    from datetime import date as _dt_date
    sel = job["selection_type"]
    rt = job["report_type"]
    pt = job["period_type"]
    pt_send: int | str = 0 if pt == "0" else pt
    start = _dt_date.fromisoformat(job["start_date"])
    end = _dt_date.fromisoformat(job["end_date"])

    # 1) 캐싱된 list (또는 새로 받음)에서 매칭되는 라쿠텐 작업 찾기
    if cached_rows is None:
        try:
            cached_rows = client._extract_download_rows(client.fetch_rpp_download_list_raw())
        except Exception:
            cached_rows = []
    matches = [r for r in cached_rows if isinstance(r, dict)
               and r.get("reportType") == rt
               and r.get("startDate") == job["start_date"]
               and r.get("endDate") == job["end_date"]
               and r.get("periodType") == pt_send]

    # 완료된 row 발견 → 즉시 CSV 다운로드 + 파싱 + DB upsert
    completed_matches = [r for r in matches if r.get("status") == 2]
    if completed_matches:
        target = max(completed_matches, key=lambda r: r.get("id", 0))
        csv = client.fetch_rpp_download_csv(target["id"], report_type=rt)
        shop = job["shop_id"]
        if sel == 4:
            rows_norm = _normalize_kw_csv(csv, shop)
        elif sel == 3:
            rows_norm = _normalize_item_csv(csv, shop)
        else:
            rows_norm = []
        n = db.upsert_performance(rows_norm) if rows_norm else 0
        db.update_download_job(job["id"], rakuten_id=target["id"],
                               status="completed", normalized_rows=n)
        return

    # 처리중인 row 있음 → 계속 대기
    pending_matches = [r for r in matches if r.get("status") in (0, 1)]
    if pending_matches:
        target = max(pending_matches, key=lambda r: r.get("id", 0))
        db.update_download_job(job["id"], rakuten_id=target["id"],
                               status="registered")
        return

    # 매칭되는 라쿠텐 작업 없음 → 새로 등록
    if job["status"] == "pending":
        client.request_rpp_download(start, end, selection_type=sel,
                                    period_type=pt_send)
        db.update_download_job(job["id"], status="registered")


def run_refill(shop: str):
    from rakuten_client import normalize_rpp, PERIOD_DAY
    import time as _t
    t0 = _t.time()
    try:
        client = build_client()
        db = get_db()
        gaps = find_gaps(db, shop)

        # 전체/캠페인 (sel=1,2): 기존 search API (range별 1회 호출, 항상 정확)
        plan_ranges = []
        for sel, label, missing in gaps:
            if sel in (1, 2):
                for a, b in _date_runs(missing):
                    for cs, ce in month_chunks(a, b):
                        plan_ranges.append((sel, label, cs, ce))

        # 상품/키워드 (sel=3,4): downloadAsync 동기 일괄 (정확한 전건)
        batch_jobs = []  # [(sel, report_type, start, end)]
        for sel, label, missing in gaps:
            if sel == 3:
                for d in missing:
                    batch_jobs.append((sel, 13, d, d))
            elif sel == 4:
                for d in missing:
                    batch_jobs.append((sel, 14, d, d))

        total_units = len(plan_ranges) + len(batch_jobs)
        BACKFILL.update(running=True, total=total_units, done=0, ok=0, failed=0, rows=0,
                        log=[], error=None, cancel=False, current="補完",
                        totals={lbl: 0 for _, lbl in PRODUCT_LABELS}, skips={}, notes=[],
                        started_at=t0, ended_at=None, elapsed_seconds=0,
                        **{"from": "取得漏れ", "to": "補完"})
        if total_units == 0:
            BACKFILL["notes"].append("補完する取得漏れはありません — 取得可能な期間はすべて取得済みです。")
            BACKFILL["running"] = False
            return

        # 1) 전체/캠페인 range 처리
        for sel, label, cs, ce in plan_ranges:
            if BACKFILL["cancel"]:
                BACKFILL["log"].append("⏹ キャンセル"); break
            BACKFILL["current"] = label
            try:
                rows = client.fetch_rpp(cs, ce, selection_type=sel, period_type=PERIOD_DAY)
                n = db.upsert_performance(normalize_rpp(rows, shop, sel))
                BACKFILL["totals"][label] = BACKFILL["totals"].get(label, 0) + n
                BACKFILL["rows"] += n; BACKFILL["ok"] += 1
                BACKFILL["log"].append(f"{label} {cs.isoformat()}~{ce.isoformat()}: {n}件")
            except Exception as e:
                BACKFILL["failed"] += 1
                reason = "上限超過/データなし(400)" if "400" in str(e) else str(e)[:50]
                BACKFILL["skips"][f"{label} · {reason}"] = \
                    BACKFILL["skips"].get(f"{label} · {reason}", 0) + 1
            BACKFILL["done"] += 1
            BACKFILL["log"] = BACKFILL["log"][-300:]
            time.sleep(0.05)

        # 2) 상품/키워드 일괄 다운로드 (라쿠텐 동기 폴링)
        if batch_jobs and not BACKFILL["cancel"]:
            BACKFILL["current"] = f"商品・キーワード ダウンロード ({len(batch_jobs)}件)"

            def _progress(done_now, total_now):
                BACKFILL["current"] = f"商品・キーワード ダウンロード ({done_now}/{total_now})"

            try:
                # 라쿠텐 처리 약 10초/작업. 큰 백필은 시간 늘림
                csvs = client.fetch_rpp_csvs_pipeline(
                    batch_jobs,
                    max_concurrent=4,
                    poll_interval=5.0,
                    max_wait=max(3600.0, len(batch_jobs) * 60.0),
                    progress_cb=_progress,
                    cancel_cb=lambda: BACKFILL.get("cancel", False))
                for (sel, rt, st_iso, ed_iso), csv_text in csvs.items():
                    if not csv_text:
                        BACKFILL["failed"] += 1
                        lbl = "商品別" if sel == 3 else "キーワード別"
                        BACKFILL["skips"][f"{lbl} · ダウンロード未完了"] = \
                            BACKFILL["skips"].get(f"{lbl} · ダウンロード未完了", 0) + 1
                    else:
                        if sel == 4:
                            rows = _normalize_kw_csv(csv_text, shop)
                            lbl = "キーワード別"
                        else:
                            rows = _normalize_item_csv(csv_text, shop)
                            lbl = "商品別"
                        n = db.upsert_performance(rows)
                        BACKFILL["totals"][lbl] = BACKFILL["totals"].get(lbl, 0) + n
                        BACKFILL["rows"] += n
                        BACKFILL["ok"] += 1
                        BACKFILL["log"].append(f"{lbl} {st_iso}: {n}件")
                    BACKFILL["done"] += 1
                    BACKFILL["log"] = BACKFILL["log"][-300:]
            except Exception as e:
                BACKFILL["error"] = f"ダウンロード処理エラー: {str(e)[:150]}"
    except Exception as e:
        BACKFILL["error"] = str(e)
    finally:
        BACKFILL["running"] = False
        BACKFILL["current"] = ""
        BACKFILL["ended_at"] = _t.time()
        if BACKFILL.get("started_at"):
            BACKFILL["elapsed_seconds"] = int(BACKFILL["ended_at"] - BACKFILL["started_at"])


# --------------------------- 인사이트(규칙기반) ---------------------------
def _pct(cur, prev):
    if prev in (None, 0):
        return None
    return round((cur - prev) / prev * 100, 1)

def build_insights(shop_id: str, date_from: str, date_to: str,
                   ad_product: str, selection_type: int, cv_window: str = "720h",
                   user_segment: str = "all") -> dict:
    db = get_db()
    cur = db.kpis(shop_id, date_from, date_to, ad_product, selection_type,
                  user_segment=user_segment, cv_window=cv_window)
    days = (date.fromisoformat(date_to) - date.fromisoformat(date_from)).days + 1
    prev_to = (date.fromisoformat(date_from) - timedelta(days=1)).isoformat()
    prev_from = (date.fromisoformat(prev_to) - timedelta(days=days - 1)).isoformat()
    prev = db.kpis(shop_id, prev_from, prev_to, ad_product, selection_type,
                   user_segment=user_segment, cv_window=cv_window)
    if ad_product == "TDA":  # 뷰스루 전환이라 클릭기반 CVR 무의미
        cur["cvr"] = prev["cvr"] = None

    deltas = {k: _pct(cur.get(k), prev.get(k))
              for k in ("ad_cost", "gms", "clicks", "cv", "roas", "cpc")}

    # 캠페인 단위 변화 큰 항목 (비용 기준 상위 movers)
    movers = []
    cur_top = {r["campaign_name"]: r for r in
               db.top_dimensions(shop_id, date_from, date_to, ad_product, 2, user_segment=user_segment, cv_window=cv_window, limit=50)}
    prev_top = {r["campaign_name"]: r for r in
                db.top_dimensions(shop_id, prev_from, prev_to, ad_product, 2, user_segment=user_segment, cv_window=cv_window, limit=50)}
    for name, r in cur_top.items():
        p = prev_top.get(name)
        d_cost = _pct(r["ad_cost"], p["ad_cost"]) if p else None
        d_roas = _pct(r.get("roas"), p.get("roas")) if p and p.get("roas") else None
        movers.append({"campaign_name": name, "ad_cost": r["ad_cost"],
                       "roas": r.get("roas"), "cost_change_pct": d_cost,
                       "roas_change_pct": d_roas})
    movers.sort(key=lambda x: abs(x["cost_change_pct"] or 0), reverse=True)

    # 한국어 불릿 요약(규칙기반)
    bullets, actions = [], []
    def fmt_pct(p):
        if p is None:
            return "前期間比なし"
        arrow = "▲" if p > 0 else ("▼" if p < 0 else "—")
        return f"{arrow}{abs(p)}%"
    def yen(v):
        return f"¥{int(v):,}" if v is not None else "-"
    def pct(v, d=1):
        return f"{round(v * 100, d)}%" if v is not None else "-"

    bullets.append(f"売上 {yen(cur['gms'])} ({fmt_pct(deltas['gms'])}) · "
                   f"広告費 {yen(cur['ad_cost'])} ({fmt_pct(deltas['ad_cost'])})")
    bullets.append(f"クリック {int(cur['clicks']):,} ({fmt_pct(deltas['clicks'])}) · "
                   f"CTR {pct(cur.get('ctr'), 2)} · CV {int(cur['cv']):,} ({fmt_pct(deltas['cv'])}) · "
                   f"CVR {pct(cur.get('cvr'), 2)}")
    bullets.append(f"ROAS {pct(cur['roas'], 0)} ({fmt_pct(deltas['roas'])}) · "
                   f"CPC {yen(cur.get('cpc'))} ({fmt_pct(deltas['cpc'])}) · CPA {yen(cur.get('cpa'))}")

    # 効率・コスト診断
    if deltas["roas"] is not None and deltas["roas"] <= -10:
        bullets.append("⚠ ROASが前期間比で二桁下落 — 費用対効果が低下しています。")
        if deltas["ad_cost"] and deltas["ad_cost"] > 0 and (deltas["gms"] or 0) < deltas["ad_cost"]:
            actions.append("広告費の増加に売上が追いついていません — 低効率キャンペーンの入札・予算の縮小を検討。")
    elif deltas["roas"] is not None and deltas["roas"] >= 10:
        bullets.append("✅ ROASが前期間比で二桁改善 — 効率の良い局面です。")
        actions.append("ROAS上昇局面 — 高効率キャンペーンの予算増額を検討。")
    if deltas["clicks"] is not None and deltas["clicks"] <= -15:
        actions.append("クリックが大幅に減少 — 表示回数・キーワード順位・季節性を確認。")

    # 캠페인 베스트/워스트 (충분한 비용 기준)
    spend_sorted = [m for m in movers if m["ad_cost"]]
    by_roas = [m for m in cur_top.values() if m.get("roas") and m["ad_cost"] >= 1]
    if by_roas:
        best = max(by_roas, key=lambda x: x["roas"])
        worst = min(by_roas, key=lambda x: x["roas"])
        bullets.append(f"効率トップ '{best['campaign_name']}' ROAS {pct(best['roas'], 0)} · "
                       f"最低 '{worst['campaign_name']}' ROAS {pct(worst['roas'], 0)}")
        if worst["roas"] and worst["roas"] < 1.5:
            actions.append(f"'{worst['campaign_name']}' ROAS {pct(worst['roas'], 0)}（150%未満）— 構成・クリエイティブ見直し、または比重縮小を検討。")
    if movers and movers[0]["cost_change_pct"] is not None:
        m = movers[0]
        bullets.append(f"変動が最大のキャンペーン '{m['campaign_name']}' 広告費 {fmt_pct(m['cost_change_pct'])}"
                       f"{'、ROAS ' + fmt_pct(m['roas_change_pct']) if m['roas_change_pct'] is not None else ''}")

    # 노출수(impressions) 신선도: 가장 최근 impr>0 인 날짜 (라쿠텐이 며칠 늦게 확정)
    with db.cursor() as cur_:
        cur_.execute("SELECT MAX(report_date) FROM ad_daily_performance "
                     "WHERE shop_id=? AND ad_product=? AND selection_type=1 "
                     "AND user_segment='all' AND impressions IS NOT NULL AND impressions>0",
                     (shop_id, ad_product or "RPP"))
        impr_last = (cur_.fetchone() or [None])[0]

    headline = (f"{date_from}〜{date_to} · {ad_product or '全広告'} · 売上 {yen(cur['gms'])} / "
                f"広告費 {yen(cur['ad_cost'])} / ROAS {pct(cur['roas'], 0)}")
    return {"headline": headline, "current": cur, "previous": prev,
            "previous_range": {"from": prev_from, "to": prev_to},
            "deltas": deltas, "movers": movers[:8], "bullets": bullets,
            "actions": actions,
            "narrative": _narrative(date_from, date_to, ad_product, cur, deltas, movers, by_roas),
            "note": "集計は前日まで確定。過去分は後日変動する場合があります。",
            "impressions_last_date": impr_last}


def _narrative(date_from, date_to, ad_product, cur, deltas, movers, by_roas):
    """1段落の自然語サマリー(コンサル風)。Claudeなしの規則ベース。"""
    def yen(v): return f"{int(v):,}円" if v else "—"
    def pct(v, d=0): return f"{round(v * 100, d)}%" if v is not None else "—"
    def dpct(v): return f"{'増加' if v > 0 else '減少'}{abs(v)}%" if v is not None else "前期比なし"

    parts = []
    parts.append(f"{date_from}〜{date_to}の{ad_product or '全広告'}は、売上 {yen(cur.get('gms'))}（前期比 {dpct(deltas.get('gms'))}）、広告費 {yen(cur.get('ad_cost'))}（{dpct(deltas.get('ad_cost'))}）、ROAS {pct(cur.get('roas'))}（{dpct(deltas.get('roas'))}）となりました。")
    # 主要動因
    if deltas.get("roas") is not None:
        if deltas["roas"] >= 10:
            parts.append(f"ROASは前期比{abs(deltas['roas'])}%改善しており、広告効率は好調局面にあります。")
        elif deltas["roas"] <= -10:
            parts.append(f"ROASは前期比で{abs(deltas['roas'])}%低下しており、費用対効果の悪化が見られます。")
        else:
            parts.append("ROASは前期と概ね横ばいで推移しています。")
    # 캠페인 動因
    if movers and movers[0].get("cost_change_pct") is not None:
        m = movers[0]
        direction = "増額" if m["cost_change_pct"] > 0 else "減額"
        parts.append(f"特に変動が大きかったのは「{m['campaign_name']}」で、広告費が{direction}（{dpct(m['cost_change_pct'])}）しました。")
    # 効率トップ/ワースト
    if by_roas:
        best = max(by_roas, key=lambda x: x["roas"])
        worst = min(by_roas, key=lambda x: x["roas"])
        parts.append(f"効率トップは「{best['campaign_name']}」(ROAS {pct(best['roas'])})、最低は「{worst['campaign_name']}」(ROAS {pct(worst['roas'])})となっています。")
    # 結論/提案
    if deltas.get("ad_cost") and deltas.get("gms") and deltas["ad_cost"] > 0 and deltas["gms"] < deltas["ad_cost"]:
        parts.append("広告費の伸びに売上が追いついておらず、低効率キャンペーンの予算見直しを検討する余地があります。")
    elif deltas.get("roas") is not None and deltas["roas"] >= 10:
        parts.append("高ROAS局面のため、上位効率キャンペーンへの予算増額により売上の更なる積み上げが期待できます。")
    return " ".join(parts)


# ----------------------------- HTTP -----------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "SmartProfit/0.1"

    def log_message(self, fmt, *args):  # 콘솔 소음 축소
        pass

    # ---- 공통 응답 ----
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, msg, status=400):
        self._json({"error": str(msg)}, status)

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length", 0) or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8") or "{}")

    def _serve_static(self, rel):
        # "/" → index.html, "/static/x.css" → STATIC_DIR/x.css
        if rel in ("", "/", "/index.html"):
            rel = "index.html"
        elif rel.startswith("/static/"):
            rel = rel[len("/static/"):]
        else:
            rel = rel.lstrip("/")
        path = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not path.startswith(STATIC_DIR) or not os.path.isfile(path):
            self.send_error(404)
            return
        ctype = {".html": "text/html; charset=utf-8",
                 ".js": "application/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8",
                 ".svg": "image/svg+xml"}.get(os.path.splitext(path)[1],
                                              "application/octet-stream")
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---------------- GET ----------------
    def do_GET(self):
        u = urlsplit(self.path)
        path, q = u.path, parse_qs(u.query)
        try:
            if not path.startswith("/api/"):
                return self._serve_static(path)

            db = get_db()
            shop = CONFIG["shop_id"]

            if path == "/api/status":
                ok, msg = session_ok()
                configured = CONFIG.get("db_path") or ""
                actual = db_path()
                cfg_full = configured if os.path.isabs(configured) else os.path.join(HERE, configured)
                fallback = bool(configured and os.path.isabs(configured) and
                                os.path.normpath(cfg_full) != os.path.normpath(actual))
                return self._json({
                    "session": ok, "session_msg": msg,
                    "shop_id": shop, "db_path": actual,
                    "db_configured": configured, "db_fallback": fallback,
                    "db_dir_exists": os.path.isdir(os.path.dirname(actual) or "."),
                    "ai_available": bool(os.environ.get("ANTHROPIC_API_KEY")),
                    "bounds": db.date_bounds(shop),
                    "products": db.products_present(shop),
                    "today": date.today().isoformat(),
                    "yesterday": (date.today() - timedelta(days=1)).isoformat(),
                })

            if path == "/api/coverage":
                return self._json({"coverage": db.coverage(shop)})

            if path == "/api/auth/config":
                # 로컬 server.py 에선 SUPABASE_URL env 가 설정돼 있을 때만 인증 활성화
                return self._json({
                    "supabase_url": os.environ.get("SUPABASE_URL", ""),
                    "supabase_anon_key": os.environ.get("SUPABASE_ANON_KEY", ""),
                    "auth_disabled": not os.environ.get("SUPABASE_URL", ""),
                })

            if path == "/api/lock":
                return self._json({
                    "me": {"id": collector_id(), "label": collector_label()},
                    "lock": lock_status(),
                })

            if path == "/api/jobs":
                jobs = db.list_download_jobs(shop_id=shop, limit=30)
                # 상태별 카운트
                counts = {"pending": 0, "registered": 0, "completed": 0, "failed": 0}
                for j in jobs:
                    counts[j["status"]] = counts.get(j["status"], 0) + 1
                return self._json({"jobs": jobs, "counts": counts})

            if path == "/api/apitest":
                # 범위/단위 제약 검증용. product=rpp|cpa|tda, sel, period, from, to
                def g(k, dft=None): return q.get(k, [dft])[0]
                prod = g("product", "rpp"); frm = g("from"); to = g("to")
                a, b = date.fromisoformat(frm), date.fromisoformat(to)
                c = build_client()
                try:
                    if prod == "rpp":
                        rows = c.fetch_rpp(a, b, selection_type=int(g("sel", "1")),
                                           period_type=int(g("period", "2")))
                    elif prod == "cpa":
                        rows = c.fetch_cpa(a, b, period_type=int(g("period", "2")))
                    else:
                        rows = c.fetch_tda(a, b, period_type=int(g("period", "2")))
                    dates = sorted({str(r.get("effectDate") or r.get("reportDate") or "") for r in rows})
                    return self._json({"ok": True, "rows": len(rows),
                                       "distinct_dates": len([d for d in dates if d]),
                                       "sample_dates": dates[:6],
                                       "keys": list(rows[0].keys())[:22] if rows else []})
                except Exception as e:
                    return self._json({"ok": False, "error": str(e)[:160]})

            if path == "/api/backfill/status":
                snap = dict(BACKFILL)
                snap["log"] = snap["log"][-30:]
                # 실시간 elapsed 계산
                import time as _t
                if snap.get("started_at"):
                    if snap.get("running"):
                        snap["elapsed_seconds"] = int(_t.time() - snap["started_at"])
                    elif snap.get("ended_at"):
                        snap["elapsed_seconds"] = int(snap["ended_at"] - snap["started_at"])
                return self._json(snap)

            if path == "/api/session/diag":
                # 경로별 XSRF 인식 클라이언트로 실제 엔드포인트 end-to-end 테스트
                yday = (date.today() - timedelta(days=1)).isoformat()
                target = q.get("date", [yday])[0]
                d = date.fromisoformat(target)
                xsrf_paths = sorted({c.get("path") for c in SESSION_COOKIES
                                     if c.get("name") == "XSRF-TOKEN"})
                out = {"target": target, "total_cookies": len(SESSION_COOKIES),
                       "xsrf_paths": xsrf_paths}
                try:
                    c = build_client()
                except Exception as e:
                    out["build_error"] = str(e); return self._json(out)
                out["check_session"] = c.check_session()
                try:
                    rows = c.fetch_rpp(d, d, selection_type=1, period_type=2)
                    out["rpp_all"] = {"ok": True, "rows": len(rows),
                                      "keys": list(rows[0].keys())[:25] if rows else []}
                    if q.get("full") and rows:
                        out["rpp_all"]["sample_row"] = rows[0]
                except Exception as e:
                    out["rpp_all"] = {"error": str(e)[:200]}
                try:
                    rows = c.fetch_rpp(d, d, selection_type=2, period_type=2)
                    out["rpp_campaign"] = {"ok": True, "rows": len(rows)}
                except Exception as e:
                    out["rpp_campaign"] = {"error": str(e)[:200]}
                try:
                    out["cpa"] = {"ok": True, "rows": len(c.fetch_cpa(d, d))}
                except Exception as e:
                    out["cpa"] = {"error": str(e)[:200]}
                try:
                    out["tda"] = {"ok": True, "rows": len(c.fetch_tda(d, d))}
                except Exception as e:
                    out["tda"] = {"error": str(e)[:200]}
                return self._json(out)

            # 공통 쿼리 파라미터
            def g(k, d=None): return q.get(k, [d])[0]
            frm = g("from"); to = g("to")
            product = g("product", "RPP")
            prod = None if product in ("ALL", "", None) else product  # None = 전체상품
            sel = int(g("selection_type", "1"))
            seg = g("segment", "all"); win = g("window", "720h")

            if path == "/api/kpis":
                return self._json(build_insights(shop, frm, to, prod, sel, cv_window=win, user_segment=seg))

            if path == "/api/series":
                return self._json({"series": db.daily_series(
                    shop, frm, to, prod, sel, seg, win)})

            if path == "/api/top":
                order = g("order_by", "ad_cost")
                limit = int(g("limit", "10"))
                return self._json({"rows": db.top_dimensions(
                    shop, frm, to, prod, int(g("selection_type", "2")),
                    seg, win, order, limit)})

            if path == "/api/seasonality":
                # 季節性(YoY): 같은 기간을 1년 전과 비교
                from datetime import date as _d
                a, b = _d.fromisoformat(frm), _d.fromisoformat(to)
                py_from = _d(a.year - 1, a.month, min(a.day, 28)).isoformat()
                py_to = _d(b.year - 1, b.month, min(b.day, 28)).isoformat()
                db = get_db()
                cur_kpi = db.kpis(shop, frm, to, prod, 1, user_segment=seg, cv_window=win)
                py_kpi = db.kpis(shop, py_from, py_to, prod, 1, user_segment=seg, cv_window=win)
                cur_series = db.daily_series(shop, frm, to, prod, 1, seg, win)
                py_series = db.daily_series(shop, py_from, py_to, prod, 1, seg, win)
                def yoy(c, p):
                    if not p: return None
                    return round((c - p) / abs(p) * 1000) / 10 if p else None
                return self._json({
                    "current": cur_kpi, "prev_year": py_kpi,
                    "prev_range": {"from": py_from, "to": py_to},
                    "series_current": cur_series, "series_prev": py_series,
                    "yoy": {k: yoy(cur_kpi.get(k) or 0, py_kpi.get(k) or 0)
                            for k in ("gms", "ad_cost", "clicks", "cv", "roas")},
                    "has_prev": bool(py_kpi.get("gms") or py_kpi.get("ad_cost")),
                })

            if path == "/api/cohort":
                # 코호트: 신규 진입 키워드의 N주차 추이 (등장 첫주를 기준 0)
                from datetime import date as _d, timedelta as _td
                a, b = _d.fromisoformat(frm), _d.fromisoformat(to)
                # 7일 단위로 묶음
                weeks = []; ws = a
                while ws <= b:
                    we = min(b, ws + _td(days=6))
                    weeks.append((ws, we)); ws = we + _td(days=1)
                # 키워드별 주간 집계
                db = get_db()
                kw_weekly = {}  # kw -> {week_idx: {cost, gms, clicks, cv}}
                with db.cursor() as cur:
                    cur.execute("""SELECT dimension_key, report_date, SUM(ad_cost) cost, SUM(gms) gms,
                                          SUM(clicks) clicks, SUM(cv) cv
                                     FROM ad_daily_performance
                                    WHERE shop_id=? AND ad_product='RPP' AND selection_type=4
                                      AND user_segment=? AND cv_window=?
                                      AND report_date BETWEEN ? AND ?
                                    GROUP BY dimension_key, report_date""",
                                (shop, seg, win, frm, to))
                    for r in cur.fetchall():
                        dt = _d.fromisoformat(r["report_date"])
                        for i, (ws, we) in enumerate(weeks):
                            if ws <= dt <= we:
                                kw_weekly.setdefault(r["dimension_key"], {}).setdefault(i, {"cost": 0, "gms": 0, "clicks": 0, "cv": 0})
                                bk = kw_weekly[r["dimension_key"]][i]
                                bk["cost"] += r["cost"] or 0; bk["gms"] += r["gms"] or 0
                                bk["clicks"] += r["clicks"] or 0; bk["cv"] += r["cv"] or 0
                                break
                # 첫 등장 주 기준 코호트 정렬
                cohorts = {}  # entry_week -> {kw_count, weeks: [{w0: agg, w1: agg, ...}]}
                for kw, ws in kw_weekly.items():
                    entry = min(ws.keys())
                    cohorts.setdefault(entry, {"kw_count": 0, "trajectory": {}})
                    cohorts[entry]["kw_count"] += 1
                    for wk, agg in ws.items():
                        offset = wk - entry
                        t = cohorts[entry]["trajectory"].setdefault(offset, {"cost": 0, "gms": 0, "clicks": 0, "cv": 0})
                        for k in ("cost", "gms", "clicks", "cv"):
                            t[k] += agg[k]
                out = []
                for entry in sorted(cohorts.keys()):
                    c = cohorts[entry]
                    out.append({
                        "entry_week": weeks[entry][0].isoformat(),
                        "kw_count": c["kw_count"],
                        "trajectory": [{"offset": k, **v,
                                        "roas": (v["gms"] / v["cost"]) if v["cost"] else None}
                                       for k, v in sorted(c["trajectory"].items())]
                    })
                return self._json({"cohorts": out, "weeks": [w[0].isoformat() for w in weeks]})

            if path == "/api/weekday":
                # 요일별 효율: 0=月 ... 6=日
                db = get_db()
                rows = db.daily_series(shop, frm, to, prod, 1, seg, win)
                bucket = [[0, 0, 0, 0, 0] for _ in range(7)]  # [count, ad_cost, gms, clicks, cv]
                for r in rows:
                    if not r.get("report_date"):
                        continue
                    y, m, d = map(int, r["report_date"].split("-"))
                    from datetime import date as _d
                    wd = _d(y, m, d).weekday()
                    b = bucket[wd]
                    b[0] += 1
                    b[1] += r.get("ad_cost") or 0
                    b[2] += r.get("gms") or 0
                    b[3] += r.get("clicks") or 0
                    b[4] += r.get("cv") or 0
                LABELS = ["月", "火", "水", "木", "金", "土", "日"]
                out = []
                for i, (cnt, cost, gms, clicks, cv) in enumerate(bucket):
                    out.append({
                        "weekday": LABELS[i], "wd": i, "days": cnt,
                        "ad_cost": cost, "gms": gms, "clicks": clicks, "cv": cv,
                        "roas": (gms / cost) if cost else None,
                        "avg_gms": (gms / cnt) if cnt else 0,
                        "avg_cost": (cost / cnt) if cnt else 0,
                    })
                return self._json({"weekday": out})

            if path == "/api/keyword_diff":
                # 期間A → 期間B: 신규 진입(B only) / 사라진(A only) / 공통
                db = get_db()
                # A: ?aFrom~?aTo, B: ?from~?to
                a_from = q.get("aFrom", [""])[0]; a_to = q.get("aTo", [""])[0]
                with db.cursor() as cur:
                    cur.execute("""SELECT dimension_key, item_url, SUM(ad_cost) cost, SUM(gms) gms, SUM(clicks) clicks
                                     FROM ad_daily_performance
                                    WHERE shop_id=? AND ad_product='RPP' AND selection_type=4
                                      AND user_segment=? AND cv_window=?
                                      AND report_date BETWEEN ? AND ?
                                    GROUP BY dimension_key, item_url""",
                                (shop, seg, win, a_from, a_to))
                    A = {r["dimension_key"]: dict(r) for r in cur.fetchall() if r["dimension_key"]}
                    cur.execute("""SELECT dimension_key, item_url, SUM(ad_cost) cost, SUM(gms) gms, SUM(clicks) clicks,
                                          CASE WHEN SUM(ad_cost)>0 THEN ROUND(SUM(gms)/SUM(ad_cost),4) END roas
                                     FROM ad_daily_performance
                                    WHERE shop_id=? AND ad_product='RPP' AND selection_type=4
                                      AND user_segment=? AND cv_window=?
                                      AND report_date BETWEEN ? AND ?
                                    GROUP BY dimension_key, item_url""",
                                (shop, seg, win, frm, to))
                    B = {r["dimension_key"]: dict(r) for r in cur.fetchall() if r["dimension_key"]}
                entered = [v for k, v in B.items() if k not in A]
                gone = [v for k, v in A.items() if k not in B]
                kept = []
                for k, b in B.items():
                    if k in A:
                        a = A[k]
                        b_cost = b.get("cost") or 0
                        a_cost = a.get("cost") or 0
                        b_roas = (b.get("gms") or 0) / b_cost if b_cost else None
                        a_roas = (a.get("gms") or 0) / a_cost if a_cost else None
                        kept.append({**b, "a_cost": a_cost, "a_roas": a_roas,
                                     "cost_delta_pct": round((b_cost - a_cost) / a_cost * 1000) / 10 if a_cost else None,
                                     "roas_delta_pct": round((b_roas - a_roas) / a_roas * 1000) / 10 if a_roas else None})
                entered.sort(key=lambda x: -(x.get("cost") or 0))
                gone.sort(key=lambda x: -(x.get("cost") or 0))
                return self._json({"entered": entered[:20], "gone": gone[:20], "kept_count": len(kept)})

            if path == "/api/outliers":
                # 추이 series에서 IQR 기준 이상치 일자만 반환
                db = get_db()
                rows = db.daily_series(shop, frm, to, prod, 1, seg, win)
                if not rows: return self._json({"outliers": []})
                key = q.get("metric", ["gms"])[0]
                vals = sorted(r.get(key) or 0 for r in rows)
                Q1 = vals[len(vals) // 4]; Q3 = vals[len(vals) * 3 // 4]
                iqr = Q3 - Q1
                hi = Q3 + iqr * 1.5; lo = Q1 - iqr * 1.5
                out = []
                for r in rows:
                    v = r.get(key) or 0
                    if v > hi: out.append({"date": r["report_date"], "value": v, "kind": "high", "metric": key})
                    elif v < lo and v >= 0: out.append({"date": r["report_date"], "value": v, "kind": "low", "metric": key})
                return self._json({"outliers": out})

            if path == "/api/categories":
                # 카테고리: SKU prefix 자동 그룹핑 + 사용자 수동 매핑 덮어쓰기
                db = get_db()
                # 매핑 (config 에 sku_categories 로 보관: {sku_prefix_or_full: category})
                manual = CONFIG.get("sku_categories") or {}
                with db.cursor() as cur:
                    cur.execute("""SELECT dimension_key sku, SUM(ad_cost) cost, SUM(gms) gms,
                                          SUM(clicks) clicks, SUM(cv) cv, SUM(impressions) impr
                                     FROM ad_daily_performance
                                    WHERE shop_id=? AND ad_product='RPP' AND selection_type=3
                                      AND user_segment=? AND cv_window=?
                                      AND report_date BETWEEN ? AND ?
                                    GROUP BY dimension_key""",
                                (shop, seg, win, frm, to))
                    skus = [dict(r) for r in cur.fetchall()]
                # 매핑 prefix 길이 내림차순 (긴 prefix 우선매칭)
                sorted_manual = sorted(manual.items(), key=lambda x: -len(x[0]))
                def categorize(sku):
                    if not sku: return "未分類"
                    # 1) 정확일치
                    if sku in manual: return manual[sku]
                    # 2) prefix 일치 (긴 prefix 우선)
                    for prefix, cat in sorted_manual:
                        if sku.startswith(prefix): return cat
                    return "未分類"
                groups = {}
                for s in skus:
                    cat = categorize(s["sku"])
                    g = groups.setdefault(cat, {"category": cat, "skus": [], "cost": 0, "gms": 0, "clicks": 0, "cv": 0, "impr": 0})
                    g["skus"].append(s["sku"])
                    g["cost"] += s["cost"] or 0; g["gms"] += s["gms"] or 0
                    g["clicks"] += s["clicks"] or 0; g["cv"] += s["cv"] or 0
                    g["impr"] += s["impr"] or 0
                out = []
                for g in groups.values():
                    out.append({**g, "sku_count": len(g["skus"]),
                                "roas": (g["gms"] / g["cost"]) if g["cost"] else None,
                                "ctr": (g["clicks"] / g["impr"]) if g["impr"] else None,
                                "cpa": (g["cost"] / g["cv"]) if g["cv"] else None})
                out.sort(key=lambda x: -x["cost"])
                return self._json({"categories": out, "manual_count": len(manual)})

            if path == "/api/item_keywords":
                # 商品×キーワード マトリクス: item_url 기준으로 sel=3 / sel=4 묶기
                #   ① 商品別広告(sel=3) 集計 — item_url로 키, dimension_key(商品管理番号)는 표시용
                #   ② キーワード別広告(sel=4)을 item_url로 묶어 키워드 리스트화
                # 양쪽 같은 item_url을 키로 사용 → 매트릭스 통합 정상 작동
                db = get_db()
                with db.cursor() as cur:
                    # 상품별 광고 — item_url로 그룹화 (dimension_key는 표시용으로 유지)
                    cur.execute("""
                      SELECT item_url, MIN(dimension_key) AS item_no,
                             SUM(clicks) clicks, SUM(impressions) impressions,
                             SUM(ad_cost) ad_cost, SUM(gms) gms, SUM(cv) cv
                        FROM ad_daily_performance
                       WHERE shop_id=? AND ad_product='RPP' AND selection_type=3
                         AND user_segment=? AND cv_window=?
                         AND report_date BETWEEN ? AND ?
                         AND COALESCE(item_url,'')<>''
                       GROUP BY item_url
                    """, (shop, seg, win, frm, to))
                    item_ads = {}
                    for r in cur.fetchall():
                        rd = dict(r)
                        k = rd.get("item_url") or ""
                        rd["item"] = rd.get("item_no") or ""
                        if k:
                            # 비율 지표는 합산 후 재계산
                            cost = rd.get("ad_cost") or 0
                            impr = rd.get("impressions") or 0
                            clk = rd.get("clicks") or 0
                            cv = rd.get("cv") or 0
                            rd["ctr"] = (clk / impr) if impr else None
                            rd["roas"] = ((rd.get("gms") or 0) / cost) if cost else None
                            rd["cvr"] = (cv / clk) if clk else None
                            item_ads[k] = rd
                    # 키워드별 광고
                    cur.execute("""
                      SELECT item_url, dimension_key AS keyword,
                             SUM(clicks) clicks, SUM(impressions) impressions,
                             SUM(ad_cost) ad_cost, SUM(gms) gms, SUM(cv) cv,
                             CASE WHEN SUM(ad_cost)>0 THEN ROUND(SUM(gms)/SUM(ad_cost),4) END roas,
                             CASE WHEN SUM(impressions)>0 THEN ROUND(CAST(SUM(clicks) AS REAL)/SUM(impressions),6) END ctr,
                             CASE WHEN SUM(clicks)>0 THEN ROUND(CAST(SUM(cv) AS REAL)/SUM(clicks),6) END cvr
                        FROM ad_daily_performance
                       WHERE shop_id=? AND ad_product='RPP' AND selection_type=4
                         AND user_segment=? AND cv_window=?
                         AND report_date BETWEEN ? AND ?
                       GROUP BY item_url, dimension_key
                       ORDER BY ad_cost DESC
                       LIMIT 4000
                    """, (shop, seg, win, frm, to))
                    kw_rows = [dict(r) for r in cur.fetchall()]
                # 상품별로 키워드 묶기
                kw_groups = {}
                for r in kw_rows:
                    k = r["item_url"] or "(未紐付け)"
                    kw_groups.setdefault(k, []).append(r)
                # 통합: 모든 상품 키 (상품별 광고 + 키워드 매칭)
                all_keys = set(item_ads.keys()) | set(kw_groups.keys())
                packed = []
                for item in all_keys:
                    ia = item_ads.get(item)
                    kws = kw_groups.get(item, [])
                    item_cost = (ia or {}).get("ad_cost") or 0
                    item_gms = (ia or {}).get("gms") or 0
                    item_clicks = (ia or {}).get("clicks") or 0
                    item_cv = (ia or {}).get("cv") or 0
                    item_impr = (ia or {}).get("impressions") or 0
                    kw_cost = sum(k.get("ad_cost") or 0 for k in kws)
                    kw_gms = sum(k.get("gms") or 0 for k in kws)
                    kw_clicks = sum(k.get("clicks") or 0 for k in kws)
                    kw_cv = sum(k.get("cv") or 0 for k in kws)
                    kw_impr = sum(k.get("impressions") or 0 for k in kws)
                    tot_cost = item_cost + kw_cost
                    tot_gms = item_gms + kw_gms
                    # 純粋 商品CPC = 商品別 - キーワード合算
                    # 비율 지표는 분자/분모를 각각 빼고 재계산 (사용자 메모 그대로)
                    pure = None
                    if ia and item_cost > 0:
                        pure_cost = max(0, item_cost - kw_cost)
                        pure_gms = max(0, item_gms - kw_gms)
                        pure_clicks = max(0, item_clicks - kw_clicks)
                        pure_cv = max(0, item_cv - kw_cv)
                        pure_impr = max(0, item_impr - kw_impr) if item_impr else 0
                        pure = {
                            "ad_cost": pure_cost, "gms": pure_gms,
                            "clicks": pure_clicks, "cv": pure_cv, "impressions": pure_impr,
                            "roas": (pure_gms / pure_cost) if pure_cost > 0 else None,
                            "cpc": (pure_cost / pure_clicks) if pure_clicks > 0 else None,
                            "cpa": (pure_cost / pure_cv) if pure_cv > 0 else None,
                            "ctr": (pure_clicks / pure_impr) if pure_impr > 0 else None,
                            "cvr": (pure_cv / pure_clicks) if pure_clicks > 0 else None,
                            # 외부노출 비중 = 상품CPC만의 광고비 ÷ 상품별 광고비
                            "share": (pure_cost / item_cost) if item_cost > 0 else None,
                        }
                        # 표시용 라벨: 商品管理番号 우선, 없으면 URL 마지막 슬러그
                    item_label = (ia or {}).get("item") if ia else ""
                    if not item_label and item.startswith("http"):
                        # URL 끝의 슬러그 추출 (예: /rinrinrin/ch-105/ → ch-105)
                        parts = [p for p in item.rstrip("/").split("/") if p]
                        item_label = parts[-1] if parts else item
                    packed.append({
                        "item_url": item,
                        "item_label": item_label or item,
                        "keywords": kws,
                        "item_ad": {"ad_cost": item_cost, "gms": item_gms,
                                    "clicks": item_clicks, "cv": item_cv,
                                    "impressions": item_impr,
                                    "ctr": (item_clicks / item_impr) if item_impr else None,
                                    "cvr": (item_cv / item_clicks) if item_clicks else None,
                                    "roas": (item_gms / item_cost) if item_cost else None} if ia else None,
                        "pure": pure,
                        "total_cost": tot_cost, "total_gms": tot_gms,
                        "roas": (tot_gms / tot_cost) if tot_cost else None,
                        "keyword_count": len(kws),
                        "has_item_ad": bool(ia),
                    })
                packed.sort(key=lambda x: -x["total_gms"])
                return self._json({
                    "items": packed,
                    "summary": {
                        "items_total": len(packed),
                        "items_with_keyword": sum(1 for p in packed if p["keyword_count"] > 0),
                        "items_only_item_ad": sum(1 for p in packed if p["has_item_ad"] and p["keyword_count"] == 0),
                        "keyword_only_unmapped": sum(1 for p in packed if not p["has_item_ad"]),
                    },
                })

            if path == "/api/raw":
                # CPA/TDA 등 정규화 미확정 상품의 원본 응답을 동적 표로
                rows = db.get_raw(shop, product, frm, to)
                # 컬럼(union, report_date 먼저) 추출
                fields, seen = ["report_date"], {"report_date"}
                for r in rows:
                    for k in r:
                        if k not in seen:
                            seen.add(k); fields.append(k)
                return self._json({"fields": fields, "rows": rows, "count": len(rows)})

            if path == "/api/data":
                order = g("order_by", "report_date")
                desc = g("desc", "0") in ("1", "true", "True")
                limit = int(g("limit", "500"))
                rows = db.query_performance(shop, frm, to, product if product != "ALL" else None,
                                            sel, seg, win, order, desc, limit)
                return self._json({"rows": rows, "count": len(rows)})

            return self._err("不明なパス", 404)
        except Exception as e:
            traceback.print_exc()
            return self._err(e, 500)

    # ---------------- POST ----------------
    def do_POST(self):
        u = urlsplit(self.path)
        path = u.path
        try:
            body = self._read_json()
            shop = CONFIG["shop_id"]

            if path == "/api/session":
                # 확장에서 {cookies:{name:value}} 또는 {cookie_header:"a=b; c=d"} 또는
                # {storage_state_path:"..."} 로 전송.
                added = 0
                if isinstance(body.get("cookieList"), list):
                    # 확장(신버전): 경로 포함 쿠키 목록 → 전체 교체
                    SESSION_COOKIES[:] = [c for c in body["cookieList"] if c.get("name")]
                    added = len(SESSION_COOKIES); _sync_flat()
                elif isinstance(body.get("cookies"), dict):
                    # 구버전 호환: 평탄 dict (path='/')
                    SESSION_COOKIES[:] = [{"name": k, "value": v, "path": "/",
                                           "domain": ".rakuten.co.jp"}
                                          for k, v in body["cookies"].items()]
                    added = len(SESSION_COOKIES); _sync_flat()
                if body.get("cookie_header"):
                    SESSION_COOKIES[:] = [{"name": p.strip().split("=", 1)[0],
                                           "value": p.strip().split("=", 1)[1],
                                           "path": "/", "domain": ".rakuten.co.jp"}
                                          for p in body["cookie_header"].split(";") if "=" in p]
                    added = len(SESSION_COOKIES); _sync_flat()
                if body.get("storage_state_path"):
                    CONFIG["storage_state_path"] = body["storage_state_path"]
                    save_config(CONFIG); _load_session_from_state()
                save_session()  # 재시작해도 유지
                ok, msg = session_ok()
                return self._json({"ok": ok, "msg": msg, "cookies_loaded": len(SESSION),
                                   "added": added, "has_xsrf": "XSRF-TOKEN" in SESSION})

            if path == "/api/collect":
                frm = body.get("from") or body.get("date")
                to = body.get("to") or body.get("date")
                if not frm:
                    to = (date.today() - timedelta(days=1)).isoformat(); frm = to
                start, end = date.fromisoformat(frm), date.fromisoformat(to)
                if body.get("sample"):
                    return self._json(generate_sample(shop, start, end))
                # 실수집
                ok, msg = session_ok()
                if not ok:
                    return self._err(f"セッション不可: {msg}（拡張機能でクッキー送信、またはサンプルモードをご利用ください）", 401)
                # Drive Lock: 다른 PC가 수집 중이면 차단 (force 옵션으로 무시 가능)
                if not body.get("force_lock"):
                    locked, lk = acquire_lock("collect")
                    if not locked:
                        return self._err(
                            f"他のPC（{lk.get('label') or lk.get('by') or '不明'}）が "
                            f"{lk.get('started_at', '')} から取得中です。"
                            f"完了まで待つか、強制実行してください。", 409)
                try:
                    from collector import collect_range
                    import time as _t
                    _t0 = _t.time()
                    db = get_db()
                    rep = collect_range(build_client(), db, shop, start, end)
                    rep["elapsed_seconds"] = int(_t.time() - _t0)
                    rep["collected_by"] = collector_label()
                    return self._json(rep)
                finally:
                    release_lock()

            if path == "/api/backfill":
                if BACKFILL["running"]:
                    return self._err("一括取得がすでに進行中です。", 409)
                frm = body.get("from"); to = body.get("to")
                if not frm or not to:
                    return self._err("from/to（日付）が必要です。")
                start, end = date.fromisoformat(frm), date.fromisoformat(to)
                if start > end:
                    return self._err("開始日が終了日より後になっています。")
                ok, msg = session_ok()
                if not ok:
                    return self._err(f"セッション不可: {msg}", 401)
                # Drive Lock
                if not body.get("force_lock"):
                    locked, lk = acquire_lock("backfill")
                    if not locked:
                        return self._err(
                            f"他のPC（{lk.get('label') or lk.get('by') or '不明'}）が"
                            f"{lk.get('started_at', '')} から取得中です。", 409)
                delay = float(body.get("delay", 0.4))
                t = threading.Thread(target=_run_backfill_with_lock,
                                     args=(shop, start, end, delay), daemon=True)
                t.start()
                return self._json({"started": True, "months": len(month_chunks(start, end))})

            if path == "/api/backfill/cancel":
                BACKFILL["cancel"] = True
                return self._json({"ok": True})

            if path == "/api/backfill/reset":
                # 강제 리셋 (진행 중 thread는 cancel 플래그로 다음 chunk에서 멈춤)
                BACKFILL.update(running=False, cancel=True, total=0, done=0,
                                ok=0, failed=0, rows=0, current="",
                                log=[], error=None, totals={}, skips={}, notes=[],
                                started_at=None, ended_at=None, elapsed_seconds=0)
                return self._json({"ok": True})

            if path == "/api/refill":
                if BACKFILL["running"]:
                    return self._err("処理がすでに進行中です。", 409)
                ok, msg = session_ok()
                if not ok:
                    return self._err(f"セッション不可: {msg}", 401)
                # 作業量を事前計算（空き日数）
                units = 0
                for sel, label, missing in find_gaps(get_db(), shop):
                    units += len(_date_runs(missing)) if sel in (1, 2) else len(missing)
                t = threading.Thread(target=run_refill, args=(shop,), daemon=True)
                t.start()
                return self._json({"started": True, "units": units})

            if path == "/api/insights":
                return self._json(build_insights(
                    shop, body["from"], body["to"],
                    body.get("product", "RPP"), int(body.get("selection_type", 1)),
                    cv_window=body.get("window", "720h")))

            if path == "/api/reprocess":
                # 저장된 TDA 원본(ad_daily_raw) → 정규화 테이블로 변환(재수집 없이 대시보드 반영)
                from rakuten_client import normalize_tda
                db = get_db()
                rows_all = []
                with db.cursor() as cur:
                    cur.execute("SELECT payload FROM ad_daily_raw WHERE shop_id=? AND ad_product='TDA'", (shop,))
                    for rec in cur.fetchall():
                        try:
                            rows_all += json.loads(rec["payload"]) or []
                        except Exception:
                            pass
                n = db.upsert_performance(normalize_tda(rows_all, shop))
                return self._json({"reprocessed_tda": n})

            if path == "/api/chat":
                question = (body.get("question") or "").strip()
                if not question:
                    return self._err("質問が空です。")
                if not os.environ.get("ANTHROPIC_API_KEY"):
                    return self._err("ANTHROPIC_API_KEY 未設定 — AIチャットは無効です。"
                                     "環境変数を設定してサーバーを再起動してください。（インサイトはキーなしで動作）", 503)
                from ai_chat import ask
                ans = ask(question, shop_id=shop, db=get_db())
                return self._json({"answer": ans})

            if path == "/api/config":
                for k in ("shop_id", "db_path", "storage_state_path", "lookback_days"):
                    if k in body and body[k] not in (None, ""):
                        CONFIG[k] = body[k]
                if "sku_categories" in body and isinstance(body["sku_categories"], dict):
                    CONFIG["sku_categories"] = body["sku_categories"]
                save_config(CONFIG)
                return self._json({"ok": True, "config": CONFIG, "db_path": db_path()})

            if path == "/api/categories/auto_suggest":
                # 키워드 광고비 기반 SKU → 카테고리 자동 추정
                # 알고리즘: 각 SKU에 매달린 키워드들 중 광고비 최대인 키워드를
                #           그 SKU의 카테고리로 추정 (상품 종류를 가장 잘 대표한다고 가정)
                frm2 = body.get("from") or "2000-01-01"
                to2 = body.get("to") or "9999-12-31"
                db = get_db()
                with db.cursor() as cur:
                    cur.execute("""SELECT item_url, dimension_key,
                                          SUM(ad_cost) cost
                                     FROM ad_daily_performance
                                    WHERE shop_id=? AND ad_product='RPP' AND selection_type=4
                                      AND item_url<>'' AND dimension_key<>''
                                      AND report_date BETWEEN ? AND ?
                                    GROUP BY item_url, dimension_key
                                    ORDER BY item_url, cost DESC""",
                                (CONFIG.get("shop_id", ""), frm2, to2))
                    rows = [dict(r) for r in cur.fetchall()]
                # SKU별 최다 광고비 키워드를 카테고리로
                seen = set(); suggested = {}
                for r in rows:
                    sku = r["item_url"]
                    if sku in seen: continue
                    seen.add(sku); suggested[sku] = r["dimension_key"]
                # 기존 수동 매핑은 덮어쓰지 않게 정보로 반환
                existing = CONFIG.get("sku_categories") or {}
                merged = dict(suggested)
                merged.update(existing)  # 사용자 매핑이 우선
                return self._json({"suggested": suggested, "merged": merged,
                                   "new_count": len([k for k in suggested if k not in existing])})

            if path == "/api/categories/mapping":
                # 매핑 단독 갱신/조회
                if isinstance(body.get("mapping"), dict):
                    CONFIG["sku_categories"] = body["mapping"]
                    save_config(CONFIG)
                return self._json({"mapping": CONFIG.get("sku_categories", {})})

            if path == "/api/export":
                # DB 사본을 대상 폴더(예: Google Drive 동기화 폴더)로 복사
                target = body.get("target_dir")
                if not target:
                    return self._err("target_dir が必要です。")
                os.makedirs(target, exist_ok=True)
                stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                dst = os.path.join(target, f"smartprofit_{stamp}.db")
                shutil.copy2(db_path(), dst)
                return self._json({"ok": True, "saved": dst})

            return self._err("不明なパス", 404)
        except Exception as e:
            traceback.print_exc()
            return self._err(e, 500)


def main():
    # Windows 콘솔 인코딩(cp932/cp949 등)에서 한글 print 가 깨지지 않도록 UTF-8 강제
    try:
        import sys
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    # 멈춤 진단: 60초마다 모든 thread stack trace 자동 출력
    import faulthandler
    faulthandler.enable()
    try:
        faulthandler.dump_traceback_later(60, repeat=True)
    except Exception:
        pass
    load_session_file()
    _load_session_from_state()
    host = CONFIG.get("host", "127.0.0.1")
    port = int(CONFIG.get("port", 8765))
    # DB 디렉터리 보장
    os.makedirs(os.path.dirname(db_path()) or ".", exist_ok=True)
    # 백그라운드 다운로드 워커는 option B (동기 collect)로 전환 후 비활성화
    # 필요 시 download_jobs 큐는 수동 관리용으로 남김
    httpd = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{host}:{port}"
    print("=" * 56)
    print("  広告ダッシュボード (楽天RMS)")
    print(f"  ▶ ブラウザで開く:   {url}")
    print(f"  ▶ DB 保存先:        {db_path()}")
    print(f"  ▶ AIチャット:       {'有効' if os.environ.get('ANTHROPIC_API_KEY') else '無効 (ANTHROPIC_API_KEY なし)'}")
    print("  (終了: Ctrl+C)")
    print("=" * 56)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n終了します。")


if __name__ == "__main__":
    main()
