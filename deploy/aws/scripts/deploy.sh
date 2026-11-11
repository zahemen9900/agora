#!/usr/bin/env bash
set -euo pipefail

SHA="${1:?release SHA is required}"
if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "invalid release SHA" >&2
  exit 2
fi

ROOT="/opt/agora"
BUCKET="${DATA_BUCKET:-agora-866160682016-data}"
RELEASE_DIR="${ROOT}/releases/${SHA}"
BUNDLE="/tmp/agora-${SHA}.tar.gz"
CHECKSUM_FILE="/tmp/agora-${SHA}.sha256"
LOCK="/var/lock/agora-deploy.lock"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another deploy is running" >&2
  exit 3
fi

if [[ ! -d "$RELEASE_DIR" ]]; then
  echo "fetching release ${SHA}"
  aws s3 cp "s3://${BUCKET}/_deploy/releases/${SHA}/bundle.tar.gz" "$BUNDLE" --only-show-errors
  aws s3 cp "s3://${BUCKET}/_deploy/releases/${SHA}/bundle.tar.gz.sha256" "$CHECKSUM_FILE" --only-show-errors
  expected="$(tr -d '[:space:]' < "$CHECKSUM_FILE")"
  actual="$(sha256sum "$BUNDLE" | awk '{print $1}')"
  if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    echo "release checksum mismatch" >&2
    rm -f "$BUNDLE" "$CHECKSUM_FILE"
    exit 4
  fi
  mkdir -p "$RELEASE_DIR"
  tar -xzf "$BUNDLE" -C "$RELEASE_DIR"
  chmod 0755 "$RELEASE_DIR/scripts/"*.sh
fi

CONFIG="${RELEASE_DIR}/config.env"
if [[ ! -f "$CONFIG" ]]; then
  echo "release is missing config.env" >&2
  exit 5
fi

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
  exit 7
fi

PREVIOUS="$(readlink -f "${ROOT}/current" 2>/dev/null || true)"
if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
  printf '%s\n' "$PREVIOUS" > "${ROOT}/previous"
fi
ln -sfn "$RELEASE_DIR" "${ROOT}/current"

python3 "${ROOT}/current/scripts/render_secrets.py"

docker pull "${SANDBOX_RUNTIME_IMAGE:?SANDBOX_RUNTIME_IMAGE is required}"
docker compose --env-file "${CONFIG}" -f "${ROOT}/current/docker-compose.yml" pull
docker compose --env-file "${CONFIG}" -f "${ROOT}/current/docker-compose.yml" up -d --remove-orphans

ready=0
for _ in $(seq 1 60); do
  if curl -fsS "https://${API_HOST}/ready" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 5
done

if [[ "$ready" != "1" ]]; then
  echo "release did not become ready; rolling back" >&2
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    ln -sfn "$PREVIOUS" "${ROOT}/current"
    python3 "${ROOT}/current/scripts/render_secrets.py" || true
    docker compose --env-file "${PREVIOUS}/config.env" -f "${PREVIOUS}/docker-compose.yml" up -d --remove-orphans || true
  fi
  exit 6
fi

printf '%s\n' "$SHA" > "${ROOT}/current-sha"
echo "release ${SHA} is ready"
