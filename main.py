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

from fastapi import FastAPI, Request, HTTPException, Body, Depends
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from db import DB, IS_PG

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
    db.conn.close()
    # 환경변수 우선
    if os.environ.get("SHOP_ID"):
        cfg["shop_id"] = os.environ["SHOP_ID"]
    cfg.setdefault("shop_id", "")
    cfg.setdefault("lookback_days", 14)
    return cfg

def save_config(cfg: dict) -> None:
    db = get_db()
    db.kv_set("config", cfg)
    db.conn.close()

def get_session_cookies() -> list[dict]:
    db = get_db()
    cookies = db.kv_get("session_cookies", []) or []
    db.conn.close()
    return cookies

def set_session_cookies(cookies: list[dict]) -> None:
    db = get_db()
    db.kv_set("session_cookies", cookies)
    db.conn.close()

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
    db.conn.close()
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
    db.conn.close()
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
    db.conn.close()
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
    db.conn.close()
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
    db.conn.close()
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
    db.conn.close()
    return {"rows": rows, "count": len(rows)}

@app.get("/api/raw")
def api_raw(req: Request, _u: dict = Depends(auth_required)):
    p = _parse_common(dict(req.query_params))
    cfg = get_config(); db = get_db()
    rows = db.get_raw(cfg.get("shop_id", ""), p["product"], p["from"], p["to"])
    db.conn.close()
    fields, seen = ["report_date"], {"report_date"}
    for r in rows:
        for k in r:
            if k not in seen:
                seen.add(k); fields.append(k)
    return {"fields": fields, "rows": rows, "count": len(rows)}

# MVP 스텁 — 백그라운드 작업 라우트 (Task #14 본격 구현)
@app.get("/api/jobs")
def api_jobs(_u: dict = Depends(auth_required)):
    return {"jobs": [], "counts": {"pending": 0, "registered": 0, "completed": 0, "failed": 0}}

@app.get("/api/backfill/status")
def api_backfill_status(_u: dict = Depends(auth_required)):
    return {"running": False, "progress": 0, "total": 0, "done": 0, "current": None}

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
