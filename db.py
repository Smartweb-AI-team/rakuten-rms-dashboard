"""
db.py
일별 광고 실적 저장.
- 로컬: SQLite (DATABASE_URL 미설정 또는 sqlite:// 시)
- 본번(Vercel): Postgres (DATABASE_URL=postgresql://... Supabase)
"""
from __future__ import annotations
import os, json
from contextlib import contextmanager
from datetime import datetime as _dt

# .env 자동 로드 (개발용. 본번은 Vercel 환경변수)
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
IS_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))

if IS_PG:
    import psycopg2
    import psycopg2.extras
else:
    import sqlite3

PERF_PK = ["shop_id", "ad_product", "selection_type", "report_date", "campaign_id",
           "dimension_key", "item_url", "user_segment", "cv_window"]

PERF_COLS = ["shop_id", "ad_product", "selection_type", "report_date", "campaign_id",
             "dimension_key", "campaign_name", "item_url", "user_segment", "cv_window",
             "clicks", "impressions", "ad_cost", "gms", "cv", "cvr", "roas", "cpc", "cpa",
             "collected_by", "collected_at"]

# ---------- SQLite 스키마 (기존 그대로) ----------
SCHEMA_SQLITE = """
CREATE TABLE IF NOT EXISTS ad_daily_performance (
  shop_id        TEXT NOT NULL,
  ad_product     TEXT NOT NULL,
  selection_type INTEGER NOT NULL,
  report_date    TEXT NOT NULL,
  campaign_id    TEXT NOT NULL DEFAULT '',
  dimension_key  TEXT NOT NULL DEFAULT '',
  campaign_name  TEXT,
  item_url       TEXT NOT NULL DEFAULT '',
  user_segment   TEXT NOT NULL,
  cv_window      TEXT NOT NULL,
  clicks         INTEGER,
  impressions    INTEGER,
  ad_cost        REAL,
  gms            REAL,
  cv             INTEGER,
  cvr            REAL,
  roas           REAL,
  cpc            REAL,
  cpa            REAL,
  ingested_at    TEXT DEFAULT (datetime('now')),
  collected_by   TEXT,
  collected_at   TEXT,
  PRIMARY KEY (shop_id, ad_product, selection_type, report_date,
               campaign_id, dimension_key, item_url, user_segment, cv_window)
);
CREATE INDEX IF NOT EXISTS ix_perf_lookup ON ad_daily_performance (shop_id, ad_product, report_date);

CREATE TABLE IF NOT EXISTS ad_monthly_billing (
  shop_id TEXT, billing_month TEXT, ad_product TEXT, purchase_amount REAL,
  PRIMARY KEY (shop_id, billing_month, ad_product)
);

CREATE TABLE IF NOT EXISTS ad_daily_raw (
  shop_id     TEXT NOT NULL,
  ad_product  TEXT NOT NULL,
  report_date TEXT NOT NULL,
  row_count   INTEGER,
  payload     TEXT,
  ingested_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (shop_id, ad_product, report_date)
);

CREATE TABLE IF NOT EXISTS collect_log (
  ts          TEXT DEFAULT (datetime('now')),
  shop_id     TEXT,
  date_from   TEXT,
  date_to     TEXT,
  mode        TEXT,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS download_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id         TEXT NOT NULL,
  selection_type  INTEGER NOT NULL,
  report_type     INTEGER NOT NULL,
  period_type     TEXT NOT NULL,
  start_date      TEXT NOT NULL,
  end_date        TEXT NOT NULL,
  rakuten_id      INTEGER,
  status          TEXT NOT NULL,
  normalized_rows INTEGER,
  error_msg       TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_dlj_status ON download_jobs(status, created_at);

-- 세션/설정 영구 저장 (서버리스에선 모듈 state 휘발돼서 DB 필요)
CREATE TABLE IF NOT EXISTS app_kv (
  k          TEXT PRIMARY KEY,
  v          TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
"""

