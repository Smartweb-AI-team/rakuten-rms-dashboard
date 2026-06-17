"""
collector.py
일별 자동 수집. 매일 실행: 전일까지의 데이터를 수집하되, 과거 변동 보정을 위해
최근 N일(기본 14일)을 재수집(upsert 덮어쓰기)한다.

cron 예시:  30 0 * * *  python main.py collect
"""
from __future__ import annotations
import time
from collections import defaultdict
from datetime import date, timedelta

from rakuten_client import (RakutenAdClient, normalize_rpp, normalize_tda,
                            SEL_ALL, SEL_CAMPAIGN, SEL_ITEM, SEL_KEYWORD,
                            PERIOD_DAY, PERIOD_ALL)
from db import DB

# 검증된 라쿠텐 RMS 조회 제약 (2026-06-08 실측)
ALL_MAX_MONTHS = 3        # 전체/캠페인: 한 요청 최대 3개월 (period=2, 일별로 반환)
CPA_TDA_MAX_MONTHS = 3    # CPA/TDA: 한 요청 최대 3개월

def _two_years_first_day(today: date | None = None) -> date:
    """오늘 기준 2년 전 그 달의 1일. (예: 2026-06-17 → 2024-06-01)"""
    t = today or date.today()
    return date(t.year - 2, t.month, 1)


def _month_chunks(start: date, end: date, n_months: int):
    """[start, end] 를 최대 n개월 길이의 (cs, ce) 조각으로 분할."""
    cs = start
    while cs <= end:
        # cs 기준 n개월 뒤 - 1일
        y, m = cs.year, cs.month + n_months
        y += (m - 1) // 12
        m = (m - 1) % 12 + 1
        ce = min(end, date(y, m, 1) - timedelta(days=1))
        yield cs, ce
        cs = ce + timedelta(days=1)


def _store_raw_by_date(db: DB, shop_id: str, product: str, rows: list,
                       chunk_start: date) -> int:
    """CPA/TDA 등 원본 행을 날짜별로 갈라 ad_daily_raw 에 저장.
    날짜 필드를 못 찾으면 청크 시작일 하나로 보존(데이터 확인 후 정교화)."""
    if not rows:
        return 0
    datekey = next((k for k in rows[0] if "date" in k.lower()), None)
    if datekey:
        groups = defaultdict(list)
        for r in rows:
            groups[str(r.get(datekey))[:10]].append(r)
        return sum(db.upsert_raw(shop_id, product, d, rs) for d, rs in groups.items())
    return db.upsert_raw(shop_id, product, chunk_start.isoformat(), rows)


def collect_daily(client: RakutenAdClient, db: DB, shop_id: str,
                  lookback_days: int = 14, today: date | None = None) -> dict:
    """매일 실행용: 전일까지 + 최근 N일 재수집(변동 보정). collect_range 재사용."""
    today = today or date.today()
    end = today - timedelta(days=1)            # 전일까지만 확정
    start = end - timedelta(days=lookback_days)
    return collect_range(client, db, shop_id, start, end)


