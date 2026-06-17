# Cloud Run 워커용 (백필/장기 수집 전담).
# Vercel 은 대시보드 + 짧은 API. 무거운 작업은 이쪽으로 forward.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    IS_WORKER=1

WORKDIR /app

# OS deps (psycopg2 빌드용)
RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cloud Run 은 $PORT 사용. 1 워커, async I/O 충분.
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1