# ---------- Postgres 스키마 ----------
SCHEMA_PG = """
CREATE TABLE IF NOT EXISTS ad_daily_performance (
  shop_id        TEXT NOT NULL,
  ad_product     TEXT NOT NULL,
  selection_type INTEGER NOT NULL,
  report_date    TEXT NOT NULL,
  campaign_id    TEXT NOT NULL DEFAULT '',
  dimension_key  TEXT NOT NULL DEFAULT '',
  campaign_name  TEXT,
  item_url       TEXT NOT NULL DEFAULT '',
  user_segment   TEXT NOT NULL,
  cv_window      TEXT NOT NULL,
  clicks         INTEGER,
  impressions    INTEGER,
  ad_cost        DOUBLE PRECISION,
  gms            DOUBLE PRECISION,
  cv             INTEGER,
  cvr            DOUBLE PRECISION,
  roas           DOUBLE PRECISION,
  cpc            DOUBLE PRECISION,
  cpa            DOUBLE PRECISION,
  ingested_at    TIMESTAMPTZ DEFAULT NOW(),
  collected_by   TEXT,
  collected_at   TEXT,
  PRIMARY KEY (shop_id, ad_product, selection_type, report_date,
               campaign_id, dimension_key, item_url, user_segment, cv_window)
);
CREATE INDEX IF NOT EXISTS ix_perf_lookup ON ad_daily_performance (shop_id, ad_product, report_date);

CREATE TABLE IF NOT EXISTS ad_monthly_billing (
  shop_id TEXT, billing_month TEXT, ad_product TEXT, purchase_amount DOUBLE PRECISION,
  PRIMARY KEY (shop_id, billing_month, ad_product)
);

CREATE TABLE IF NOT EXISTS ad_daily_raw (
  shop_id     TEXT NOT NULL,
  ad_product  TEXT NOT NULL,
  report_date TEXT NOT NULL,
  row_count   INTEGER,
  payload     TEXT,
  ingested_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (shop_id, ad_product, report_date)
);

CREATE TABLE IF NOT EXISTS collect_log (
  ts          TIMESTAMPTZ DEFAULT NOW(),
  shop_id     TEXT,
  date_from   TEXT,
  date_to     TEXT,
  mode        TEXT,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS download_jobs (
  id              BIGSERIAL PRIMARY KEY,
  shop_id         TEXT NOT NULL,
  selection_type  INTEGER NOT NULL,
  report_type     INTEGER NOT NULL,
  period_type     TEXT NOT NULL,
  start_date      TEXT NOT NULL,
  end_date        TEXT NOT NULL,
  rakuten_id      BIGINT,
  status          TEXT NOT NULL,
  normalized_rows INTEGER,
  error_msg       TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_dlj_status ON download_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS app_kv (
  k          TEXT PRIMARY KEY,
  v          TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
"""


def _ph(n: int) -> str:
    """플레이스홀더 n 개 (sqlite '?' / postgres '%s')."""
    p = "%s" if IS_PG else "?"
    return ",".join([p] * n)


def _now_sql() -> str:
    return "NOW()" if IS_PG else "datetime('now')"


def _upsert_sql(table: str, cols: list[str], pk_cols: list[str]) -> str:
    """INSERT OR REPLACE 호환 SQL."""
    if IS_PG:
        non_pk = [c for c in cols if c not in pk_cols]
        sets = ", ".join(f"{c}=EXCLUDED.{c}" for c in non_pk)
        return (f"INSERT INTO {table} ({','.join(cols)}) VALUES ({_ph(len(cols))}) "
                f"ON CONFLICT ({','.join(pk_cols)}) DO UPDATE SET {sets}") if non_pk else (
            f"INSERT INTO {table} ({','.join(cols)}) VALUES ({_ph(len(cols))}) "
            f"ON CONFLICT ({','.join(pk_cols)}) DO NOTHING")
    return f"INSERT OR REPLACE INTO {table} ({','.join(cols)}) VALUES ({_ph(len(cols))})"


def _flatten(obj, prefix: str = "") -> dict:
    out = {}
    if not isinstance(obj, dict):
        return {prefix or "value": obj}
    for k, v in obj.items():
        key = f"{prefix}.{k}" if prefix else str(k)
        if isinstance(v, dict):
            out.update(_flatten(v, key))
        elif isinstance(v, list):
            out[key] = json.dumps(v, ensure_ascii=False)
        else:
            out[key] = v
    return out


