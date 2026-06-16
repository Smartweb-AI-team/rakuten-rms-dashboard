# SmartProfit 광고 데이터 파이프라인 (프로토타입)

라쿠텐 RMS 광고 데이터를 **일별로 자동 수집 → DB 적재 → AI챗 질의**까지 하는 최소 동작 프로토타입.
RMS의 AI챗처럼 "2026년 6월 1일 RPP 데이터" / "어제 클릭이 줄었는데 원인은?" 같은 질문에
DB에서 데이터를 뽑아 표·요약으로 답한다.

## 구성

| 파일 | 역할 |
|---|---|
| `rakuten_client.py` | ad.rms 내부 REST API 클라이언트 (검증된 RPP/CPA/TDA/구매이력 엔드포인트) |
| `db.py` | SQLite 스키마 + upsert + AI챗용 안전 조회 |
| `collector.py` | 일별 자동 수집 (전일까지, 최근 14일 재수집) |
| `ai_chat.py` | 자연어 → 의도추출(Claude) → 안전조회 → 표·요약 답변(Claude) |
| `main.py` | CLI (`collect` / `ask`) |

## 동작 원리 요약

- **인증**: R-Login 세션 쿠키 하나로 ad.rms 전 상품 공통. GET·RPP POST는 `XSRF-TOKEN`→`X-XSRF-TOKEN` 헤더로 통과.
- **일별**: RPP 전체/캠페인은 `periodType=2`로 직접 일별. **상품별/키워드별은 일별이 막혀** 있어
  `periodType=0`(전체기간)으로 **하루씩 끊어 루프**(`fetch_rpp_item_daily`)해 일별화.
- **변동 보정**: 과거 데이터가 사후 변동하므로 매일 최근 14일을 재수집(upsert 덮어쓰기).
- **AI챗 안전성**: LLM에 자유 SQL을 주지 않고, 의도(JSON)만 받아 코드가 파라미터화 쿼리를 만든다.

## 사전 준비

### 1) 로그인 쿠키 (Playwright)
R-Login은 OAuth2+2FA라 HTTP 로그인 불가 → Playwright로 로그인 후 쿠키를 `storage_state.json`으로 저장.
(기존 SmartProfit 로그인 인프라를 그대로 재사용 가능. 핵심은 `XSRF-TOKEN` 포함 라쿠텐 쿠키 확보.)

```python
# 예시: 로그인 후
context.storage_state(path="storage_state.json")
```

### 2) 환경변수
```bash
export ANTHROPIC_API_KEY=sk-ant-...
export RAKUTEN_STORAGE_STATE=storage_state.json
export SHOP_ID=275374
```

### 3) 설치
```bash
pip install -r requirements.txt
```

## 사용

```bash
# 일별 수집 (cron: 30 0 * * *)
python main.py collect

# AI챗 질의
python main.py ask "2026년 6월 1일 RPP 데이터 보여줘"
python main.py ask "이번 주 RPP 클릭이 줄었는데 원인이 뭐야?"
python main.py ask "어제 ROAS 가장 낮은 캠페인 5개"
```

## 잔여 작업 (프로덕션 전)

- 쿠폰어드밴스·RPP-EXP의 **인앱 CSRF 토큰** 확정 후 클라이언트에 추가
- CPA/TDA 응답의 **일본어 필드 ↔ DB 컬럼 매핑** 확정(`normalize_*` 추가)
- 세션 쿠키 **TTL 측정 + 재로그인 트리거**
- SQLite → **PostgreSQL** 전환(스키마 동일), 멀티숍 큐잉
- 상품별/키워드별 "전체기간+날짜루프" 일별화 **실측 검증**

> ⚠️ 내부 API는 공식 개방 대상이 아님(ToS 회색지대). 출시 전 약관 검토 권장.
