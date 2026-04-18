FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY api/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir -r requirements.lock

COPY pyproject.toml README.md ./
COPY agora ./agora
COPY api ./api
COPY benchmarks ./benchmarks

RUN useradd --create-home --shell /usr/sbin/nologin agora \
    && chown -R agora:agora /app
USER agora

EXPOSE 8080
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8080"]