class _PGRowProxy:
    """psycopg2 RealDictRow 를 sqlite3.Row 처럼 [int], [str] 둘 다 동작하게."""
    __slots__ = ("_d", "_keys")
    def __init__(self, d): self._d = d; self._keys = list(d.keys())
    def __getitem__(self, k):
        if isinstance(k, int): return self._d[self._keys[k]]
        return self._d[k]
    def __iter__(self): return iter(self._d.values())
    def keys(self): return self._keys
    def get(self, k, default=None): return self._d.get(k, default)
    def __len__(self): return len(self._d)


_PG_CONN_CACHE = {"conn": None, "init_done": False}

def _get_pg_conn():
    """모듈 글로벌 풀 — Cloud Run 워커에서 매 요청마다 새 연결 만드는 cold start 비용 회피."""
    c = _PG_CONN_CACHE["conn"]
    if c is not None:
        try:
            # 연결 살아있는지 가벼운 ping
            cur = c.cursor()
            cur.execute("SELECT 1")
            cur.close()
            return c
        except Exception:
            try: c.close()
            except: pass
            _PG_CONN_CACHE["conn"] = None
    c = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    c.autocommit = False
    _PG_CONN_CACHE["conn"] = c
    return c

class DB:
    def __init__(self, path: str = "rms_ads.db"):
        if IS_PG:
            self.conn = _get_pg_conn()
            if not _PG_CONN_CACHE["init_done"]:
                self._init_pg()
                _PG_CONN_CACHE["init_done"] = True
        else:
            self.conn = sqlite3.connect(path)
            self.conn.row_factory = sqlite3.Row
            try:
                self.conn.execute("PRAGMA journal_mode=WAL")
                self.conn.execute("PRAGMA synchronous=NORMAL")
                self.conn.execute("PRAGMA busy_timeout=5000")
            except Exception:
                pass
            self._init_sqlite()

    def _init_pg(self):
        cur = self.conn.cursor()
        for stmt in SCHEMA_PG.strip().split(";"):
            s = stmt.strip()
            if s:
                cur.execute(s)
        self.conn.commit()
        cur.close()

    def _init_sqlite(self):
        self.conn.executescript(SCHEMA_SQLITE)
        cols = [r[1] for r in self.conn.execute("PRAGMA table_info(ad_daily_performance)")]
        if "impressions" not in cols:
            self.conn.execute("ALTER TABLE ad_daily_performance ADD COLUMN impressions INTEGER")
        if "item_url" not in cols:
            self.conn.execute("ALTER TABLE ad_daily_performance ADD COLUMN item_url TEXT")
        if "collected_by" not in cols:
            self.conn.execute("ALTER TABLE ad_daily_performance ADD COLUMN collected_by TEXT")
        if "collected_at" not in cols:
            self.conn.execute("ALTER TABLE ad_daily_performance ADD COLUMN collected_at TEXT")
        try:
            create_sql_row = self.conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='ad_daily_performance'"
            ).fetchone()
            create_sql = create_sql_row[0] if create_sql_row else ""
            pk_clause = create_sql.split("PRIMARY KEY")[-1] if "PRIMARY KEY" in create_sql else ""
            if "item_url" not in pk_clause:
                self.conn.executescript("""
                    ALTER TABLE ad_daily_performance RENAME TO ad_daily_performance_old_pk;
                    CREATE TABLE ad_daily_performance (
                      shop_id TEXT NOT NULL, ad_product TEXT NOT NULL,
                      selection_type INTEGER NOT NULL, report_date TEXT NOT NULL,
                      campaign_id TEXT NOT NULL DEFAULT '', dimension_key TEXT NOT NULL DEFAULT '',
                      campaign_name TEXT, user_segment TEXT NOT NULL, cv_window TEXT NOT NULL,
                      clicks INTEGER, impressions INTEGER, ad_cost REAL, gms REAL,
                      cv INTEGER, cvr REAL, roas REAL, cpc REAL, cpa REAL,
                      item_url TEXT, ingested_at TEXT DEFAULT (datetime('now')),
                      PRIMARY KEY (shop_id, ad_product, selection_type, report_date,
                                   campaign_id, dimension_key, item_url, user_segment, cv_window)
                    );
                    INSERT OR REPLACE INTO ad_daily_performance
                    SELECT shop_id, ad_product, selection_type, report_date, campaign_id,
                           dimension_key, campaign_name, user_segment, cv_window,
                           clicks, impressions, ad_cost, gms, cv, cvr, roas, cpc, cpa,
                           COALESCE(item_url,''), ingested_at
                      FROM ad_daily_performance_old_pk;
                    DROP TABLE ad_daily_performance_old_pk;
                    CREATE INDEX IF NOT EXISTS ix_perf_lookup
                      ON ad_daily_performance (shop_id, ad_product, report_date);
                """)
        except Exception as e:
            print(f"[migration] PK update skipped: {e}")
        self.conn.commit()

    @contextmanager
    def cursor(self):
        cur = self.conn.cursor()
        try:
            yield cur
            self.conn.commit()
        finally:
            cur.close()

    def close(self):
        """Postgres 모드에선 글로벌 풀이라 close 무시. SQLite 만 실제 close."""
        if not IS_PG:
            try: self.conn.close()
            except: pass

    def upsert_performance(self, rows: list[dict], collected_by: str | None = None) -> int:
        if not rows:
            return 0
        now_iso = _dt.now().isoformat(timespec="seconds")
        for r in rows:
            if r.get("item_url") is None:
                r["item_url"] = ""
            if collected_by and not r.get("collected_by"):
                r["collected_by"] = collected_by
            if not r.get("collected_at"):
                r["collected_at"] = now_iso
        sql = _upsert_sql("ad_daily_performance", PERF_COLS, PERF_PK)
        with self.cursor() as cur:
            cur.executemany(sql, [[r.get(c) for c in PERF_COLS] for r in rows])
        return len(rows)

    def upsert_billing(self, shop_id: str, month: str, summary: dict) -> None:
        sql = _upsert_sql("ad_monthly_billing",
                          ["shop_id", "billing_month", "ad_product", "purchase_amount"],
                          ["shop_id", "billing_month", "ad_product"])
        with self.cursor() as cur:
            for product, amount in summary.items():
                cur.execute(sql, (shop_id, month, product, amount))

    def upsert_raw(self, shop_id: str, ad_product: str, report_date: str,
                   rows: list) -> int:
        sql = _upsert_sql("ad_daily_raw",
                          ["shop_id", "ad_product", "report_date", "row_count", "payload"],
                          ["shop_id", "ad_product", "report_date"])
        with self.cursor() as cur:
            cur.execute(sql, (shop_id, ad_product, report_date, len(rows or []),
                              json.dumps(rows, ensure_ascii=False)))
        return len(rows or [])

    # ---------- 백그라운드 다운로드 작업 큐 ----------
    def add_download_job(self, shop_id: str, selection_type: int,
                         report_type: int, period_type: str,
                         start_date: str, end_date: str) -> int:
        with self.cursor() as cur:
            cur.execute(
                f"SELECT id FROM download_jobs "
                f"WHERE shop_id={_ph(1)} AND selection_type={_ph(1)} AND report_type={_ph(1)} "
                f"AND period_type={_ph(1)} AND start_date={_ph(1)} AND end_date={_ph(1)} "
                f"AND status IN ('pending','registered')",
                (shop_id, selection_type, report_type, period_type, start_date, end_date))
            r = cur.fetchone()
            if r:
                return r["id"] if hasattr(r, "__getitem__") else r[0]
            sql_ins = (f"INSERT INTO download_jobs "
                       f"(shop_id, selection_type, report_type, period_type, "
                       f" start_date, end_date, status) "
                       f"VALUES ({_ph(6)}, 'pending')")
            params = (shop_id, selection_type, report_type, period_type, start_date, end_date)
            if IS_PG:
                cur.execute(sql_ins + " RETURNING id", params)
                row = cur.fetchone()
                return row["id"] if hasattr(row, "__getitem__") else row[0]
            cur.execute(sql_ins, params)
            return cur.lastrowid

    def update_download_job(self, job_id: int, **fields) -> None:
        if not fields:
            return
        keys = list(fields.keys())
        sets = ", ".join(f"{k}={_ph(1)}" for k in keys) + f", updated_at={_now_sql()}"
        vals = [fields[k] for k in keys] + [job_id]
        with self.cursor() as cur:
            cur.execute(f"UPDATE download_jobs SET {sets} WHERE id={_ph(1)}", vals)

    def list_download_jobs(self, shop_id: str | None = None,
                           status: str | None = None,
                           limit: int = 100) -> list[dict]:
        sql = "SELECT * FROM download_jobs WHERE 1=1"
        params: list = []
        if shop_id:
            sql += f" AND shop_id={_ph(1)}"; params.append(shop_id)
        if status:
            sql += f" AND status={_ph(1)}"; params.append(status)
        sql += f" ORDER BY id DESC LIMIT {_ph(1)}"
        params.append(limit)
        with self.cursor() as cur:
            cur.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]

    def get_active_jobs(self) -> list[dict]:
        with self.cursor() as cur:
            cur.execute(
                "SELECT * FROM download_jobs "
                "WHERE status IN ('pending','registered') ORDER BY id")
            return [dict(r) for r in cur.fetchall()]

    def log_collect(self, shop_id: str, date_from: str, date_to: str,
                    mode: str, result: dict) -> None:
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO collect_log (shop_id, date_from, date_to, mode, result_json) "
                f"VALUES ({_ph(5)})",
                (shop_id, date_from, date_to, mode,
                 json.dumps(result, ensure_ascii=False)))

    # ---------- UI 대시보드용 조회 ----------
    def coverage(self, shop_id: str) -> list[dict]:
        sql = f"""
          SELECT report_date, ad_product, SUM(n) AS rows FROM (
            SELECT report_date, ad_product, COUNT(*) AS n
              FROM ad_daily_performance WHERE shop_id={_ph(1)}
              GROUP BY report_date, ad_product
            UNION ALL
            SELECT report_date, ad_product, row_count AS n
              FROM ad_daily_raw WHERE shop_id={_ph(1)}
          ) {"sub" if IS_PG else ""} GROUP BY report_date, ad_product ORDER BY report_date DESC
        """
        with self.cursor() as cur:
            cur.execute(sql, (shop_id, shop_id))
            return [dict(r) for r in cur.fetchall()]

    def date_bounds(self, shop_id: str) -> dict:
        with self.cursor() as cur:
            cur.execute(
                f"SELECT MIN(report_date) AS mn, MAX(report_date) AS mx, "
                f"COUNT(DISTINCT report_date) AS d "
                f"FROM ad_daily_performance WHERE shop_id={_ph(1)}", (shop_id,))
            r = cur.fetchone()
            if r is None:
                return {"min": None, "max": None, "distinct_days": 0}
            return {"min": r["mn"], "max": r["mx"], "distinct_days": r["d"]}

    def kpis(self, shop_id: str, date_from: str, date_to: str,
             ad_product: str = "RPP", selection_type: int = 1,
             user_segment: str = "all", cv_window: str = "720h") -> dict:
        prod_cond = f"AND ad_product={_ph(1)}" if ad_product else ""
        sql = f"""
          SELECT COALESCE(SUM(clicks),0)      AS clicks,
                 COALESCE(SUM(impressions),0)  AS impressions,
                 COALESCE(SUM(ad_cost),0)      AS ad_cost,
                 COALESCE(SUM(gms),0)          AS gms,
                 COALESCE(SUM(cv),0)           AS cv
            FROM ad_daily_performance
           WHERE shop_id={_ph(1)} AND report_date BETWEEN {_ph(1)} AND {_ph(1)}
             {prod_cond} AND selection_type={_ph(1)} AND user_segment={_ph(1)} AND cv_window={_ph(1)}
        """
        params = ([shop_id, date_from, date_to] + ([ad_product] if ad_product else [])
                  + [selection_type, user_segment, cv_window])
        with self.cursor() as cur:
            cur.execute(sql, params)
            r = dict(cur.fetchone())
        cost, gms, clicks, cv, impr = (r["ad_cost"], r["gms"], r["clicks"],
                                       r["cv"], r["impressions"])
        r["roas"] = round(gms / cost, 4) if cost else None
        r["cpc"] = round(cost / clicks, 2) if clicks else None
        r["cpa"] = round(cost / cv, 2) if cv else None
        r["cvr"] = round(cv / clicks, 6) if clicks else None
        r["ctr"] = round(clicks / impr, 6) if impr else None
        return r

    def daily_series(self, shop_id: str, date_from: str, date_to: str,
                     ad_product: str = "RPP", selection_type: int = 1,
                     user_segment: str = "all", cv_window: str = "720h") -> list[dict]:
        prod_cond = f"AND ad_product={_ph(1)}" if ad_product else ""
        sql = f"""
          SELECT report_date,
                 COALESCE(SUM(clicks),0) AS clicks, COALESCE(SUM(ad_cost),0) AS ad_cost,
                 COALESCE(SUM(gms),0) AS gms, COALESCE(SUM(cv),0) AS cv
            FROM ad_daily_performance
           WHERE shop_id={_ph(1)} AND report_date BETWEEN {_ph(1)} AND {_ph(1)}
             {prod_cond} AND selection_type={_ph(1)} AND user_segment={_ph(1)} AND cv_window={_ph(1)}
           GROUP BY report_date ORDER BY report_date ASC
        """
        params = ([shop_id, date_from, date_to] + ([ad_product] if ad_product else [])
                  + [selection_type, user_segment, cv_window])
        with self.cursor() as cur:
            cur.execute(sql, params)
            out = []
            for row in cur.fetchall():
                d = dict(row)
                d["roas"] = round(d["gms"] / d["ad_cost"], 4) if d["ad_cost"] else None
                out.append(d)
            return out

    def top_dimensions(self, shop_id: str, date_from: str, date_to: str,
                       ad_product: str = "RPP", selection_type: int = 2,
                       user_segment: str = "all", cv_window: str = "720h",
                       order_by: str = "ad_cost", limit: int = 10) -> list[dict]:
        allowed = {"ad_cost", "gms", "clicks", "cv", "roas"}
        if order_by not in allowed:
            order_by = "ad_cost"
        prod_cond = f"AND ad_product={_ph(1)}" if ad_product else ""
        # Postgres에선 SUM(...) AS roas 컬럼 ORDER BY 시 별칭 사용 가능, SQLite 도 동일.
        sql = f"""
          SELECT campaign_name, dimension_key,
                 COALESCE(SUM(clicks),0) AS clicks, COALESCE(SUM(impressions),0) AS impressions,
                 COALESCE(SUM(ad_cost),0) AS ad_cost,
                 COALESCE(SUM(gms),0) AS gms, COALESCE(SUM(cv),0) AS cv,
                 CASE WHEN SUM(ad_cost)>0 THEN ROUND(CAST(SUM(gms) AS NUMERIC)/CAST(SUM(ad_cost) AS NUMERIC),4) END AS roas,
                 CASE WHEN SUM(impressions)>0 THEN ROUND(CAST(SUM(clicks) AS NUMERIC)/CAST(SUM(impressions) AS NUMERIC),6) END AS ctr,
                 CASE WHEN SUM(clicks)>0 THEN ROUND(CAST(SUM(cv) AS NUMERIC)/CAST(SUM(clicks) AS NUMERIC),6) END AS cvr
            FROM ad_daily_performance
           WHERE shop_id={_ph(1)} AND report_date BETWEEN {_ph(1)} AND {_ph(1)}
             {prod_cond} AND selection_type={_ph(1)} AND user_segment={_ph(1)} AND cv_window={_ph(1)}
           GROUP BY campaign_id, campaign_name, dimension_key
           ORDER BY {order_by} DESC LIMIT {_ph(1)}
        """
        params = ([shop_id, date_from, date_to] + ([ad_product] if ad_product else [])
                  + [selection_type, user_segment, cv_window, limit])
        with self.cursor() as cur:
            cur.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]

    def get_raw(self, shop_id: str, ad_product: str,
                date_from: str, date_to: str) -> list[dict]:
        with self.cursor() as cur:
            cur.execute(
                f"SELECT report_date, payload FROM ad_daily_raw "
                f"WHERE shop_id={_ph(1)} AND ad_product={_ph(1)} AND report_date BETWEEN {_ph(1)} AND {_ph(1)} "
                f"ORDER BY report_date",
                (shop_id, ad_product, date_from, date_to))
            out = []
            for rec in cur.fetchall():
                try:
                    rows = json.loads(rec["payload"]) or []
                except Exception:
                    rows = []
                for row in (rows if isinstance(rows, list) else [rows]):
                    flat = _flatten(row)
                    flat["report_date"] = rec["report_date"]
                    out.append(flat)
            return out

    def present_dates(self, shop_id: str, selection_type: int,
                      ad_product: str = "RPP") -> set:
        with self.cursor() as cur:
            cur.execute(
                f"SELECT DISTINCT report_date FROM ad_daily_performance "
                f"WHERE shop_id={_ph(1)} AND ad_product={_ph(1)} AND selection_type={_ph(1)}",
                (shop_id, ad_product, selection_type))
            return {r[0] if not IS_PG else r["report_date"] for r in cur.fetchall()}

    def products_present(self, shop_id: str) -> list[str]:
        with self.cursor() as cur:
            cur.execute(
                f"SELECT DISTINCT ad_product FROM ad_daily_performance WHERE shop_id={_ph(1)} "
                f"UNION SELECT DISTINCT ad_product FROM ad_daily_raw WHERE shop_id={_ph(1)}",
                (shop_id, shop_id))
            return [r[0] if not IS_PG else r["ad_product"] for r in cur.fetchall()]

    # ---------- KV (세션/설정 영구 저장 — Vercel 서버리스용) ----------
    def kv_get(self, key: str, default=None):
        with self.cursor() as cur:
            cur.execute(f"SELECT v FROM app_kv WHERE k={_ph(1)}", (key,))
            r = cur.fetchone()
            if not r:
                return default
            v = r["v"] if hasattr(r, "__getitem__") and not isinstance(r, tuple) else r[0]
            try:
                return json.loads(v) if v else default
            except Exception:
                return v or default

    def kv_set(self, key: str, value) -> None:
        sql = _upsert_sql("app_kv", ["k", "v"], ["k"])
        with self.cursor() as cur:
            cur.execute(sql, (key, json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value))

    def query_performance(self, shop_id: str, date_from: str, date_to: str,
                          ad_product: str | None = None, selection_type: int = 1,
                          user_segment: str = "all", cv_window: str = "720h",
                          order_by: str = "report_date", desc: bool = False,
                          limit: int = 500) -> list[dict]:
        allowed_order = {"report_date", "ad_cost", "gms", "roas", "clicks", "cv", "cvr"}
        if order_by not in allowed_order:
            order_by = "report_date"
        sql_parts = [
            "SELECT report_date, ad_product, campaign_name, dimension_key, item_url,",
            "clicks, impressions, ad_cost, gms, cv, cvr, roas, cpc, cpa",
            "FROM ad_daily_performance",
            f"WHERE shop_id={_ph(1)} AND report_date BETWEEN {_ph(1)} AND {_ph(1)}",
            f"AND selection_type={_ph(1)} AND user_segment={_ph(1)} AND cv_window={_ph(1)}"]
        params = [shop_id, date_from, date_to, selection_type, user_segment, cv_window]
        if ad_product:
            sql_parts.append(f"AND ad_product={_ph(1)}")
            params.append(ad_product)
        sql_parts.append(f"ORDER BY {order_by} {'DESC' if desc else 'ASC'} LIMIT {_ph(1)}")
        params.append(limit)
        with self.cursor() as cur:
            cur.execute(" ".join(sql_parts), params)
            return [dict(r) for r in cur.fetchall()]
