FROM docker:28-cli AS docker_cli

FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=docker_cli /usr/local/bin/docker /usr/local/bin/docker

COPY sandbox_runner_service/requirements.txt ./requirements.txt
COPY sandbox_runner_service/runtime-requirements.txt ./runtime-requirements.txt
RUN pip install --no-cache-dir -r requirements.txt -r runtime-requirements.txt

COPY sandbox_runner_service ./sandbox_runner_service

ENV PYTHONUNBUFFERED=1
EXPOSE 8080

CMD ["uvicorn", "sandbox_runner_service.app:app", "--host", "0.0.0.0", "--port", "8080"]
