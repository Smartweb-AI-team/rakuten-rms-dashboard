# SmartProfit 로컬 대시보드 — 실행 가이드

라쿠텐 RMS 광고 데이터를 **일별로 딸깍 수집 → DB 저장 → 표·차트·인사이트·AI챗**으로
보여주는 로컬 웹 툴. 백엔드(Python 표준 라이브러리) + HTML 프론트엔드.

```
files/
├─ server.py          ← 실행 진입점 (로컬 웹서버)
├─ rakuten_client.py  ← 라쿠텐 내부 API 클라이언트
├─ collector.py       ← 일별/기간 수집 로직
├─ db.py              ← SQLite 스키마 + 조회/집계
├─ ai_chat.py         ← AI 챗 (Claude, 선택)
├─ config.json        ← 설정 (샵ID, DB경로, 포트…)
├─ static/            ← 대시보드 UI (index.html, app.js, styles.css)
└─ extension/         ← 라쿠텐 쿠키 브리지 (Chrome 확장)
```

---

## 1. 실행 (가장 빠른 시작 — 샘플 모드)

이 PC는 `py` 런처로 Python 3.14 가 동작합니다.

```powershell
cd C:\Users\paku\Downloads\files
py server.py
```

브라우저에서 **http://127.0.0.1:8765** 접속 →
**[일별 수집]** 탭에서 **“샘플 모드” 체크 → 날짜 선택 → 📥 수집** 하면
가짜 데이터가 들어가고, **대시보드/데이터 표/차트**를 바로 둘러볼 수 있습니다.
(AI챗 제외 모든 기능이 키·로그인 없이 동작)

---

## 2. 실제 데이터 수집 준비

### 2-1. 패키지 설치 (실수집 시 1회)
```powershell
py -m pip install requests
py -m pip install anthropic   # AI챗 쓸 때만
```

### 2-2. 라쿠텐 세션 연결 — 3가지 방법 중 하나

**(A) 브라우저 확장 (권장)**
1. Chrome → `chrome://extensions` → 우측 상단 **개발자 모드** ON
2. **압축해제된 확장 프로그램을 로드** → `files/extension` 폴더 선택
3. 라쿠텐 RMS의 **RPP 광고 페이지(`ad.rms.rakuten.co.jp/rpp/…`)에 로그인된 탭**을 연 상태에서
   확장 아이콘 클릭 → **🍪 쿠키 전송**
4. 팝업에 `XSRF 경로 [/rpp]` 가 뜨고, 대시보드 세션 배지가 **“세션 연결됨”** 이면 완료
   > 기존 본인 확장이 있다면 `background.js`의 `collectCookies()`(경로별 `getAll({url})`) / `fetch(SERVER…)` 로직만 옮겨 넣어도 됩니다.

> **왜 이렇게 하나 (중요한 발견):**
> - 라쿠텐 광고는 상품마다 **경로 한정 XSRF-TOKEN**(`Path=/rpp`, `/cpa`, `/tda`)을 따로 발급합니다.
>   RPP 데이터 수집(POST)은 `/rpp` 토큰이 있어야 CSRF 검증을 통과하므로, **RPP 페이지를 한 번 연 뒤**
>   쿠키를 보내야 합니다. (CPA/TDA 조회는 GET이라 해당 경로 토큰이 없어도 동작)
> - 쿠키를 도메인 전체로 긁으면(`getAll({domain})`) Cookie 헤더가 10KB를 넘겨 **라쿠텐 WAF가 400으로 차단**합니다.
>   그래서 확장은 `getAll({url})`로 **그 URL에 실제 적용되는 쿠키만**(약 35개) 수집합니다.
> - 보낸 세션은 `session_cookies.json`에 저장되어 **서버를 재시작해도 유지**됩니다(쿠키 만료 전까지 재전송 불필요).
>   세션이 만료되면 RPP 페이지에서 다시 한 번 “쿠키 전송”만 누르면 됩니다.

**(B) 수동 붙여넣기**
RMS 탭의 DevTools → Application → Cookies 에서 쿠키들을
`XSRF-TOKEN=...; R-Login=...` 형태로 복사 → [일별 수집] 하단 입력칸에 붙여넣고 **쿠키 적용**.

**(C) storage_state.json**
Playwright 로그인 결과 파일이 있으면 설정에서 경로 지정 (`config.json`의 `storage_state_path`).

### 2-3. 수집
[일별 수집] 탭 → **샘플 모드 해제** → 날짜(또는 기간) 선택 → **📥 수집**.
RPP(전체·캠페인·상품)는 정규화 저장, CPA·TDA는 원본 JSON으로 보존됩니다.

---

## 3. Google Drive에 DB 저장

[⚙️ 설정] → **DB 경로**에 Google Drive 데스크톱 동기화 폴더의 로컬 경로를 입력:
```
C:/Users/paku/My Drive/SmartProfit/smartprofit.db
```
저장하면 이후 모든 수집이 그 위치에 기록되고 Drive가 자동 동기화합니다.
일회성 백업은 설정의 **“DB 사본 저장”**(타임스탬프 사본) 사용.

> 라이브 SQLite를 동기화 폴더에 두면 여러 PC가 동시에 쓸 때 충돌 위험이 있으니,
> 수집은 한 PC에서만 하는 것을 권장합니다.

---

## 4. AI 챗 (선택)
환경변수 설정 후 서버 재시작:
```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."
py server.py
```
없어도 **[대시보드] 탭의 인사이트(규칙기반 요약)** 는 정상 동작합니다.

---

## 기능 요약
| 탭 | 기능 |
|---|---|
| 일별 수집 | 날짜 딸깍 수집(하루/기간) + 기간 백필(월 청크·진행률), 수집 현황, 세션 연결 |
| 대시보드 | KPI 카드(전기간 대비 증감), 추이 차트, 규칙기반 인사이트, 캠페인 변동 |
| 데이터 표 | 필터·정렬·CSV 내보내기 |
| AI 챗 | 자연어 질의 → 표·요약·원인분석 (Claude) |

## 라쿠텐 조회 한도 (실측)
수집 로직이 자동으로 맞춰 처리하지만 참고용:
| 리포트 | 단위 | 최대 범위 | 보관 |
|---|---|---|---|
| 전체·캠페인 | 일별(period=2) | 3개월/요청 | 약 4년(롤링) |
| 상품별·키워드별 | 全期間(period=0) 하루씩 | 1개월 | **약 2년** |
| CPA·TDA | 일별(period=2) | 3개월/요청 | (과거 데이터 존재) |

- 상품별·키워드별은 라쿠텐이 일별 분리를 막아둬, 하루(d~d)씩 全期間으로 받아 날짜를 붙입니다.
- 보관 한도는 롤링이라 시간이 지나면 과거가 사라집니다 → **지금 백필해 두면 영구 보존**.

> ⚠️ 내부 API는 공식 개방 대상이 아닙니다(ToS 회색지대). 출시 전 약관 검토 권장.
