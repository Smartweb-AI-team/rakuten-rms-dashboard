"""
rakuten_client.py
라쿠텐 RMS 광고(ad.rms.rakuten.co.jp) 내부 REST API 클라이언트.

인증: R-Login 세션 쿠키 + X-XSRF-TOKEN 헤더.
로그인 자체(OAuth2+2FA)는 Playwright로 별도 수행하고, 여기서는 그 결과로 얻은
쿠키(storage_state.json 또는 cookie dict)만 사용한다.

검증 완료(2026-06-05, 테스트샵 凛 기준):
  - RPP  : POST /rpp/api/reports/search                       (일별: 전체/캠페인)
  - CPA  : GET  /cpa/api/reports/search                       (일별)
  - TDA  : GET  /tda/api/aggregator/v2/reports/search         (일별)
  - 구매이력: GET /shared/api/purchase_summary                 (월별, 전 상품 청구액)
"""

from __future__ import annotations
import json
import time
from datetime import date, timedelta
from urllib.parse import urlencode

import requests

BASE = "https://ad.rms.rakuten.co.jp"

# RPP selectionType / periodType 매핑 (검증됨)
SEL_ALL, SEL_CAMPAIGN, SEL_ITEM, SEL_KEYWORD = 1, 2, 3, 4
PERIOD_ALL, PERIOD_MONTH, PERIOD_DAY = 0, 1, 2


def _daterange(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


LAST_RPP_META: list[dict] = []  # 최근 fetch_rpp 호출별 진단 정보 (페이지 키 추정용)
LAST_RPP_CSV_PREVIEW: dict = {}  # 최근 키워드 CSV 파싱 결과 미리보기 (헤더·1행 미리보기)


def _csv_num(v):
    """日本語 CSV 값 → 숫자 변환 (¥, %, 콤마, 공백 제거)."""
    if v is None:
        return None
    s = str(v).replace(",", "").replace("¥", "").replace("円", "").replace("%", "").strip()
    if s in ("", "-", "—", "ー", "NA", "N/A"):
        return None
    try:
        f = float(s)
        if f.is_integer():
            return int(f)
        return f
    except ValueError:
        return None


def normalize_rpp_item_csv(csv_text: str, shop_id: str) -> list[dict]:
    """RPP 「商品別広告 効果ダウンロード」 CSV → ad_daily_performance row 리스트.
    キーワード CSV와 동일 구조 — 차원만 「商品管理番号」 사용."""
    return _normalize_rpp_csv_generic(csv_text, shop_id, selection_type=3)


def normalize_rpp_keyword_csv(csv_text: str, shop_id: str) -> list[dict]:
    """RPP 「キーワード別広告 効果ダウンロード」 CSV → ad_daily_performance row 리스트.
    CSV 1행 → 3 segment × 2 window = 6 평탄화 row."""
    return _normalize_rpp_csv_generic(csv_text, shop_id, selection_type=4)


def _normalize_rpp_csv_generic(csv_text: str, shop_id: str,
                                selection_type: int) -> list[dict]:
    """공통 RPP CSV 파서. selection_type 으로 차원 키 선택."""
    import csv as _csv
    import io as _io
    import re as _re

    # 항상 raw 미리보기를 먼저 저장 (파싱 실패해도 사용자가 형식을 확인할 수 있도록)
    LAST_RPP_CSV_PREVIEW["raw_len"] = len(csv_text)
    LAST_RPP_CSV_PREVIEW["raw_head"] = csv_text[:1500]
    LAST_RPP_CSV_PREVIEW["raw_line_count"] = csv_text.count("\n") + csv_text.count("\r\n")

    # 줄바꿈 정규화: Windows(\r\n) → \n, 잔여 \r → \n
    norm_text = csv_text.replace("\r\n", "\n").replace("\r", "\n")
    lines = norm_text.split("\n")
    # 라쿠텐 CSV 상단 메타 영역 스킵: 「■■■■」 구분선 다음 줄부터가 진짜 헤더
    start_idx = 0
    for i, line in enumerate(lines):
        if "■■■■" in line:
            start_idx = i + 1
            break
    # 「■■■■」가 없으면 "コントロールカラム" 또는 "日付" / "商品管理番号" 가 들어간 첫 줄 찾기
    if start_idx == 0:
        for i, line in enumerate(lines):
            if ("コントロールカラム" in line or
                ('"日付"' in line and '"商品管理番号"' in line)):
                start_idx = i
                break
    LAST_RPP_CSV_PREVIEW["meta_skip_lines"] = start_idx
    data_lines = lines[start_idx:]
    reader = _csv.DictReader(data_lines)
    headers = list(reader.fieldnames or [])
    LAST_RPP_CSV_PREVIEW["headers"] = headers

    # 컬럼명 유연 매칭: 모든 needle을 포함하면서, 추가로 「exclude」 단어들은 미포함이어야 함.
    def find_col(*needles, exclude=()):
        for h in headers:
            hh = h or ""
            if all(n in hh for n in needles) and not any(x in hh for x in exclude):
                return h
        return None

    # 「キーワード」 단독 컬럼 vs 「キーワードCPC」 구분 필요
    col_date = find_col("日付") or find_col("期間")
    col_url = find_col("商品ページURL") or find_col("商品URL") or find_col("ページURL")
    col_kwd = find_col("キーワード", exclude=("CPC",))
    col_item_no = find_col("商品管理番号")
    # 「CTR(%)」 — 다른 헤더에는 「CTR」 없음
    col_ctr = find_col("CTR")

    seg_jp = {"all": "合計", "new": "新規", "existing": "既存"}
    win_jp = {"12h": "12時間", "720h": "720時間"}
    # 「合計」 vs 「合計12時間」/「合計720時間」 — exclude 로 구분
    cols = {}
    for seg, sjp in seg_jp.items():
        # 클릭/실적/CPC: 「(合計)」 같은 일별 전체 컬럼만 (12時間/720時間 제외)
        cols[(seg, "clicks")] = find_col("クリック数", f"({sjp})", exclude=("時間",))
        cols[(seg, "ad_cost")] = find_col("実績額", f"({sjp})", exclude=("時間",))
        cols[(seg, "cpc")] = find_col("CPC実績", f"({sjp})", exclude=("時間",))
        for win, wjp in win_jp.items():
            tag = f"({sjp}{wjp})"
            cols[(seg, win, "gms")] = find_col("売上金額", tag)
            cols[(seg, win, "cv")] = find_col("売上件数", tag)
            cols[(seg, win, "cvr")] = find_col("CVR", tag)
            cols[(seg, win, "roas")] = find_col("ROAS", tag)
            cols[(seg, win, "cpa")] = find_col("注文獲得単価", tag)

    out: list[dict] = []
    preview_first_row = None
    for row in reader:
        if preview_first_row is None:
            preview_first_row = dict(row)
        # 일자 파싱
        date_raw = (row.get(col_date) if col_date else "") or ""
        m = _re.match(r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})", date_raw)
        if not m:
            # 단일 ISO ("YYYY-MM-DD") 형태도 허용
            m = _re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", date_raw)
            if not m:
                continue
        report_date = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"

        item_url = (row.get(col_url) if col_url else "") or ""
        keyword = (row.get(col_kwd) if col_kwd else "") or ""
        item_no = (row.get(col_item_no) if col_item_no else "") or ""
        # 차원 키 선택
        if selection_type == 4:
            dim_key = keyword
        elif selection_type == 3:
            dim_key = item_no or item_url
        else:
            dim_key = item_no or item_url or keyword
        if not dim_key:
            continue

        # CTR (행 수준, %). all 세그먼트의 impressions 역산용
        ctr_raw = _csv_num(row.get(col_ctr) if col_ctr else None)
        ctr = (ctr_raw / 100.0) if ctr_raw else None

        base = {
            "shop_id": shop_id, "ad_product": "RPP", "selection_type": selection_type,
            "report_date": report_date, "campaign_id": "",
            "dimension_key": dim_key, "campaign_name": None,
            "item_url": item_url,
        }

        for seg in ("all", "new", "existing"):
            clicks = _csv_num(row.get(cols.get((seg, "clicks")))) if cols.get((seg, "clicks")) else None
            cost = _csv_num(row.get(cols.get((seg, "ad_cost")))) if cols.get((seg, "ad_cost")) else None
            cpc = _csv_num(row.get(cols.get((seg, "cpc")))) if cols.get((seg, "cpc")) else None
            impressions = round(clicks / ctr) if (seg == "all" and clicks and ctr) else None

            for win in ("12h", "720h"):
                gms = _csv_num(row.get(cols.get((seg, win, "gms")))) if cols.get((seg, win, "gms")) else None
                cv = _csv_num(row.get(cols.get((seg, win, "cv")))) if cols.get((seg, win, "cv")) else None
                cvr = _csv_num(row.get(cols.get((seg, win, "cvr")))) if cols.get((seg, win, "cvr")) else None
                roas = _csv_num(row.get(cols.get((seg, win, "roas")))) if cols.get((seg, win, "roas")) else None
                cpa = _csv_num(row.get(cols.get((seg, win, "cpa")))) if cols.get((seg, win, "cpa")) else None

                out.append({
                    **base,
                    "user_segment": seg, "cv_window": win,
                    "clicks": clicks, "impressions": impressions,
                    "ad_cost": cost, "cpc": cpc,
                    "gms": gms, "cv": cv,
                    "cvr": (cvr / 100.0) if cvr is not None else None,
                    "roas": (roas / 100.0) if roas is not None else None,
                    "cpa": cpa,
                })

    LAST_RPP_CSV_PREVIEW["first_row"] = preview_first_row
    LAST_RPP_CSV_PREVIEW["resolved_columns"] = {
        f"{k[0]}_{'_'.join(k[1:])}": v for k, v in cols.items() if v
    }
    LAST_RPP_CSV_PREVIEW["resolved_columns"]["_date"] = col_date
    LAST_RPP_CSV_PREVIEW["resolved_columns"]["_url"] = col_url
    LAST_RPP_CSV_PREVIEW["resolved_columns"]["_keyword"] = col_kwd
    LAST_RPP_CSV_PREVIEW["resolved_columns"]["_ctr"] = col_ctr
    LAST_RPP_CSV_PREVIEW["normalized_count"] = len(out)
    return out

