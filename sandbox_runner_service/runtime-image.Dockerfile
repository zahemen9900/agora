FROM python:3.11-slim

WORKDIR /workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY sandbox_runner_service/runtime-requirements.txt /tmp/runtime-requirements.txt
RUN pip install --no-cache-dir -r /tmp/runtime-requirements.txt \
    && rm -f /tmp/runtime-requirements.txt

ENV PYTHONUNBUFFERED=1

CMD ["python", "--version"]
