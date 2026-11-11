#!/usr/bin/env bash
set -euo pipefail

ROOT="/opt/agora"
TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  if [[ ! -f "${ROOT}/previous" ]]; then
    echo "no previous release recorded" >&2
    exit 2
  fi
  TARGET="$(cat "${ROOT}/previous")"
fi

if [[ ! -d "$TARGET" ]]; then
  echo "previous release directory does not exist: $TARGET" >&2
  exit 3
fi

CONFIG="${TARGET}/config.env"
if [[ ! -f "$CONFIG" ]]; then
  echo "previous release is missing config.env" >&2
  exit 4
fi

ln -sfn "$TARGET" "${ROOT}/current"
python3 "${ROOT}/current/scripts/render_secrets.py"

set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

if [[ -z "${API_HOST:-}" && -f "${ROOT}/api-host" ]]; then
  API_HOST="$(cat "${ROOT}/api-host")"
  export API_HOST
  sed -i '/^API_HOST=/d' "$CONFIG"
  printf '\nAPI_HOST=%s\n' "$API_HOST" >> "$CONFIG"
fi
if [[ -z "${API_HOST:-}" ]]; then
  echo "API_HOST is not configured" >&2
  exit 6
fi

docker pull "${SANDBOX_RUNTIME_IMAGE:?SANDBOX_RUNTIME_IMAGE is required}"
docker compose --env-file "$CONFIG" -f "${ROOT}/current/docker-compose.yml" pull
docker compose --env-file "$CONFIG" -f "${ROOT}/current/docker-compose.yml" up -d --remove-orphans

for _ in $(seq 1 60); do
  if curl -fsS "https://${API_HOST}/ready" >/dev/null 2>&1; then
    echo "rollback ready"
    exit 0
  fi
  sleep 5
done

echo "rollback did not become ready" >&2
exit 5
