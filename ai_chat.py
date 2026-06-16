"""
ai_chat.py
라쿠텐 RMS의 AI챗처럼 동작하는 질의 레이어.

흐름:
  자연어 질문
    → (1) Claude로 의도 추출(JSON: 기간/광고상품/집계단위/지표/분석유형)
    → (2) 코드가 '파라미터화된' 안전 조회 생성 (LLM이 자유 SQL을 쓰지 않음)
    → (3) DB 조회
    → (4) Claude가 결과 행을 표 + 자연어 요약/원인분석으로 렌더

모델: claude-sonnet-4-6 (빠르고 똑똑, 이 용도에 적합)
"""
from __future__ import annotations
import json
from datetime import date, timedelta

from db import DB

MODEL = "claude-sonnet-4-6"

_client = None


def _get_client():
    """anthropic 클라이언트 지연 초기화. 키/패키지 없으면 명확한 에러를 던진다
    (서버 import 시점에 죽지 않도록)."""
    global _client
    if _client is None:
        import os
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("ANTHROPIC_API_KEY 가 설정되지 않았습니다. "
                               "AI챗을 쓰려면 환경변수를 설정하세요(규칙기반 요약은 키 없이 동작).")
        import anthropic
        _client = anthropic.Anthropic()
    return _client

PRODUCT_MAP = {"RPP": "RPP", "검색연동": "RPP", "CPA": "CPA",
               "쿠폰": "CPNADV", "쿠폰어드밴스": "CPNADV", "TDA": "TDA"}
SEL_MAP = {"전체": 1, "캠페인": 2, "상품": 3, "상품별": 3, "키워드": 4, "키워드별": 4}

INTENT_SYSTEM = f"""너는 라쿠텐 광고 데이터 질의의 의도 추출기다.
오늘 날짜는 {date.today().isoformat()}. 사용자 질문을 아래 JSON으로만 출력한다.
설명/마크다운/코드펜스 없이 순수 JSON 객체만 출력하라.

{{
  "date_from": "YYYY-MM-DD",
  "date_to": "YYYY-MM-DD",
  "ad_product": "RPP|CPA|CPNADV|TDA|null",   // 불명확하면 null(전체)
  "selection_type": 1,                         // 1전체 2캠페인 3상품 4키워드
  "metric": "ad_cost|gms|clicks|roas|cv|cvr",  // 주 관심 지표
  "analysis_type": "lookup|compare|cause"      // 단순조회/비교/원인분석
}}

규칙:
- "어제"는 오늘-1일, "이번 주"는 최근 7일, "지난달"은 직전 월 전체로 해석.
- "액세스/클릭이 줄었다/원인" → analysis_type="cause", metric="clicks".
- 기간이 하루면 date_from=date_to."""

ANSWER_SYSTEM = """너는 라쿠텐 광고 데이터 분석 어시스턴트다.
주어진 조회 결과(JSON 행)와 질문을 바탕으로:
1) 핵심 답을 1~2문장으로 먼저 말하고
2) 마크다운 표로 데이터를 정리하고
3) analysis_type이 cause/compare면 변화가 큰 항목을 짚어 원인 후보를 제시한다.
숫자는 주어진 값 그대로 쓰고 추정은 명시한다.
데이터가 비어있으면 "해당 기간 데이터 없음"이라고 답한다.
끝에 한 줄로 '※ 집계는 전일까지 확정, 과거분은 사후 변동 가능' 주의를 붙인다."""


def _llm_json(question: str) -> dict:
    msg = _get_client().messages.create(
        model=MODEL, max_tokens=400, system=INTENT_SYSTEM,
        messages=[{"role": "user", "content": question}])
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    text = text.replace("```json", "").replace("```", "").strip()
    return json.loads(text)


def _resolve_intent(question: str) -> dict:
    intent = _llm_json(question)
    # 안전 기본값 보정
    intent.setdefault("selection_type", 1)
    intent.setdefault("analysis_type", "lookup")
    if not intent.get("date_to"):
        intent["date_to"] = (date.today() - timedelta(days=1)).isoformat()
    if not intent.get("date_from"):
        intent["date_from"] = intent["date_to"]
    return intent


def ask(question: str, shop_id: str = "275374", db: DB | None = None) -> str:
    db = db or DB()
    intent = _resolve_intent(question)

    # 원인분석이면 비교를 위해 직전 동일기간도 함께 조회
    rows = db.query_performance(
        shop_id, intent["date_from"], intent["date_to"],
        ad_product=intent.get("ad_product"),
        selection_type=intent.get("selection_type", 1),
        order_by=intent.get("metric", "report_date"),
        desc=(intent.get("analysis_type") in ("compare", "cause")))

    context = {"question": question, "intent": intent, "rows": rows}
    if intent.get("analysis_type") == "cause":
        days = (date.fromisoformat(intent["date_to"]) - date.fromisoformat(intent["date_from"])).days + 1
        prev_to = (date.fromisoformat(intent["date_from"]) - timedelta(days=1)).isoformat()
        prev_from = (date.fromisoformat(prev_to) - timedelta(days=days - 1)).isoformat()
        context["previous_period_rows"] = db.query_performance(
            shop_id, prev_from, prev_to, ad_product=intent.get("ad_product"),
            selection_type=intent.get("selection_type", 1))

    msg = _get_client().messages.create(
        model=MODEL, max_tokens=1500, system=ANSWER_SYSTEM,
        messages=[{"role": "user",
                   "content": json.dumps(context, ensure_ascii=False)}])
    return "".join(b.text for b in msg.content if b.type == "text")


if __name__ == "__main__":
    import sys
    q = " ".join(sys.argv[1:]) or "2026년 6월 1일 RPP 데이터 보여줘"
    print(ask(q))
