#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROJECT_ID_DEFAULT="${AGORA_OPENROUTER_SECRET_PROJECT:-${GOOGLE_CLOUD_PROJECT:-agora-ai-9900}}"
SECRET_NAME_DEFAULT="${AGORA_OPENROUTER_SECRET_NAME:-agora-openrouter-api-key}"
SECRET_VERSION_DEFAULT="${AGORA_OPENROUTER_SECRET_VERSION:-latest}"
PYTEST_MARK_DEFAULT="${AGORA_PAID_PYTEST_MARK:-paid_integration}"

PROJECT_ID="$PROJECT_ID_DEFAULT"
SECRET_NAME="$SECRET_NAME_DEFAULT"
SECRET_VERSION="$SECRET_VERSION_DEFAULT"
PYTHON_BIN="${PYTHON_BIN:-}"
PYTEST_MARK="$PYTEST_MARK_DEFAULT"

print_usage() {
  cat <<'EOF'
Usage: ./scripts/run_paid_provider_tests.sh [options] [-- pytest-args]

Options:
  --project <gcp-project-id>      Secret Manager project id
  --secret <secret-name>          Secret name (default: agora-openrouter-api-key)
  --version <secret-version>      Secret version (default: latest)
  --python <python-executable>    Python executable path
  --mark <pytest-mark-expression> Pytest mark expression (default: paid_integration)
  --help                          Show this help

Behavior:
  - Pulls OpenRouter key from Google Secret Manager.
  - Unsets OPENROUTER_API_KEY and sets AGORA_OPENROUTER_API_KEY for the test process.
  - Sets RUN_PAID_PROVIDER_TESTS=1.
  - Runs: python -m pytest -q -m <mark> [pytest-args]
EOF
}

PYTEST_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="$2"
      shift 2
      ;;
    --secret)
      SECRET_NAME="$2"
      shift 2
      ;;
    --version)
      SECRET_VERSION="$2"
      shift 2
      ;;
    --python)
      PYTHON_BIN="$2"
      shift 2
      ;;
    --mark)
      PYTEST_MARK="$2"
      shift 2
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    --)
      shift
      PYTEST_ARGS=("$@")
      break
      ;;
    *)
      PYTEST_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$PROJECT_ID" ]]; then
  echo "[error] Missing Secret Manager project id. Set --project or GOOGLE_CLOUD_PROJECT." >&2
  exit 1
fi

if [[ -z "$PYTHON_BIN" ]]; then
  if [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
    PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
  else
    PYTHON_BIN="python3"
  fi
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "[error] gcloud is not installed or not on PATH." >&2
  exit 1
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "[error] Python executable not found: $PYTHON_BIN" >&2
  exit 1
fi

echo "[info] Fetching OpenRouter key from Secret Manager ($PROJECT_ID/$SECRET_NAME@$SECRET_VERSION)"
OPENROUTER_SECRET="$(gcloud secrets versions access "$SECRET_VERSION" --secret "$SECRET_NAME" --project "$PROJECT_ID")"
if [[ -z "$OPENROUTER_SECRET" ]]; then
  echo "[error] OpenRouter secret fetch returned an empty value." >&2
  exit 1
fi

echo "[info] Running paid-provider pytest marker: $PYTEST_MARK"
(
  cd "$ROOT_DIR"
  env -u OPENROUTER_API_KEY \
    AGORA_OPENROUTER_API_KEY="$OPENROUTER_SECRET" \
    RUN_PAID_PROVIDER_TESTS=1 \
    "$PYTHON_BIN" -m pytest -q -m "$PYTEST_MARK" "${PYTEST_ARGS[@]}"
)

unset OPENROUTER_SECRET
echo "[info] Paid-provider test run completed."
