"""
inspect_raw.py — CPA/TDA 등 원본 응답(ad_daily_raw) 구조 분석 + 정규화 매핑 스켈레톤 생성기.

실제 라쿠텐 응답을 한 번 수집한 뒤 실행하면:
  - 저장된 (상품 × 날짜) 목록
  - 특정 상품의 필드 union + 샘플값 (일본어 필드명 확인용)
  - normalize_<product>() 함수 스켈레톤(추정 매핑 주석 포함) 출력

사용:
  py inspect_raw.py                 # 저장된 raw 목록
  py inspect_raw.py CPA             # CPA 필드 구조 + 매핑 스켈레톤
  py inspect_raw.py TDA 2026-06-07  # 특정 날짜
"""
from __future__ import annotations
import json
import sys

try:  # Windows cp932 콘솔에서 한글 출력 깨짐 방지
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from db import DB, _flatten

# DB 경로는 config.json 의 db_path 따름
try:
    with open("config.json", encoding="utf-8") as f:
        DBP = json.load(f).get("db_path", "smartprofit.db")
except Exception:
    DBP = "smartprofit.db"

# 추정 매핑 후보(실제 응답 보고 확정). 일본어 필드명 → 표준 컬럼.
GUESS = {
    "clicks": ["clicks", "click", "クリック", "クリック数", "clickCount"],
    "ad_cost": ["cost", "adCost", "費用", "広告費", "actualCost", "consumption"],
    "gms": ["sales", "gms", "売上", "流通総額", "salesAmount", "conversionSales"],
    "cv": ["cv", "conversion", "コンバージョン", "件数", "cvCount"],
    "roas": ["roas", "ROAS"],
    "cpc": ["cpc", "CPC"],
    "cpa": ["cpa", "CPA"],
    "campaign_name": ["campaignName", "name", "キャンペーン名", "キャンペーン"],
}


def suggest(field_keys):
    # 전체 키 + 점표기 leaf(마지막 세그먼트) 둘 다로 매칭
    low = {k.lower(): k for k in field_keys}
    leaf = {k.split(".")[-1].lower(): k for k in field_keys}
    out = {}
    for std, cands in GUESS.items():
        for c in cands:
            cl = c.lower()
            if cl in low:
                out[std] = low[cl]; break
            if cl in leaf:
                out[std] = leaf[cl]; break
    return out


def main():
    db = DB(DBP)
    product = sys.argv[1] if len(sys.argv) > 1 else None
    day = sys.argv[2] if len(sys.argv) > 2 else None

    with db.cursor() as cur:
        cur.execute("SELECT ad_product, report_date, row_count FROM ad_daily_raw ORDER BY report_date DESC")
        recs = cur.fetchall()
    if not recs:
        print(f"[{DBP}] 에 저장된 원본(raw) 데이터가 없습니다. 먼저 실제 세션으로 하루치를 수집하세요.")
        return
    if not product:
        print(f"DB: {DBP}\n저장된 원본 응답:")
        for r in recs:
            print(f"  - {r['ad_product']:5s} {r['report_date']}  ({r['row_count']}행)")
        print("\n특정 상품 구조 보기:  py inspect_raw.py CPA")
        return

    dates = [r["report_date"] for r in recs if r["ad_product"] == product]
    if not dates:
        print(f"{product} 원본이 없습니다. 보유: {sorted({r['ad_product'] for r in recs})}")
        return
    target = day or dates[0]
    rows = db.get_raw("", product, target, target)  # shop_id 무관하게? -> 아래 보정
    if not rows:
        # shop_id 필터 때문에 비면 전체 조회
        with db.cursor() as cur:
            cur.execute("SELECT payload FROM ad_daily_raw WHERE ad_product=? AND report_date=?",
                        (product, target))
            rec = cur.fetchone()
        raw = json.loads(rec["payload"]) if rec else []
        rows = [_flatten(x) for x in (raw if isinstance(raw, list) else [raw])]

    if not rows:
        print(f"{product} {target}: 행 없음(빈 응답).")
        return

    keys = []
    for r in rows:
        for k in r:
            if k not in keys:
                keys.append(k)

    print(f"=== {product} {target} · {len(rows)}행 · 필드 {len(keys)}개 ===\n")
    sample = rows[0]
    for k in keys:
        v = sample.get(k)
        sv = (str(v)[:40] + "…") if v is not None and len(str(v)) > 40 else v
        print(f"  {k:32s} = {sv!r}")

    mp = suggest(keys)
    print("\n--- 추정 매핑 (실제 의미 확인 후 수정) ---")
    for std in ["report_date", "campaign_name", "clicks", "ad_cost", "gms", "cv", "roas", "cpc", "cpa"]:
        src = "report_date" if std == "report_date" else mp.get(std)
        print(f"  {std:14s} <- {src or '???  # 매핑 필요'}")

    print(f"\n--- normalize_{product.lower()}() 스켈레톤 ---")
    print(f"""def normalize_{product.lower()}(rows, shop_id, report_date):
    out = []
    for row in rows:
        f = _flatten(row)
        out.append({{
            "shop_id": shop_id, "ad_product": "{product}", "selection_type": 1,
            "report_date": report_date, "campaign_id": "", "dimension_key": "",
            "campaign_name": f.get({mp.get('campaign_name')!r}),
            "user_segment": "all", "cv_window": "720h",
            "clicks": f.get({mp.get('clicks')!r}),
            "ad_cost": f.get({mp.get('ad_cost')!r}),
            "gms": f.get({mp.get('gms')!r}),
            "cv": f.get({mp.get('cv')!r}),
            # roas/cpc/cpa 는 합계기반 재계산 권장
        }})
    return out""")


if __name__ == "__main__":
    main()
