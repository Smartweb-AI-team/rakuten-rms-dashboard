"""
main.py — Vercel FastAPI 엔트리 (루트).

로컬 개발:
  uvicorn main:app --reload --port 8765

본번:
  Vercel FastAPI preset 자동 인식.
"""
from __future__ import annotations
import os, json
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.abspath(__file__))

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(ROOT, ".env"))
except Exception:
    pass

from fastapi import FastAPI, Request, HTTPException, Body, Depends, BackgroundTasks
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from db import DB, IS_PG

# ----------------------------- Hybrid (Vercel + Cloud Run worker) -----------------------------
# IS_WORKER=1   → Cloud Run 측: 백필을 실제 실행
# IS_WORKER 없음 → Vercel 측: 백필 요청 받으면 WORKER_URL 로 forward
IS_WORKER     = os.environ.get("IS_WORKER", "0") == "1"
WORKER_URL    = os.environ.get("WORKER_URL", "").rstrip("/")
WORKER_SECRET = os.environ.get("WORKER_SECRET", "")

# ----------------------------- Auth -----------------------------
# 멤버 = Supabase JWT (브라우저 로그인 후 Authorization: Bearer <jwt>)
# 확장 = EXTENSION_TOKEN (.env / Vercel env). /api/session 만 허용.
SUPABASE_URL        = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "")   # 구형 HS256 호환
EXTENSION_TOKEN     = os.environ.get("EXTENSION_TOKEN", "")
AUTH_DISABLED       = (os.environ.get("AUTH_DISABLED", "0") == "1"
                       or not (SUPABASE_URL or SUPABASE_JWT_SECRET))

try:
    import jwt as _jwt
    from jwt import PyJWKClient as _PyJWKClient
except ImportError:
    _jwt = None
    _PyJWKClient = None