def collect_range(client: RakutenAdClient, db: DB, shop_id: str,
                  start: date, end: date) -> dict:
    """임의 기간 [start, end] 을 '딸깍' 수집. UI 버튼/백필이 호출.
    RPP(전체/캠페인/상품)는 정규화 저장, CPA/TDA 는 원본(JSON) 보존.

    중요: 라쿠텐은 과거 데이터의 '다중일 범위' 요청을 거부(400)하고 '하루 단위'만 허용한다.
    (최근 구간은 범위 요청도 되지만) 모든 날짜에서 안정 동작하도록 하루씩 루프한다.
    반환: 광고상품별 적재 행 수 요약."""
    if not client.check_session():
        raise RuntimeError("セッション切れ — 拡張機能でCookieを再送信してください")

    report = {"date_from": start.isoformat(), "date_to": end.isoformat(),
              "RPP_sel1": 0, "RPP_sel2": 0, "RPP_item": 0, "RPP_keyword": 0,
              "CPA_rows": 0, "TDA_rows": 0, "skipped_calls": 0,
              "skips": {}, "notes": []}

    today_d = date.today()

    def classify_fail(category, ctx_date, err_msg):
        """라쿠텐 응답·호출 컨텍스트로 정확한 실패 사유 분류."""
        s = str(err_msg)
        # 라쿠텐 응답 본문에서 errors[].message 추출 시도
        body_msg = None
        if "{" in s and "errors" in s:
            import re
            m = re.search(r'"message"\s*:\s*"([^"]+)"', s)
            if m: body_msg = m.group(1).split("\\n")[0]
        # HTTP 코드별
        if "401" in s or "403" in s:
            return "認証エラー (セッション切れの可能性) — Cookie再送信が必要"
        if "500" in s or "502" in s or "503" in s:
            return "楽天サーバーエラー (時間をおいて再試行)"
        if "Timeout" in s or "timed out" in s.lower():
            return "タイムアウト (ネットワーク確認)"
        if "400" in s:
            # 컨텍스트로 분류
            years = (today_d - ctx_date).days / 365.0 if ctx_date else 0
            if category in ("商品別", "キーワード別") and years >= 2:
                return f"2年保存期限を超過 ({ctx_date.isoformat()}は約{years:.1f}年前)"
            if category in ("全体広告", "キャンペーン別") and years >= 4:
                return f"4年保存期限を超過 ({ctx_date.isoformat()}は約{years:.1f}年前)"
            if body_msg:
                return f"楽天応答: {body_msg[:80]}"
            return "対象期間にデータなし、または楽天側の制限 (HTTP 400)"
        return s[:80] or "不明なエラー"

    def guard(category, fn, ctx_date=None):
        # 개별 호출 실패는 분류된 사유로 기록하고 계속 진행.
        try:
            return fn()
        except Exception as e:
            report["skipped_calls"] += 1
            reason = classify_fail(category, ctx_date, e)
            report["skips"][f"{category} · {reason}"] = \
                report["skips"].get(f"{category} · {reason}", 0) + 1
            return 0

    # 1) 전체 + 캠페인: period=2(일별), 최대 3개월 범위로 한 번에
    # 모든 sel 통일: 2년 전 1일까지만 (2024-06-01 같은 기준)
    cutoff_2y = _two_years_first_day()
    capped_start = max(start, cutoff_2y)
    if start < cutoff_2y:
        report["notes"].append(
            f"全広告: {cutoff_2y.isoformat()} より前は2年保存上限のため取得対象外")
    for sel, key, label in ((SEL_ALL, "RPP_sel1", "全体広告"),
                            (SEL_CAMPAIGN, "RPP_sel2", "キャンペーン別")):
        for cs, ce in _month_chunks(capped_start, end, ALL_MAX_MONTHS):
            report[key] += guard(label, lambda cs=cs, ce=ce, sel=sel: db.upsert_performance(
                normalize_rpp(client.fetch_rpp(cs, ce, selection_type=sel, period_type=PERIOD_DAY),
                              shop_id, sel)), ctx_date=cs)

    # 2) 상품별 + 키워드별: period=0(전체기간)을 '하루씩'(d~d) 찍어 일별화. 최근 약 2년만.
    item_cutoff = _two_years_first_day()
    istart = max(start, item_cutoff)
    # 라쿠텐은 「오늘 이후」 일자 거부 → 어제까지로 제한
    yesterday = date.today() - timedelta(days=1)
    end_eff = min(end, yesterday)
    if start < istart:
        report["notes"].append(
            f"商品別・キーワード別: {istart.isoformat()} より前は楽天の2年保存上限のため取得対象外")
    if end > end_eff:
        report["notes"].append(
            f"商品別・キーワード別: {(end_eff + timedelta(days=1)).isoformat()} 以降は前日まで未取得（楽天が当日以降は拒否）")
    # 상품별 + 키워드별 — downloadAsync (정확한 전건) 동기 일괄.
    from rakuten_client import normalize_rpp_item_csv, normalize_rpp_keyword_csv
    batch_jobs = []
    d = istart
    while d <= end_eff:
        batch_jobs.append((SEL_ITEM, 13, d, d))
        batch_jobs.append((SEL_KEYWORD, 14, d, d))
        d += timedelta(days=1)
    try:
        # 측정: 라쿠텐 동시 큐 한도 약 5개 → pipeline 4개씩 흘림.
        # 데이터 누락 방지: 작업당 timeout 5분 + 자동 재등록 10회. 모든 데이터 받을 때까지.
        # max_wait는 안전 상한선만 (작업당 60초 × 재시도 10회 + 여유)
        csvs = client.fetch_rpp_csvs_pipeline(
            batch_jobs, max_concurrent=4, poll_interval=5.0,
            max_wait=max(1800.0, len(batch_jobs) * 60.0))
        for (sel, rt, st_iso, ed_iso), csv_text in csvs.items():
            if not csv_text:
                report["skipped_calls"] += 1
                report["skips"][f"{('商品別' if sel==3 else 'キーワード別')} · ダウンロード未完了"] = \
                    report["skips"].get(f"{('商品別' if sel==3 else 'キーワード別')} · ダウンロード未完了", 0) + 1
                continue
            if sel == SEL_KEYWORD:
                rows_norm = normalize_rpp_keyword_csv(csv_text, shop_id)
                report["RPP_keyword"] += db.upsert_performance(rows_norm)
            elif sel == SEL_ITEM:
                rows_norm = normalize_rpp_item_csv(csv_text, shop_id)
                report["RPP_item"] += db.upsert_performance(rows_norm)
    except Exception as e:
        report["notes"].append(f"⚠️ 商品/キーワード ダウンロード処理エラー: {str(e)[:200]}")

    # 3) CPA / TDA: 최대 3개월 범위로. TDA는 정규화 저장(대시보드용)+원본 보존, CPA는 원본만.
    def _collect_cpa_tda(product, fetch, cs, ce):
        rows = fetch(cs, ce)
        n = _store_raw_by_date(db, shop_id, product, rows, cs)
        if product == "TDA" and rows:
            db.upsert_performance(normalize_tda(rows, shop_id))
        return n
    for product, fetch in (("CPA", client.fetch_cpa), ("TDA", client.fetch_tda)):
        for cs, ce in _month_chunks(start, end, CPA_TDA_MAX_MONTHS):
            report[f"{product}_rows"] += guard(
                product, lambda product=product, fetch=fetch, cs=cs, ce=ce:
                _collect_cpa_tda(product, fetch, cs, ce), ctx_date=cs)

    db.log_collect(shop_id, start.isoformat(), end.isoformat(), "live", report)
    return report


def collect_day(client: RakutenAdClient, db: DB, shop_id: str, day: date) -> dict:
    """하루치 '딸깍' 수집."""
    return collect_range(client, db, shop_id, day, day)


if __name__ == "__main__":
    import os
    client = RakutenAdClient.from_storage_state(
        os.environ.get("RAKUTEN_STORAGE_STATE", "storage_state.json"))
    db = DB()
    print(collect_daily(client, db, shop_id=os.environ.get("SHOP_ID", "275374")))
