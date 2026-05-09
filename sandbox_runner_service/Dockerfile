FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

COPY sandbox_runner_service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY sandbox_runner_service ./sandbox_runner_service

ENV PYTHONUNBUFFERED=1
EXPOSE 8080

CMD ["uvicorn", "sandbox_runner_service.app:app", "--host", "0.0.0.0", "--port", "8080"]