_jwks_client = None
def _get_jwks_client():
    """Supabase JWKS endpoint (ECC P-256 공개키) 캐시."""
    global _jwks_client
    if _jwks_client is None and _PyJWKClient and SUPABASE_URL:
        try:
            _jwks_client = _PyJWKClient(f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json")
        except Exception:
            _jwks_client = None
    return _jwks_client

def _verify_supabase_jwt(token: str) -> dict | None:
    if not _jwt:
        return None
    # ① ECC (신형 비대칭) — JWKS 로부터 공개키 가져와 ES256 검증
    client = _get_jwks_client()
    if client:
        try:
            key = client.get_signing_key_from_jwt(token).key
            return _jwt.decode(token, key, algorithms=["ES256", "RS256"],
                               audience="authenticated")
        except Exception:
            pass
    # ② HS256 (구형) — Legacy JWT Secret 사용 시
    if SUPABASE_JWT_SECRET:
        try:
            return _jwt.decode(token, SUPABASE_JWT_SECRET, algorithms=["HS256"],
                               audience="authenticated")
        except Exception:
            pass
    return None

def auth_required(req: Request) -> dict:
    """모든 보호 라우트 의존성. AUTH_DISABLED=1 이면 무시."""
    if AUTH_DISABLED:
        return {"sub": "local", "email": "local@dev"}
    h = req.headers.get("authorization", "")
    if not h.startswith("Bearer "):
        raise HTTPException(401, "ログインが必要です")
    token = h[7:].strip()
    user = _verify_supabase_jwt(token)
    if not user:
        raise HTTPException(401, "セッションが無効です。再ログインしてください。")
    return user

def auth_session_or_ext(req: Request) -> dict:
    """/api/session 전용 — 멤버 JWT OR 확장 토큰 둘 다 허용."""
    if AUTH_DISABLED:
        return {"sub": "local"}
    h = req.headers.get("authorization", "")
    if not h.startswith("Bearer "):
        raise HTTPException(401, "認証が必要です")
    token = h[7:].strip()
    if EXTENSION_TOKEN and token == EXTENSION_TOKEN:
        return {"sub": "extension"}
    user = _verify_supabase_jwt(token)
    if not user:
        raise HTTPException(401, "認証失敗")
    return user

app = FastAPI(title="Rakuten RMS Analytics", docs_url=None, redoc_url=None)

# CORS — Chrome 확장에서 POST /api/session 호출 허용
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # MVP. 운영 시 chrome-extension://<id> 로 제한 가능
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ----------------------------- Helpers -----------------------------
def get_db() -> DB:
    return DB()

def get_config() -> dict:
    """KV에서 설정 읽기. 없으면 환경변수 / 기본값."""
    db = get_db()
    cfg = db.kv_get("config", {}) or {}
    db.close()
    # 환경변수 우선
    if os.environ.get("SHOP_ID"):
        cfg["shop_id"] = os.environ["SHOP_ID"]
    cfg.setdefault("shop_id", "")
    cfg.setdefault("lookback_days", 14)
    return cfg

def save_config(cfg: dict) -> None:
    db = get_db()
    db.kv_set("config", cfg)
    db.close()

def get_session_cookies() -> list[dict]:
    db = get_db()
    cookies = db.kv_get("session_cookies", []) or []
    db.close()
    return cookies

def set_session_cookies(cookies: list[dict]) -> None:
    db = get_db()
    db.kv_set("session_cookies", cookies)
    db.close()

def session_flat() -> dict[str, str]:
    """name -> value (path 무시 평탄)."""
    return {c["name"]: c["value"] for c in get_session_cookies() if c.get("name")}

def session_ok() -> tuple[bool, str]:
    flat = session_flat()
    if "XSRF-TOKEN" not in flat:
        return False, "クッキー未受信 (XSRF-TOKEN なし)"
    return True, "有効"  # 실제 楽天 API 호출은 collect 시점에 검증

# ----------------------------- Routes -----------------------------
@app.get("/api/status")
def api_status(user: dict = Depends(auth_required)):
    cfg = get_config()
    db = get_db()
    bounds = db.date_bounds(cfg.get("shop_id", ""))
    products = db.products_present(cfg.get("shop_id", ""))
    db.close()
    ok, msg = session_ok()
    today = date.today()
    return {
        "session": ok, "session_msg": msg,
        "shop_id": cfg.get("shop_id", ""),
        "backend": "postgres" if IS_PG else "sqlite",
        "ai_available": False,
        "bounds": bounds,
        "products": products,
        "today": today.isoformat(),
        "yesterday": (today - timedelta(days=1)).isoformat(),
    }

@app.post("/api/session")
async def api_session(req: Request, _u: dict = Depends(auth_session_or_ext)):
    """확장(브라우저) → 楽天 쿠키 수신."""
    body = await req.json()
    cookies: list[dict] = []
    if isinstance(body.get("cookieList"), list):
        cookies = [c for c in body["cookieList"] if c.get("name")]
    elif isinstance(body.get("cookies"), dict):
        cookies = [{"name": k, "value": v, "path": "/", "domain": ".rakuten.co.jp"}
                   for k, v in body["cookies"].items()]
    elif body.get("cookie_header"):
        cookies = [{"name": p.strip().split("=", 1)[0],
                    "value": p.strip().split("=", 1)[1],
                    "path": "/", "domain": ".rakuten.co.jp"}
                   for p in body["cookie_header"].split(";") if "=" in p]
    set_session_cookies(cookies)
    ok, msg = session_ok()
    return {"ok": ok, "msg": msg, "cookies_loaded": len(cookies),
            "added": len(cookies),
            "has_xsrf": "XSRF-TOKEN" in {c["name"] for c in cookies}}

@app.get("/api/coverage")
def api_coverage(_u: dict = Depends(auth_required)):
    cfg = get_config()
    db = get_db()
    cov = db.coverage(cfg.get("shop_id", ""))
    db.close()
    return {"coverage": cov}

def _parse_common(kw: dict) -> dict:
    """프론트가 보내는 짧은 이름 (from, to, product, window, segment) 정규화."""
    return {
        "from":           kw.get("from") or kw.get("date_from"),
        "to":             kw.get("to") or kw.get("date_to"),
        "product":        kw.get("product") or kw.get("ad_product") or "RPP",
        "window":         kw.get("window") or kw.get("cv_window") or "720h",
        "segment":        kw.get("segment") or kw.get("user_segment") or "all",
        "selection_type": int(kw.get("selection_type", 1)),
        "order_by":       kw.get("order_by", "report_date"),
        "desc":           str(kw.get("desc", "")).lower() == "true",
        "limit":          int(kw.get("limit", 500)),
        "user":           True,  # auth_required 통과한 상태 (라우트가 호출되면)
    }

def _pct(cur, prev):
    if prev in (None, 0): return None
    try: return round((cur - prev) / prev * 100, 1)
    except: return None

@app.get("/api/kpis")
def api_kpis(req: Request, _u: dict = Depends(auth_required)):
    p = _parse_common(dict(req.query_params))
    cfg = get_config(); db = get_db()
    shop = cfg.get("shop_id", "")
    cur = db.kpis(shop, p["from"], p["to"], ad_product=p["product"],
                  selection_type=p["selection_type"],
                  user_segment=p["segment"], cv_window=p["window"])
    # 비교 기간 자동 계산 (같은 길이의 직전 기간)
    days = (date.fromisoformat(p["to"]) - date.fromisoformat(p["from"])).days + 1
    prev_to = (date.fromisoformat(p["from"]) - timedelta(days=1)).isoformat()
    prev_from = (date.fromisoformat(prev_to) - timedelta(days=days - 1)).isoformat()
    prev = db.kpis(shop, prev_from, prev_to, ad_product=p["product"],
                   selection_type=p["selection_type"],
                   user_segment=p["segment"], cv_window=p["window"])
    deltas = {k: _pct(cur.get(k), prev.get(k))
              for k in ("ad_cost", "gms", "clicks", "cv", "roas", "cpc")}
    db.close()
    return {
        "current": cur, "previous": prev,
        "previous_range": {"from": prev_from, "to": prev_to},
        "deltas": deltas,
        "movers": [], "bullets": [], "actions": [],
        "headline": "", "narrative": "", "note": "",
        "impressions_last_date": None,
    }

@app.get("/api/series")
def api_series(req: Request, _u: dict = Depends(auth_required)):
    p = _parse_common(dict(req.query_params))
    cfg = get_config(); db = get_db()
    r = db.daily_series(cfg.get("shop_id", ""), p["from"], p["to"],
                        ad_product=p["product"], selection_type=p["selection_type"],
                        user_segment=p["segment"], cv_window=p["window"])
    db.close()
    return {"series": r}

@app.get("/api/top")
def api_top(req: Request, _u: dict = Depends(auth_required)):
    qp = dict(req.query_params)
    p = _parse_common(qp)
    cfg = get_config(); db = get_db()
    r = db.top_dimensions(cfg.get("shop_id", ""), p["from"], p["to"],
                          ad_product=p["product"],
                          selection_type=int(qp.get("selection_type", 2)),
                          user_segment=p["segment"], cv_window=p["window"],
                          order_by=qp.get("order_by", "ad_cost"),
                          limit=int(qp.get("limit", 10)))
    db.close()
    return {"rows": r}

@app.get("/api/data")
def api_data(req: Request, _u: dict = Depends(auth_required)):
    p = _parse_common(dict(req.query_params))
    cfg = get_config(); db = get_db()
    rows = db.query_performance(cfg.get("shop_id", ""), p["from"], p["to"],
                                ad_product=None if p["product"] == "ALL" else p["product"],
                                selection_type=p["selection_type"],
                                user_segment=p["segment"], cv_window=p["window"],
                                order_by=p["order_by"], desc=p["desc"],
                                limit=p["limit"])
    db.close()
    return {"rows": rows, "count": len(rows)}

@app.get("/api/raw")
def api_raw(req: Request, _u: dict = Depends(auth_required)):
    p = _parse_common(dict(req.query_params))
    cfg = get_config(); db = get_db()
    rows = db.get_raw(cfg.get("shop_id", ""), p["product"], p["from"], p["to"])
    db.close()
    fields, seen = ["report_date"], {"report_date"}
    for r in rows:
        for k in r:
            if k not in seen:
                seen.add(k); fields.append(k)
    return {"fields": fields, "rows": rows, "count": len(rows)}

# MVP 스텁 — 백그라운드 작업 라우트
@app.get("/api/jobs")
def api_jobs(_u: dict = Depends(auth_required)):
    return {"jobs": [], "counts": {"pending": 0, "registered": 0, "completed": 0, "failed": 0}}

@app.post("/api/backfill/cancel")
async def api_backfill_cancel(_u: dict = Depends(auth_required)):
    """진행 중/대기 중인 모든 백필 job 을 'cancelled' 로 표시 + 워커에 cancel 신호."""
    db = get_db()
    cancelled = 0
    for j in db.list_download_jobs(limit=50):
        if j["status"] in ("pending", "registered"):
            db.update_download_job(j["id"], status="cancelled",
                                   error_msg="ユーザーがキャンセル")
            cancelled += 1
    # KV 의 진행률에 cancel 플래그 → 워커가 chunk 사이/pipeline 내부에서 감지하고 중단
    prog = db.kv_get("backfill_progress", {}) or {}
    prog["cancel"] = True
    db.kv_set("backfill_progress", prog)
    db.close()
    return {"ok": True, "cancelled": cancelled}

@app.post("/api/backfill/reset")
async def api_backfill_reset(_u: dict = Depends(auth_required)):
    """모든 stuck job 정리 (관리자용)."""
    return await api_backfill_cancel()

@app.get("/api/backfill/status")
def api_backfill_status(_u: dict = Depends(auth_required)):
    """워커가 app_kv 의 'backfill_progress' 에 저장한 실시간 진행률을 그대로 반환."""
    db = get_db()
    prog = db.kv_get("backfill_progress", {}) or {}
    db.close()
    base = {"running": False, "done": 0, "total": 0, "ok": 0, "failed": 0,
            "rows": 0, "elapsed_seconds": 0, "totals": {}, "skips": {},
            "notes": [], "log": [], "current": "", "error": None}
    return {**base, **prog}

PRODUCT_LABELS = [("RPP_sel1", "全体広告"), ("RPP_sel2", "キャンペーン別"),
                  ("RPP_item", "商品別"), ("RPP_keyword", "キーワード別"),
                  ("CPA_rows", "CPA"), ("TDA_rows", "TDA")]

def _month_chunks(start: date, end: date):
    chunks, s = [], start
    while s <= end:
        nxt = date(s.year + 1, 1, 1) if s.month == 12 else date(s.year, s.month + 1, 1)
        chunks.append((s, min(end, nxt - timedelta(days=1))))
        s = nxt
    return chunks

def _save_progress(prog: dict):
    """진행률을 app_kv 에 저장 (status 엔드포인트가 읽음)."""
    try:
        db = get_db()
        db.kv_set("backfill_progress", prog)
        db.close()
    except Exception as e:
        print(f"[backfill] _save_progress fail: {e}", flush=True)

def _do_backfill_worker(job_id: int, frm: str, to: str, shop_id: str):
    """Cloud Run 워커 — 로컬 _run_backfill 과 동등:
    - sel=1/2 는 월별 range call (collect_range 의 1차 step 만)
    - sel=3/4 는 일별 downloadAsync 를 fetch_rpp_csvs_pipeline 으로 4-parallel
    - 진행률 = 일 단위 (progress_cb 가 KV 에 매번 저장)
    """
    import sys, traceback, time as _t
    def log(msg):
        print(f"[backfill #{job_id}] {msg}", flush=True)

    t0 = _t.time()
    start = date.fromisoformat(frm)
    end_input = date.fromisoformat(to)
    # 楽天 은 今日 거부 → 어제까지로 자름
    yesterday = date.today() - timedelta(days=1)
    end = min(end_input, yesterday)
    # ITEM/KEYWORD 은 2년 (760일) 이내만
    item_cutoff = date.today() - timedelta(days=760)
    istart = max(start, item_cutoff)

    # 일별 작업 = sel=3/4 × 모든 일자 (이게 총 작업 수)
    day_jobs = []
    d = istart
    while d <= end:
        day_jobs.append((3, 13, d, d))  # 商品
        day_jobs.append((4, 14, d, d))  # キーワード
        d += timedelta(days=1)

    # sel=1/2 chunks (월 단위)
    rpp_chunks = _month_chunks(start, end)

    total_units = len(day_jobs) + len(rpp_chunks) * 2  # 2 = sel1 + sel2

    prog = {
        "running": True, "total": total_units, "done": 0,
        "ok": 0, "failed": 0, "rows": 0, "current": "",
        "totals": {lbl: 0 for _, lbl in PRODUCT_LABELS},
        "skips": {}, "notes": [], "log": [], "error": None,
        "started_at": t0, "elapsed_seconds": 0,
        "from": frm, "to": end.isoformat(), "job_id": job_id,
    }
    _save_progress(prog)
    log(f"START shop={shop_id} {start}~{end} (sel1/2 {len(rpp_chunks)*2} + sel3/4 {len(day_jobs)} units)")

    db = get_db()
    try:
        from rakuten_client import (RakutenAdClient, normalize_rpp,
                                     normalize_rpp_item_csv, normalize_rpp_keyword_csv,
                                     SEL_ALL, SEL_CAMPAIGN, PERIOD_DAY)
        cookies = get_session_cookies()
        log(f"cookies: {len(cookies)} items")
        flat = {c["name"]: c["value"] for c in cookies if c.get("name")}
        if "XSRF-TOKEN" not in flat:
            prog["error"] = "楽天セッション無効: 拡張機能で再送信"; prog["running"] = False
            _save_progress(prog)
            db.update_download_job(job_id, status="failed", error_msg=prog["error"])
            return
        db.update_download_job(job_id, status="registered")
        client = RakutenAdClient(cookies)
        if not client.check_session():
            prog["error"] = "楽天セッション切れ"; prog["running"] = False
            _save_progress(prog)
            db.update_download_job(job_id, status="failed", error_msg=prog["error"])
            return

        def _is_cancelled() -> bool:
            try:
                d2 = get_db()
                p2 = d2.kv_get("backfill_progress", {}) or {}
                d2.conn.close()
                return bool(p2.get("cancel"))
            except Exception:
                return False

        # ============ STEP 1: sel=1/2 월별 range (빠름) ============
        for cs, ce in rpp_chunks:
            if _is_cancelled():
                log("CANCELLED by user")
                prog["log"].append("⏹ ユーザーキャンセル")
                break
            label_chunk = cs.strftime("%Y-%m")
            for sel, sel_label in ((SEL_ALL, "全体広告"), (SEL_CAMPAIGN, "キャンペーン別")):
                if _is_cancelled():
                    break
                prog["current"] = f"{label_chunk} · {sel_label}"
                prog["elapsed_seconds"] = int(_t.time() - t0)
                _save_progress(prog)
                try:
                    rows = client.fetch_rpp(cs, ce, selection_type=sel, period_type=PERIOD_DAY)
                    n = db.upsert_performance(normalize_rpp(rows, shop_id, sel))
                    prog["totals"][sel_label] += n
                    prog["rows"] += n
                    prog["ok"] += 1
                    prog["log"].append(f"{label_chunk} {sel_label}: {n}件")
                    log(f"  {label_chunk} {sel_label}: {n} rows")
                except Exception as e:
                    prog["failed"] += 1
                    reason = "上限超過/データなし" if "400" in str(e) else str(e)[:60]
                    prog["skips"][f"{sel_label} · {reason}"] = prog["skips"].get(f"{sel_label} · {reason}", 0) + 1
                    log(f"  {label_chunk} {sel_label}: FAIL {reason}")
                prog["done"] += 1
                prog["elapsed_seconds"] = int(_t.time() - t0)
                _save_progress(prog)

        # ============ STEP 2: sel=3/4 일별 pipeline (4-parallel) ============
        if day_jobs and not _is_cancelled():
            log(f"pipeline starting: {len(day_jobs)} day-jobs (4-parallel)")
            done_in_pipe = [0]
            def _progress_cb(done_now, total_now):
                done_in_pipe[0] = done_now
                prog["current"] = f"商品・キーワード ({done_now}/{total_now})"
                prog["elapsed_seconds"] = int(_t.time() - t0)
                _save_progress(prog)

            try:
                csvs = client.fetch_rpp_csvs_pipeline(
                    day_jobs,
                    max_concurrent=4,
                    poll_interval=5.0,
                    max_wait=max(7200.0, len(day_jobs) * 60.0),
                    progress_cb=_progress_cb,
                    cancel_cb=_is_cancelled)
                for (sel, rt, st_iso, ed_iso), csv_text in csvs.items():
                    if not csv_text:
                        prog["failed"] += 1
                        lbl = "商品別" if sel == 3 else "キーワード別"
                        prog["skips"][f"{lbl} · ダウンロード未完了"] = prog["skips"].get(f"{lbl} · ダウンロード未完了", 0) + 1
                    else:
                        if sel == 4:
                            rows = normalize_rpp_keyword_csv(csv_text, shop_id)
                            lbl = "キーワード別"
                        else:
                            rows = normalize_rpp_item_csv(csv_text, shop_id)
                            lbl = "商品別"
                        n = db.upsert_performance(rows)
                        prog["totals"][lbl] += n
                        prog["rows"] += n
                        prog["ok"] += 1
                    prog["done"] = len(rpp_chunks) * 2 + done_in_pipe[0]
                    prog["log"] = prog["log"][-300:]
                    _save_progress(prog)
                log(f"pipeline done")
            except Exception as e:
                prog["error"] = f"pipeline error: {str(e)[:200]}"
                log(f"pipeline EXCEPTION: {e}")
                traceback.print_exc(file=sys.stdout)

        db.update_download_job(job_id, status="completed", normalized_rows=prog["rows"])
        log(f"DONE total_rows={prog['rows']} ok={prog['ok']} failed={prog['failed']}")
    except Exception as e:
        log(f"EXCEPTION: {e}")
        traceback.print_exc(file=sys.stdout)
        prog["error"] = str(e)[:300]
        db.update_download_job(job_id, status="failed", error_msg=str(e)[:500])
    finally:
        prog["running"] = False
        prog["current"] = ""
        prog["elapsed_seconds"] = int(_t.time() - t0)
        _save_progress(prog)
        try: db.close()
        except: pass
        log("END")

@app.post("/api/backfill")
async def api_backfill(req: Request, bg: BackgroundTasks, _u: dict = Depends(auth_required)):
    """
    Vercel 측: 요청 받으면 WORKER_URL (Cloud Run) 로 forward + DB에 job 등록.
    Cloud Run 측 (IS_WORKER=1): BackgroundTasks 로 실제 collect_range 실행.
    """
    body = await req.json()
    frm, to_ = body.get("from"), body.get("to")
    if not frm or not to_:
        raise HTTPException(400, "from/to (日付) が必要です")
    try:
        date.fromisoformat(frm); date.fromisoformat(to_)
    except Exception:
        raise HTTPException(400, "日付形式が不正です (YYYY-MM-DD)")
    cfg = get_config()
    shop = cfg.get("shop_id", "")
    if not shop:
        raise HTTPException(400, "店舗ID未設定")

    db = get_db()
    job_id = db.add_download_job(shop, 0, 0, "backfill", frm, to_)
    db.close()

    # 개월 수 (UI 표시용)
    from datetime import date as _d
    months = ((_d.fromisoformat(to_).year - _d.fromisoformat(frm).year) * 12 +
              (_d.fromisoformat(to_).month - _d.fromisoformat(frm).month) + 1)

    if IS_WORKER:
        bg.add_task(_do_backfill_worker, job_id, frm, to_, shop)
        return {"ok": True, "started": True, "job_id": job_id, "months": months, "where": "worker"}

    # Vercel → Cloud Run forward — 모든 시도/결과를 응답에 직접 포함 (디버그 가능)
    forward_debug = {"worker_url": WORKER_URL, "have_secret": bool(WORKER_SECRET),
                     "status": None, "response": None, "error": None,
                     "elapsed_ms": None}
    if not WORKER_URL:
        forward_debug["error"] = "WORKER_URL env var not set on Vercel"
        raise HTTPException(503, json.dumps({"msg": "ワーカー未設定", "debug": forward_debug}))

    forward_url = f"{WORKER_URL}/api/backfill"
    import time as _t
    t0 = _t.time()
    try:
        import requests as _rq
        headers = {"Content-Type": "application/json"}
        if WORKER_SECRET:
            headers["X-Worker-Secret"] = WORKER_SECRET
        auth_h = req.headers.get("authorization", "")
        if auth_h:
            headers["Authorization"] = auth_h
        r = _rq.post(forward_url,
                     json={"from": frm, "to": to_, "_job_id": job_id},
                     headers=headers, timeout=15)
        forward_debug["elapsed_ms"] = int((_t.time() - t0) * 1000)
        forward_debug["status"] = r.status_code
        forward_debug["response"] = r.text[:500]
        if r.status_code >= 400:
            db2 = get_db()
            db2.update_download_job(job_id, status="failed",
                                    error_msg=f"worker {r.status_code}: {r.text[:200]}")
            db2.close()
            return {"ok": False, "job_id": job_id, "months": months,
                    "error": f"worker returned {r.status_code}", "debug": forward_debug}
    except Exception as e:
        forward_debug["elapsed_ms"] = int((_t.time() - t0) * 1000)
        forward_debug["error"] = f"{type(e).__name__}: {str(e)[:300]}"
        db2 = get_db()
        db2.update_download_job(job_id, status="failed",
                                error_msg=f"forward {type(e).__name__}: {str(e)[:200]}")
        db2.close()
        return {"ok": False, "job_id": job_id, "months": months,
                "error": forward_debug["error"], "debug": forward_debug}
    return {"ok": True, "started": True, "job_id": job_id, "months": months,
            "where": "vercel→worker", "debug": forward_debug}

@app.post("/api/collect")
async def api_collect(req: Request, _u: dict = Depends(auth_required)):
    """単日〜短期間(目安7日以内)の取得。Vercelの60秒制約内で完了する範囲のみ。"""
    body = await req.json()
    cfg = get_config()
    shop = cfg.get("shop_id", "")
    if not shop:
        raise HTTPException(400, "店舗ID未設定")
    frm = body.get("from") or body.get("date")
    to_ = body.get("to") or body.get("date")
    if not frm:
        to_ = (date.today() - timedelta(days=1)).isoformat()
        frm = to_
    start, end = date.fromisoformat(frm), date.fromisoformat(to_)
    days = (end - start).days + 1
    if days > 14:
        raise HTTPException(
            400,
            f"指定期間 {days}日 はVercelの時間制約を超えます。"
            "7日以内で再試行するか、過去の大量取得はローカルで実行してください。")

    # 楽天 cookie 확인
    cookies = get_session_cookies()
    flat = {c["name"]: c["value"] for c in cookies if c.get("name")}
    if "XSRF-TOKEN" not in flat:
        raise HTTPException(401, "楽天セッションが無効です。RMS広告ページに再ログインして拡張機能でCookie送信してください。")

    try:
        from rakuten_client import RakutenAdClient
        from collector import collect_range
        import time as _t
        client = RakutenAdClient(cookies)
        db = get_db()
        t0 = _t.time()
        rep = collect_range(client, db, shop, start, end)
        rep["elapsed_seconds"] = int(_t.time() - t0)
        db.close()
        return rep
    except Exception as e:
        raise HTTPException(500, f"取得失敗: {str(e)[:200]}")

@app.post("/api/config")
async def api_config(req: Request, _u: dict = Depends(auth_required)):
    body = await req.json()
    cfg = get_config()
    cfg.update({k: v for k, v in body.items() if v is not None})
    save_config(cfg)
    return {"ok": True, "config": cfg}

@app.get("/api/config")
def api_config_get(_u: dict = Depends(auth_required)):
    return get_config()

@app.get("/api/auth/config")
def api_auth_config():
    """클라이언트(브라우저)가 Supabase 로그인 폼 띄우기 위한 공개 정보."""
    return {
        "supabase_url": SUPABASE_URL,
        "supabase_anon_key": os.environ.get("SUPABASE_ANON_KEY", ""),
        "auth_disabled": AUTH_DISABLED,
    }

# ----------------------------- Static -----------------------------
# Vercel: 정적 파일은 vercel.json 의 rewrites 로 직접 서빙됨 (아래는 로컬 uvicorn용 폴백)
STATIC_DIR = os.path.join(ROOT, "static")
if os.path.isdir(STATIC_DIR):
    @app.get("/")
    def root():
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    # 루트 직접 접근 (예: /app.js, /style.css) 도 static에서
    @app.get("/{filename}")
    def static_file(filename: str):
        p = os.path.join(STATIC_DIR, filename)
        if os.path.isfile(p):
            return FileResponse(p)
        raise HTTPException(404, "Not Found")

# ----------------------------- Vercel handler -----------------------------
# @vercel/python 은 ASGI 'app' 객체를 자동 인식 → 추가 핸들러 불필요