class RakutenAdClient:
    def __init__(self, cookies):
        """cookies: 두 형태 모두 허용
          - dict {name: value}                         (모두 path='/' 로 간주)
          - list [{name,value,path,domain}, ...]        (경로별 XSRF 구분 가능)
        라쿠텐 광고는 상품마다 Path=/rpp, /cpa, /tda 로 XSRF-TOKEN 이 따로 발급되므로
        요청 경로에 맞는 토큰을 헤더에 실어야 POST CSRF 검증을 통과한다."""
        self.s = requests.Session()
        self._xsrf_by_path: dict[str, str] = {}
        self.set_cookies(cookies)
        self.s.headers.update({
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Origin": BASE,
            "User-Agent": "Mozilla/5.0",
        })
        # 응답마다 새 XSRF-TOKEN 자동 추출 (set-cookie)
        self.s.hooks["response"].append(self._refresh_xsrf_from_response)
        # POST 403 시 새 XSRF 로 1회 자동 재시도
        _orig_request = self.s.request
        def _request_with_retry(method, url, **kw):
            r = _orig_request(method, url, **kw)
            if r.status_code == 403 and method.upper() == "POST":
                from urllib.parse import urlparse
                req_path = urlparse(url).path or "/"
                new_h = dict(kw.get("headers") or {})
                try:
                    new_h["X-XSRF-TOKEN"] = self._xsrf(req_path)
                    kw["headers"] = new_h
                    r = _orig_request(method, url, **kw)
                except Exception:
                    pass
            return r
        self.s.request = _request_with_retry

    def _refresh_xsrf_from_response(self, r, *args, **kwargs):
        try:
            for c in r.cookies:
                if c.name == "XSRF-TOKEN":
                    self._xsrf_by_path[c.path or "/"] = c.value
            for c in self.s.cookies:
                if c.name == "XSRF-TOKEN":
                    self._xsrf_by_path[c.path or "/"] = c.value
        except Exception:
            pass

    def set_cookies(self, cookies) -> None:
        if isinstance(cookies, dict):
            items = [{"name": k, "value": v, "path": "/", "domain": ".rakuten.co.jp"}
                     for k, v in cookies.items()]
        else:
            items = cookies or []
        for c in items:
            name, value = c.get("name"), c.get("value")
            if not name:
                continue
            path = c.get("path") or "/"
            domain = c.get("domain") or ".rakuten.co.jp"
            # XSRF-TOKEN 은 RMS 어느 서브도메인 출신이든 .rakuten.co.jp 로 통일
            # (좁은 도메인이면 ad.rms 호출에 첨부 안 돼 POST CSRF 검증 실패)
            if name == "XSRF-TOKEN":
                domain = ".rakuten.co.jp"
                path = "/"
            try:
                self.s.cookies.set(name, value, domain=domain, path=path)
            except Exception:
                self.s.cookies.set(name, value)
            if name == "XSRF-TOKEN":
                self._xsrf_by_path[path] = value

    # ---------- 인증 ----------
    @classmethod
    def from_storage_state(cls, path: str) -> "RakutenAdClient":
        """Playwright storage_state.json 에서 쿠키 로드."""
        with open(path, encoding="utf-8") as f:
            state = json.load(f)
        cookies = {c["name"]: c["value"] for c in state.get("cookies", [])
                   if "rakuten.co.jp" in c.get("domain", "")}
        return cls(cookies)

    def _xsrf(self, req_path: str = "/") -> str:
        """요청 경로에 가장 잘 맞는(최장 접두) XSRF-TOKEN 선택. 없으면 아무거나."""
        best, best_len = None, -1
        for p, tok in self._xsrf_by_path.items():
            if req_path.startswith(p) and len(p) > best_len:
                best, best_len = tok, len(p)
        if best is None:
            best = next(iter(self._xsrf_by_path.values()), None)
        if not best:
            raise RuntimeError("XSRF-TOKEN 쿠키가 없습니다. 세션이 만료됐을 수 있습니다.")
        return requests.utils.unquote(best)

    def _headers(self, req_path: str = "/") -> dict:
        return {"X-XSRF-TOKEN": self._xsrf(req_path)}

    def check_session(self) -> bool:
        """세션 유효성 간단 확인 (RPP top 호출)."""
        r = self.s.get(f"{BASE}/rpp/api/top", headers=self._headers("/rpp"), timeout=20)
        return r.status_code == 200

    # ---------- RPP ----------
    def fetch_rpp(self, start: date, end: date,
                  selection_type: int = SEL_ALL,
                  period_type: int = PERIOD_DAY) -> list[dict]:
        """RPP 리포트. 진단: page 키는 라쿠텐이 무시함을 확인됨 (2026-06-12).
        10건 제한은 reportFilter/rankType/campaignType 중 하나에서 오는 것으로 추정,
        여러 페이로드 변형을 시도해 row 수가 늘어나는 조합을 찾는다."""
        all_rows: list[dict] = []
        seen_first_keys: set | None = None
        diag = {"sel": selection_type, "period": period_type,
                "start": start.isoformat(), "end": end.isoformat(),
                "page_results": [], "payload_variants": []}

        # 키워드별(sel=4)일 때만 여러 페이로드 변형으로 정찰 (10건 제한 원인 추정)
        if selection_type == 4:
            base = {
                # 페이지 키들 — 라쿠텐이 무시하지만 키 자체는 필수
                "page": 1, "pageNum": 1, "pageNo": 1, "pageIndex": 1,
                "pageSize": 500, "limit": 500, "noOfRows": 500, "rowsPerPage": 500,
                "selectionType": selection_type, "periodType": period_type,
                "startDate": start.isoformat(), "endDate": end.isoformat(),
                "allUsers": True, "newUsers": True, "existingUsers": True,
                "noOfClicks": True, "adsalesBefore": True, "cpc": True,
                "h12": True, "h720": True,
                "gms": True, "roas": True, "cv": True, "cvr": True, "cpa": True,
            }
            variants = [
                ("baseline", {**base, "reportFilter": 1, "campaignType": "1", "rankType": 1}),
                ("rankType=0", {**base, "reportFilter": 1, "campaignType": "1", "rankType": 0}),
                ("rankType=100", {**base, "reportFilter": 1, "campaignType": "1", "rankType": 100}),
                ("reportFilter=0", {**base, "reportFilter": 0, "campaignType": "1", "rankType": 1}),
                ("no_campaignType", {**base, "reportFilter": 1, "rankType": 1}),
                ("rankType=1000+filter=0", {**base, "reportFilter": 0, "campaignType": "1", "rankType": 1000}),
                ("topN=1000", {**base, "reportFilter": 1, "campaignType": "1", "rankType": 1, "topN": 1000, "noOfKeywords": 1000, "limit": 1000}),
            ]
            for label, pl in variants:
                try:
                    r = self.s.post(f"{BASE}/rpp/api/reports/search",
                                    headers=self._headers("/rpp"),
                                    data=json.dumps(pl), timeout=30)
                    j = r.json() if r.ok else {}
                    rows = (j.get("data") or {}).get("rppReports") or []
                    diag["payload_variants"].append({
                        "label": label, "status": r.status_code,
                        "rows": len(rows),
                        "errors": (j.get("errors") if isinstance(j, dict) else None),
                    })
                except Exception as e:
                    diag["payload_variants"].append({"label": label, "error": str(e)[:200]})
                time.sleep(0.1)

            # === downloadAsync (사용자가 RMS 네트워크 탭에서 잡아 알려준 정답 endpoint) ===
            diag["downloadAsync"] = {}
            try:
                dlPayload = {
                    "page": 1, "selectionType": selection_type, "periodType": period_type,
                    "startDate": start.isoformat(), "endDate": end.isoformat(),
                    "reportFilter": 1, "campaignType": "1", "rankType": 1,
                    "allUsers": True, "newUsers": True, "existingUsers": True,
                    "noOfClicks": True, "adsalesBefore": True, "cpc": True,
                    "h12": True, "h720": True,
                    "gms": True, "roas": True, "cv": True, "cvr": True, "cpa": True,
                }
                r = self.s.post(f"{BASE}/rpp/api/reports/downloadAsync",
                                headers=self._headers("/rpp"),
                                data=json.dumps(dlPayload), timeout=30)
                diag["downloadAsync"]["status"] = r.status_code
                diag["downloadAsync"]["content_type"] = r.headers.get("Content-Type", "").split(";")[0]
                # 응답 본문 (보통 jobId / async ID가 들어있음)
                try:
                    diag["downloadAsync"]["body"] = r.json()
                except Exception:
                    diag["downloadAsync"]["body_text"] = (r.text or "")[:1000]
                # 모든 응답 헤더 (job ID 단서 찾기)
                diag["downloadAsync"]["all_headers"] = dict(r.headers.items())
            except Exception as e:
                diag["downloadAsync"]["error"] = str(e)[:200]

            # === GET /rpp/api/download/list (사용자가 알려준 정답 endpoint) ===
            diag["download_list"] = {}
            try:
                time.sleep(1.5)  # 라쿠텐이 작업 등록을 처리할 짧은 시간 부여
                lr = self.s.get(f"{BASE}/rpp/api/download/list",
                                headers=self._headers("/rpp"), timeout=20)
                diag["download_list"]["status"] = lr.status_code
                diag["download_list"]["content_type"] = lr.headers.get("Content-Type", "").split(";")[0]
                try:
                    lj = lr.json()
                    diag["download_list"]["body"] = lj
                    rows = self._extract_download_rows(lj)
                    diag["download_list"]["extracted_rows_count"] = len(rows)
                    if rows:
                        diag["download_list"]["first_row_keys"] = sorted(rows[0].keys()) if isinstance(rows[0], dict) else []
                        diag["download_list"]["first_3_rows"] = rows[:3]
                except Exception as e:
                    diag["download_list"]["parse_error"] = str(e)[:200]
                    diag["download_list"]["body_text"] = (lr.text or "")[:1500]
            except Exception as e:
                diag["download_list"]["error"] = str(e)[:200]

            # downloadAsync 후의 다운로드 목록/히스토리 추측 endpoint 정찰
            diag["after_dl_probes"] = []
            for ep in ["/rpp/api/reports/downloadHistory",
                       "/rpp/api/downloadHistory",
                       "/rpp/api/reports/downloads",
                       "/rpp/api/reports/downloadList",
                       "/rpp/api/reports/asyncStatus",
                       "/rpp/api/reports/asyncResult",
                       "/rpp/api/reports/downloadResult",
                       "/shared/api/downloadHistory",
                       "/shared/api/reports/downloadHistory",
                       "/rpp/api/reports/downloadAsync/list",
                       "/rpp/api/reports/downloadAsync/status"]:
                try:
                    rg = self.s.get(f"{BASE}{ep}", headers=self._headers("/rpp"), timeout=15)
                    info = {"endpoint": ep, "status": rg.status_code,
                            "content_type": rg.headers.get("Content-Type", "").split(";")[0],
                            "body_len": len(rg.text or "")}
                    if rg.ok and "json" in info["content_type"]:
                        try:
                            jj = rg.json()
                            info["body_preview"] = json.dumps(jj)[:400]
                        except Exception:
                            info["body_preview"] = (rg.text or "")[:400]
                    elif rg.ok and rg.text:
                        info["body_preview"] = rg.text[:400]
                    diag["after_dl_probes"].append(info)
                except Exception as e:
                    diag["after_dl_probes"].append({"endpoint": ep, "error": str(e)[:200]})
                time.sleep(0.1)

            # === 엔드포인트 정찰 (참고용) ===
            diag["endpoint_probes"] = []
            ep_payload = {**variants[0][1]}  # baseline 페이로드 재사용
            endpoints = [
                ("POST", "/rpp/api/reports/download"),
                ("POST", "/rpp/api/reports/csv"),
                ("POST", "/rpp/api/reports/export"),
                ("POST", "/rpp/api/reports/search/all"),
                ("POST", "/rpp/api/reports/searchAll"),
                ("POST", "/rpp/api/reports/all"),
                ("POST", "/rpp/api/reports/v2/search"),
                ("POST", "/rpp/api/keywordReports/search"),
                ("POST", "/rpp/api/keyword/search"),
                ("GET",  "/rpp/api/reports/download"),
            ]
            for method, ep in endpoints:
                try:
                    if method == "POST":
                        r = self.s.post(f"{BASE}{ep}", headers=self._headers("/rpp"),
                                        data=json.dumps(ep_payload), timeout=30)
                    else:
                        from urllib.parse import urlencode as _ue
                        qs = _ue({
                            "selectionType": selection_type, "periodType": period_type,
                            "startDate": start.isoformat(), "endDate": end.isoformat(),
                            "reportFilter": 1, "campaignType": "1", "rankType": 1,
                        })
                        r = self.s.get(f"{BASE}{ep}?{qs}", headers=self._headers("/rpp"), timeout=30)
                    ct = r.headers.get("Content-Type", "")
                    info = {"method": method, "endpoint": ep, "status": r.status_code,
                            "content_type": ct.split(";")[0], "body_len": len(r.text or "")}
                    # JSON이면 데이터 개수 추출
                    if "json" in ct:
                        try:
                            j2 = r.json()
                            d2 = (j2.get("data") or {}) if isinstance(j2, dict) else {}
                            for k, v in d2.items():
                                if isinstance(v, list):
                                    info[f"list_{k}"] = len(v)
                        except Exception:
                            pass
                    # CSV/HTML/text면 줄수 + HTML 안의 form/링크 추출
                    elif r.ok and r.text:
                        info["lines"] = r.text.count("\n")
                        if "html" in ct or "<html" in r.text[:500].lower():
                            import re as _re
                            html = r.text
                            forms = _re.findall(r'<form[^>]*action=["\']([^"\']+)["\']', html, _re.I)
                            if forms:
                                info["form_actions"] = forms[:5]
                            links = _re.findall(r'href=["\']([^"\']+)["\']', html)
                            dlinks = [l for l in links if _re.search(r'\.(csv|tsv|zip|xlsx?)', l, _re.I)]
                            if dlinks:
                                info["download_links"] = dlinks[:5]
                            scripts = _re.findall(r'(?:fetch|ajax|axios|XMLHttpRequest).*?["\']([^"\']+/api/[^"\']+)["\']', html, _re.I)
                            if scripts:
                                info["api_urls_in_js"] = list(set(scripts))[:8]
                            apipaths = list(set(_re.findall(r'["\']/(rpp|cpa|tda|shared|keyword|item|download|export|csv)[/A-Za-z0-9_\-]+', html)))
                            if apipaths:
                                info["paths_in_html"] = apipaths[:15]
                            info["html_head"] = html[:800]
                    diag["endpoint_probes"].append(info)
                except Exception as e:
                    diag["endpoint_probes"].append({"method": method, "endpoint": ep,
                                                    "error": str(e)[:200]})
                time.sleep(0.15)
            # 정찰 결과를 LAST_RPP_META 에 저장하고, 실제 수집은 가장 row가 많은 variant 페이로드를 사용
            best = max(diag["payload_variants"], key=lambda x: x.get("rows", 0))
            diag["best_variant"] = best.get("label")
            # 실제 데이터는 baseline 으로 받음 (사용자가 메타를 확인할 시간 확보)
            # → 다음 단계에서 best_variant 로 영구 변경 예정

        for page in range(1, 200):
            payload = {
                # 여러 후보 키 (서버가 어느 걸 쓰는지 몰라 모두 전송)
                "page": page, "pageNum": page, "pageNo": page, "pageIndex": page,
                "pageSize": 500, "limit": 500, "noOfRows": 500, "rowsPerPage": 500,
                "selectionType": selection_type,
                "periodType": period_type,
                "startDate": start.isoformat(),
                "endDate": end.isoformat(),
                "reportFilter": 1,
                "campaignType": "1",
                "rankType": 1,
                "allUsers": True, "newUsers": True, "existingUsers": True,
                "noOfClicks": True, "adsalesBefore": True, "cpc": True,
                "h12": True, "h720": True,
                "gms": True, "roas": True, "cv": True, "cvr": True, "cpa": True,
            }
            r = self.s.post(f"{BASE}/rpp/api/reports/search",
                            headers=self._headers("/rpp"), data=json.dumps(payload), timeout=30)
            if not r.ok:
                raise requests.HTTPError(f"{r.status_code} {r.text[:300]}", response=r)
            j = r.json() or {}
            data = j.get("data") or {}
            rows = data.get("rppReports") or []
            if page == 1:
                diag["data_meta_keys"] = sorted(k for k, v in data.items() if not isinstance(v, list))
                diag["data_meta_values"] = {k: v for k, v in data.items() if not isinstance(v, list)}
                diag["top_meta"] = {k: v for k, v in j.items() if k != "data"}
                diag["data_list_keys"] = {k: len(v) for k, v in data.items() if isinstance(v, list)}
                # 응답 row의 campaign / keyword / 핵심 필드를 모두 보여줌 (10건 제한 원인 추정용)
                if rows:
                    diag["row_keys"] = sorted(rows[0].keys())
                    diag["row_summary"] = [
                        {"campaignId": x.get("rppCampaignId"),
                         "campaignName": x.get("campaignName"),
                         "keyword": x.get("keywordString"),
                         "itemUrl": (x.get("itemUrl") or "")[:60]}
                        for x in rows[:10]
                    ]
                    # 캠페인 종류 수 (1개면 「캠페인별 분할」, 다수면 「전체 Top10」 추정)
                    diag["distinct_campaigns"] = len({x.get("rppCampaignId") for x in rows})
            if not rows:
                break
            # 페이지 키가 모두 무시되어 응답이 같은 데이터인지 검출
            key_fn = lambda x: (x.get("rppCampaignId"), x.get("keywordString"),
                                x.get("itemUrl"), x.get("effectDate"))
            cur_keys = {key_fn(x) for x in rows}
            diag["page_results"].append({"page": page, "rows": len(rows),
                                         "same_as_page1": page > 1 and cur_keys == seen_first_keys})
            if page == 1:
                seen_first_keys = cur_keys
                all_rows.extend(rows)
            elif cur_keys == seen_first_keys:
                diag["stop_reason"] = f"page={page} returned same rows as page1 → API ignores pagination."
                break
            else:
                all_rows.extend(rows)
            time.sleep(0.05)
        diag["total_rows"] = len(all_rows)
        LAST_RPP_META.append(diag)
        # 최근 20건만 유지
        if len(LAST_RPP_META) > 20:
            del LAST_RPP_META[:-20]
        return all_rows

    def fetch_rpp_item_daily(self, start: date, end: date,
                             selection_type: int = SEL_ITEM) -> list[dict]:
        """상품별/키워드별은 일별(periodType=2) 불가 → 전체기간(0)으로 '하루씩' 끊어 루프하여 일별화.
        각 행에 그 날짜를 주입해서 반환한다."""
        out = []
        for d in _daterange(start, end):
            rows = self.fetch_rpp(d, d, selection_type=selection_type, period_type=PERIOD_ALL)
            for row in rows:
                row["effectDate"] = d.isoformat()  # 날짜 차원 주입
                out.append(row)
            time.sleep(0.05)  # 안티봇 회피
        return out

    # ---------- RPP 비동기 CSV 다운로드 (키워드별 전건) ----------
    def request_rpp_download(self, start: date, end: date,
                             selection_type: int = 4,
                             period_type=0) -> dict:
        """라쿠텐 RMS의 「効果ダウンロード」와 동일한 비동기 작업을 등록한다.
        검증된 (2026-06-12 Chrome 분석):
          1) POST /rpp/api/reports/downloadAsync → 작업 등록 (status:SUCCESS만 옴)
          2) GET  /rpp/api/download/list         → id, status, reportType, periodType
          3) GET  /rpp/api/download/report?downloadId=...&reportType=<13|14>  → ZIP(CSV)
        periodType (검증값): 0 (全期間で表示)=확정 OK / "daily" = 일별 (검증중) / 2 = 거부됨"""
        payload = {
            "page": 1, "selectionType": selection_type, "periodType": period_type,
            "startDate": start.isoformat(), "endDate": end.isoformat(),
            "reportFilter": 1, "campaignType": "1", "rankType": 1,
            "allUsers": True, "newUsers": True, "existingUsers": True,
            "noOfClicks": True, "adsalesBefore": True, "cpc": True,
            "h12": True, "h720": True,
            "gms": True, "roas": True, "cv": True, "cvr": True, "cpa": True,
        }
        r = self.s.post(f"{BASE}/rpp/api/reports/downloadAsync",
                        headers=self._headers("/rpp"),
                        data=json.dumps(payload), timeout=30)
        return {"status": r.status_code, "body": r.json() if r.ok else r.text}

    def fetch_rpp_download_csv(self, download_id: int | str,
                               report_type: int = 14) -> str:
        """라쿠텐 「効果ダウンロード」 결과를 받는다 (ZIP 압축 CSV).
        검증된 URL: GET /rpp/api/download/report?downloadId=...&reportType=14
        검증된 응답: ZIP 파일 (PK 시그니처) - 안에 .csv 1개. cp932 인코딩."""
        from urllib.parse import urlencode as _ue
        import zipfile as _zip
        import io as _io2
        qs = _ue({"downloadId": download_id, "reportType": report_type})
        r = self.s.get(f"{BASE}/rpp/api/download/report?{qs}",
                       headers=self._headers("/rpp"), timeout=60)
        r.raise_for_status()
        content = r.content
        # 응답이 ZIP 인지 시그니처 확인 (PK\x03\x04 또는 PK\x05\x06 등)
        if content[:2] == b"PK":
            with _zip.ZipFile(_io2.BytesIO(content)) as zf:
                csv_names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
                if not csv_names:
                    # csv가 아니라도 첫 파일 시도
                    csv_names = zf.namelist()
                if not csv_names:
                    raise ValueError(f"ZIP에 추출 가능한 파일이 없음: {zf.namelist()}")
                with zf.open(csv_names[0]) as f:
                    raw = f.read()
        else:
            raw = content
        # 일본어 CSV는 보통 Shift-JIS (cp932)
        try:
            return raw.decode("cp932")
        except UnicodeDecodeError:
            try:
                return raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                return raw.decode("utf-8", errors="replace")

    def fetch_rpp_download_list_raw(self):
        """다운로드 이력 목록 (생 응답). GET /rpp/api/download/list"""
        r = self.s.get(f"{BASE}/rpp/api/download/list",
                       headers=self._headers("/rpp"), timeout=20)
        r.raise_for_status()
        j = r.json()
        return j if j is not None else {}

    def _extract_download_rows(self, list_json) -> list[dict]:
        """list 응답에서 row 리스트 추출. 확인됨: 응답이 list 자체."""
        if isinstance(list_json, list):
            return list_json
        data = list_json.get("data") if isinstance(list_json, dict) else None
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for v in data.values():
                if isinstance(v, list) and v and isinstance(v[0], dict):
                    return v
        return []

    def fetch_rpp_csvs_pipeline(self, jobs: list[tuple],
                                 max_concurrent: int = 4,
                                 poll_interval: float = 1.5,
                                 max_wait: float = 1800.0,
                                 progress_cb=None,
                                 cancel_cb=None) -> dict:
        """라쿠텐 큐 한도(약 5개)에 맞춰 pipeline으로 작업 처리.
        측정: 14개 동시 등록 시도 → 5개만 받음 → 약 8초에 5개 처리 완료.
        → 4~5개씩 라쿠텐 큐에 유지하면서 흘려보냄. 60작업도 약 2분 안 처리."""
        import time as _t

        def _key(j):
            sel, rt, st, ed = j
            return (sel, rt, st.isoformat(), ed.isoformat())

        # 1) 시작 전 list snapshot — 이미 완료된 같은 조건 재사용
        try:
            initial = self._extract_download_rows(self.fetch_rpp_download_list_raw())
        except Exception:
            initial = []
        before_ids = {r.get("id") for r in initial if isinstance(r, dict)}

        out: dict = {}
        queue = []  # 등록 대기 — 캐시 무시, 항상 새로 다운로드 (720h CV 정확도 보장)
        for j in jobs:
            k = _key(j)
            out[k] = None
            queue.append((j, k))

        if progress_cb:
            progress_cb(sum(1 for v in out.values() if v is not None), len(jobs))

        # 2) Pipeline: 라쿠텐 큐에 max_concurrent개 유지하며 흘림
        in_flight: dict = {}  # rakuten_id → (job, key)
        retry_count: dict = {}
        t_start = _t.time()

        while (queue or in_flight) and (_t.time() - t_start) < max_wait:
            if cancel_cb and cancel_cb():
                break
            # 큐에 여유 있으면 새 작업 등록 (한 번에 여러 개 등록 후 한 번만 list 확인)
            registered_pending = []  # (j, k) 등록은 했지만 id 미할당
            while len(in_flight) + len(registered_pending) < max_concurrent and queue:
                j, k = queue.pop(0)
                sel, rt, st, ed = j
                try:
                    self.request_rpp_download(st, ed, selection_type=sel, period_type=0)
                    registered_pending.append((j, k))
                except Exception:
                    queue.append((j, k))
                    _t.sleep(1.0)
                    break
                _t.sleep(0.3)
            # 등록한 작업의 id 찾기 (한 번만 list 호출)
            rows = []
            if registered_pending:
                _t.sleep(0.5)
                try:
                    rows = self._extract_download_rows(self.fetch_rpp_download_list_raw())
                except Exception:
                    rows = []
            for j, k in registered_pending:
                sel, rt, st, ed = j
                matches = [r for r in rows if isinstance(r, dict)
                           and r.get("id") not in before_ids
                           and r.get("id") not in in_flight
                           and r.get("reportType") == rt
                           and r.get("startDate") == st.isoformat()
                           and r.get("endDate") == ed.isoformat()
                           and r.get("periodType") == 0]
                if matches:
                    rid = max(matches, key=lambda r: r.get("id", 0))["id"]
                    in_flight[rid] = (j, k, _t.time())  # (job, key, 등록시각)
                else:
                    # 라쿠텐 등록 거부 — 큐 부담일 수 있어 큐 뒤로 보내 재시도
                    n = retry_count.get(k, 0) + 1
                    retry_count[k] = n
                    if n <= 10:
                        queue.append((j, k))
                    # 10회 시도 후에도 안 받으면 출력 누락 (별도 진단 필요)

            # 폴링 — 완료된 작업 CSV 다운로드
            _t.sleep(poll_interval)
            try:
                rows = self._extract_download_rows(self.fetch_rpp_download_list_raw())
            except Exception:
                continue
            for rid, val in list(in_flight.items()):
                if len(val) == 3:
                    j, k, t_reg = val
                else:
                    j, k = val; t_reg = _t.time()
                row = next((r for r in rows if isinstance(r, dict) and r.get("id") == rid), None)
                if row and row.get("status") == 2:
                    _, rt, _, _ = j
                    try:
                        out[k] = self.fetch_rpp_download_csv(rid, report_type=rt)
                    except Exception:
                        out[k] = None
                    del in_flight[rid]
                    if progress_cb:
                        progress_cb(sum(1 for v in out.values() if v is not None), len(jobs))
                elif row and row.get("status") in (3, 9):
                    # 라쿠텐이 실패/취소 — 재시도 3회 (라쿠텐이 거부하는 일자는 무한 시도해도 답 없음)
                    n = retry_count.get(k, 0) + 1
                    retry_count[k] = n
                    if n <= 3:
                        queue.append((j, k))
                    del in_flight[rid]
                elif _t.time() - t_reg > 300:  # 작업당 5분 무응답 → 재등록 (포기 X)
                    n = retry_count.get(k, 0) + 1
                    retry_count[k] = n
                    if n <= 10:
                        queue.append((j, k))
                    del in_flight[rid]

        return out

    def fetch_rpp_csvs_batch(self, jobs: list[tuple],
                              poll_interval: float = 3.0,
                              max_wait: float = 300.0,
                              progress_cb=None) -> dict:
        """여러 작업을 한 번에 등록 + 폴링 + CSV 다운로드.
        jobs: [(selection_type, report_type, start_date, end_date), ...]
        반환: {(sel, rt, start_iso, end_iso): csv_text or None}
        라쿠텐 처리 약 10초/작업, 병렬 등록하면 전체도 빠름."""
        import time as _t
        # 1) 시작 전 list snapshot
        try:
            initial = self._extract_download_rows(self.fetch_rpp_download_list_raw())
        except Exception:
            initial = []
        before_ids = {r.get("id") for r in initial if isinstance(r, dict)}

        def _key(j):
            sel, rt, st, ed = j
            return (sel, rt, st.isoformat(), ed.isoformat())

        # 2) 각 작업: 이미 완료된 같은 조건이 있으면 그 id, 없으면 등록
        # 라쿠텐 큐 부담 회피 — 한 번에 너무 많이 등록하지 않고 batch로 나눠 등록 + 확인
        targets: dict = {}
        # 이미 완료된 작업 먼저 매칭
        new_jobs = []
        for j in jobs:
            sel, rt, st, ed = j
            k = _key(j)
            completed = [r for r in initial if isinstance(r, dict)
                         and r.get("reportType") == rt
                         and r.get("startDate") == st.isoformat()
                         and r.get("endDate") == ed.isoformat()
                         and r.get("periodType") == 0
                         and r.get("status") == 2]
            if completed:
                targets[k] = max(completed, key=lambda r: r.get("id", 0))["id"]
            else:
                targets[k] = None
                new_jobs.append(j)

        # 신규 등록 — 5개씩 batch로 나눠 등록 + 즉시 list 재확인 + 등록 누락 분 재시도
        BATCH = 5
        for i in range(0, len(new_jobs), BATCH):
            batch = new_jobs[i:i+BATCH]
            for j in batch:
                sel, rt, st, ed = j
                try:
                    self.request_rpp_download(st, ed, selection_type=sel, period_type=0)
                except Exception:
                    pass
                _t.sleep(0.2)
            # batch 등록 후 list 확인 — 안 보이는 작업 한 번 더 등록 시도
            _t.sleep(2.0)
            try:
                cur_rows = self._extract_download_rows(self.fetch_rpp_download_list_raw())
            except Exception:
                cur_rows = []
            for j in batch:
                sel, rt, st, ed = j
                cur_matches = [r for r in cur_rows if isinstance(r, dict)
                               and r.get("id") not in before_ids
                               and r.get("reportType") == rt
                               and r.get("startDate") == st.isoformat()
                               and r.get("endDate") == ed.isoformat()
                               and r.get("periodType") == 0]
                if not cur_matches:
                    # 라쿠텐이 등록을 받지 못함 — 한 번 더 시도
                    try:
                        self.request_rpp_download(st, ed, selection_type=sel, period_type=0)
                    except Exception:
                        pass
                    _t.sleep(0.3)

        if progress_cb:
            done_now = sum(1 for v in targets.values() if v is not None)
            progress_cb(done_now, len(targets))

        # 3) None인 target들이 status=2 될 때까지 폴링
        pending_keys = [k for k, v in targets.items() if v is None]
        waited = 0.0
        while pending_keys and waited < max_wait:
            _t.sleep(poll_interval)
            waited += poll_interval
            try:
                rows = self._extract_download_rows(self.fetch_rpp_download_list_raw())
            except Exception:
                continue
            still_pending = []
            for k in pending_keys:
                sel, rt, st_iso, ed_iso = k
                matches = [r for r in rows if isinstance(r, dict)
                           and r.get("id") not in before_ids
                           and r.get("reportType") == rt
                           and r.get("startDate") == st_iso
                           and r.get("endDate") == ed_iso
                           and r.get("periodType") == 0]
                completed_match = [r for r in matches if r.get("status") == 2]
                if completed_match:
                    targets[k] = max(completed_match, key=lambda r: r.get("id", 0))["id"]
                else:
                    still_pending.append(k)
            pending_keys = still_pending
            if progress_cb:
                done_now = sum(1 for v in targets.values() if v is not None)
                progress_cb(done_now, len(targets))

        # 4) 완료된 모든 CSV 다운로드
        out: dict = {}
        for k, rid in targets.items():
            if rid is None:
                out[k] = None
                continue
            _, rt, _, _ = k
            try:
                out[k] = self.fetch_rpp_download_csv(rid, report_type=rt)
            except Exception:
                out[k] = None
        return out

    def fetch_rpp_keyword_csv(self, start: date, end: date,
                              poll_interval: float = 3.0,
                              max_wait: float = 90.0,
                              period_type=0) -> str:
        """downloadAsync → list 폴링 → CSV 다운로드.
        실용적 최적화: 이미 라쿠텐에 등록되어 완료된 같은 조건의 작업이 있으면 재사용
        (사용자가 이전에 한 번 등록했다면 5~10분 뒤 자동 완료되어 list 에 남아있음)."""
        import time as _t

        def _matches(r: dict) -> bool:
            return (isinstance(r, dict)
                    and r.get("reportType") == 14
                    and r.get("startDate") == start.isoformat()
                    and r.get("endDate") == end.isoformat()
                    and r.get("periodType") == period_type)

        # 1) 시작 전 list 확인 - 이미 완료된 같은 조건 작업이 있으면 즉시 재사용
        initial_rows = []
        try:
            initial_rows = self._extract_download_rows(self.fetch_rpp_download_list_raw())
        except Exception:
            pass
        completed = [r for r in initial_rows if _matches(r) and r.get("status") == 2]
        if completed:
            # 가장 최근(가장 큰 id) 완료 작업 재사용 — 라쿠텐이 사용자/우리 이전 요청을 처리 완료
            best = max(completed, key=lambda r: r.get("id", 0))
            return self.fetch_rpp_download_csv(best["id"], report_type=14)

        # 2) 새 작업 등록
        before_ids = {r.get("id") for r in initial_rows if isinstance(r, dict)}
        self.request_rpp_download(start, end, selection_type=4, period_type=period_type)

        # 3) 짧게 폴링 — 라쿠텐이 빨리 완료한 경우만 동기적으로 받음.
        # 타임아웃 시 사용자에게 「잠시 후 다시 시도」 안내 메시지.
        waited = 0.0
        target_id = None
        while waited < max_wait:
            _t.sleep(poll_interval)
            waited += poll_interval
            try:
                rows = self._extract_download_rows(self.fetch_rpp_download_list_raw())
            except Exception:
                continue
            for r in rows:
                if not _matches(r):
                    continue
                rid = r.get("id")
                if rid in before_ids:
                    continue
                if r.get("status") == 2:
                    return self.fetch_rpp_download_csv(rid, report_type=14)
                target_id = rid
                break
        raise TimeoutError(
            f"楽天サーバーでダウンロード作業を処理中です（target_id={target_id}）。"
            f"通常 5〜10分かかります。後でもう一度「取得」を押すと、"
            f"完了済みの作業を自動で取り込みます。"
        )

    # ---------- CPA ----------
    def fetch_cpa(self, start: date, end: date, period_type: int = PERIOD_DAY) -> list[dict]:
        qs = urlencode({"page": 1, "periodType": period_type,
                        "startDate": start.isoformat(), "endDate": end.isoformat()})
        r = self.s.get(f"{BASE}/cpa/api/reports/search?{qs}", headers=self._headers("/cpa"), timeout=30)
        if r.status_code == 400:  # 데이터 없음
            return []
        r.raise_for_status()
        d = r.json().get("data") or {}
        for v in d.values():
            if isinstance(v, list):
                return v
        return []

    # ---------- TDA ----------
    def fetch_tda(self, start: date, end: date, campaign_type: int = 1,
                  selection_type: int = SEL_ALL, period_type: int = PERIOD_DAY) -> list[dict]:
        qs = urlencode({"page": 1, "campaignType": campaign_type,
                        "selectionType": selection_type, "periodType": period_type,
                        "reportStartDate": start.isoformat(), "reportEndDate": end.isoformat()})
        r = self.s.get(f"{BASE}/tda/api/aggregator/v2/reports/search?{qs}",
                       headers=self._headers("/tda"), timeout=30)
        if r.status_code == 400:
            return []
        r.raise_for_status()
        d = r.json().get("data") or {}
        for v in d.values():
            if isinstance(v, list):
                return v
        return []

    # ---------- 광고구매이력 (월별 청구액, 전 상품) ----------
    def fetch_purchase_summary(self, month: str) -> dict:
        """month: 'YYYY-MM'. 모든 광고 상품의 월별 청구액 반환."""
        qs = urlencode({"targetMonth": month, "period": 1})
        r = self.s.get(f"{BASE}/shared/api/purchase_summary?{qs}", headers=self._headers("/shared"), timeout=30)
        r.raise_for_status()
        return r.json().get("data") or {}


