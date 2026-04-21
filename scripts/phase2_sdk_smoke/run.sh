#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$(mktemp -d -t agora-phase2-sdk-smoke-XXXXXX)"
BASE_PYTHON="${AGORA_PHASE2_SDK_SMOKE_BASE_PYTHON:-}"

if [[ -z "$BASE_PYTHON" ]]; then
  if [[ -x "$ROOT_DIR/agora-env/bin/python" ]]; then
    BASE_PYTHON="$ROOT_DIR/agora-env/bin/python"
  else
    BASE_PYTHON="$(command -v python3)"
  fi
fi

if [[ -z "$BASE_PYTHON" || ! -x "$BASE_PYTHON" ]]; then
  echo "[error] Could not find a usable Python executable for bootstrapping the smoke venv." >&2
  exit 1
fi

cleanup() {
  rm -rf "$VENV_DIR"
}
trap cleanup EXIT

echo "[install] creating fresh virtualenv: $VENV_DIR"
"$BASE_PYTHON" -m venv "$VENV_DIR"

echo "[install] upgrading packaging tools"
"$VENV_DIR/bin/python" -m pip install --upgrade pip setuptools wheel

echo "[install] installing agora-arbitrator-sdk from $ROOT_DIR/sdk"
"$VENV_DIR/bin/python" -m pip install "$ROOT_DIR/sdk"

if [[ -f "$ROOT_DIR/.env" ]]; then
  echo "[config] loading $ROOT_DIR/.env"
  # shellcheck disable=SC1090
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

if [[ -z "${AGORA_API_KEY:-}" ]]; then
  echo "[error] AGORA_API_KEY is required in $ROOT_DIR/.env or the environment." >&2
  exit 1
fi

PROMPT="${AGORA_PHASE2_SMOKE_PROMPT:-Should we use a monolith or microservices for a small internal tool?}"
AGENT_COUNT="${AGORA_PHASE2_SMOKE_AGENT_COUNT:-3}"
MECHANISM="${AGORA_PHASE2_SMOKE_MECHANISM:-vote}"

echo "[run] executing hosted SDK smoke test"
"$VENV_DIR/bin/python" "$SCRIPT_DIR/run_phase2_sdk_smoke.py" \
  --auth-token "$AGORA_API_KEY" \
  --prompt "$PROMPT" \
  --mechanism "$MECHANISM" \
  --agent-count "$AGENT_COUNT"