# ---------- 정규화: TDA 응답 → DB 행 (검증 2026-06-08) ----------
def normalize_tda(rows: list[dict], shop_id: str) -> list[dict]:
    """TDA(디스플레이 광고) 응답을 ad_daily_performance 스키마로.
    필드: ctNum=클릭, viewableImpNum=노출, spendingBudget=광고비,
          vtCvAmount=매출(뷰스루), vtCvNum=CV, vtRoas=ROAS(%), tdaCpc=CPC, deliveryDate=날짜.
    (TDA는 12h/720h 구분이 없어 720h 버킷에 저장. cvr은 클릭기반이 아니라 생략.)"""
    out = []
    for row in rows:
        dd = row.get("deliveryDate")
        rdate = dd[:10] if isinstance(dd, str) else None
        if not rdate:
            continue
        clicks = row.get("ctNum")
        cost = row.get("spendingBudget")
        cv = row.get("vtCvNum")
        roas = row.get("vtRoas")
        out.append({
            "shop_id": shop_id, "ad_product": "TDA", "selection_type": 1,
            "report_date": rdate, "campaign_id": str(row.get("campaignId") or ""),
            "dimension_key": row.get("keyword") or "",
            "campaign_name": row.get("campaignName"),
            "item_url": "",
            "user_segment": "all", "cv_window": "720h",
            "clicks": clicks, "impressions": row.get("viewableImpNum"),
            "ad_cost": cost, "gms": row.get("vtCvAmount"), "cv": cv,
            "cvr": None,  # 뷰스루 전환이라 클릭기반 CVR 무의미
            "roas": (roas / 100.0) if roas is not None else None,
            "cpc": row.get("tdaCpc"),
            "cpa": round(cost / cv) if cost and cv else None,
        })
    return out


# ---------- 정규화: RPP 중첩 응답 → 평탄한 DB 행 ----------
def normalize_rpp(rows: list[dict], shop_id: str, selection_type: int) -> list[dict]:
    """RPP 한 행에는 total/new/existing × 12h/720h 가 중첩돼 있다. 이를 평탄화."""
    out = []
    seg_keys = [("all", "totalUsersReport"),
                ("new", "newUsersReport"),
                ("existing", "existingUsersReport")]
    for row in rows:
        # 키워드별(sel=4)은 dimension_key=키워드, item_url에 매칭 상품URL을 저장
        # 상품별(sel=3)은 dimension_key=상품URL
        base = {
            "shop_id": shop_id,
            "ad_product": "RPP",
            "selection_type": selection_type,
            "report_date": row.get("effectDate"),
            "campaign_id": row.get("rppCampaignId") or "",
            "dimension_key": (row.get("keywordString") or row.get("itemUrl") or ""),
            "campaign_name": row.get("campaignName"),
            "item_url": row.get("itemUrl") or row.get("itemPageUrl") or "",
        }
        # 행 수준 CTR. 라쿠텐 RPP는 ROAS/CVR과 같이 % 단위 (예: 1.14 = 1.14%) → /100 で비율化.
        ctr_raw = row.get("ctr")
        ctr = (ctr_raw / 100.0) if ctr_raw is not None else None
        for seg, key in seg_keys:
            seg_data = row.get(key) or {}
            if not seg_data:
                continue
            clicks = seg_data.get("clicksValid")
            # 노출수 = 클릭/CTR. CTR은 전체(all) 기준이라 all 세그먼트에만 역산.
            impressions = (round(clicks / ctr) if seg == "all" and ctr and clicks
                           else None)
            for win in ("type12H", "type720H"):
                w = seg_data.get(win) or {}
                # 라쿠텐 RPP 의 roas·cvr 은 '퍼센트'(예: 350.88 = 3.51배, 3.24 = 3.24%).
                # 내부 표준(비율)으로 통일하기 위해 100으로 나눠 저장.
                roas = w.get("roas")
                cvr = w.get("cvr")
                out.append({
                    **base,
                    "user_segment": seg,
                    "cv_window": "12h" if win == "type12H" else "720h",
                    "clicks": clicks,
                    "impressions": impressions,
                    "ad_cost": seg_data.get("adSalesBeforeDiscount"),
                    "cpc": seg_data.get("cpc"),
                    "gms": w.get("gms"),
                    "cv": w.get("cv"),
                    "cvr": (cvr / 100.0) if cvr is not None else None,
                    "roas": (roas / 100.0) if roas is not None else None,
                    "cpa": w.get("cpa"),
                })
    return out
