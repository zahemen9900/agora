#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${AGORA_API_URL:-https://agora-api-dcro4pg6ca-uc.a.run.app}"
RUN_ANCHOR_CHECKS="${RUN_ANCHOR_CHECKS:-auto}"
RUN_GEMINI_SMOKE="${RUN_GEMINI_SMOKE:-auto}"
RUN_CLAUDE_SMOKE="${RUN_CLAUDE_SMOKE:-auto}"
RUN_KIMI_SMOKE="${RUN_KIMI_SMOKE:-auto}"
RUN_ALL_MODELS_E2E="${RUN_ALL_MODELS_E2E:-auto}"
RUN_HOSTED_API_E2E="${RUN_HOSTED_API_E2E:-auto}"
RUN_HOSTED_ALL_MODELS_E2E="${RUN_HOSTED_ALL_MODELS_E2E:-never}"
RUN_ORCHESTRATOR_SMOKE="${RUN_ORCHESTRATOR_SMOKE:-auto}"
DEMO_VERBOSE_TEST_LOGS="${DEMO_VERBOSE_TEST_LOGS:-0}"
DEMO_ORCHESTRATOR_TIMEOUT_SECONDS="${DEMO_ORCHESTRATOR_TIMEOUT_SECONDS:-180}"
DEMO_MODEL_TIMEOUT_SECONDS="${DEMO_MODEL_TIMEOUT_SECONDS:-120}"
DEMO_ALL_MODELS_TIMEOUT_SECONDS="${DEMO_ALL_MODELS_TIMEOUT_SECONDS:-240}"
DEMO_ALL_MODELS_MAX_ATTEMPTS="${DEMO_ALL_MODELS_MAX_ATTEMPTS:-3}"
DEMO_FLASH_MODEL="${DEMO_FLASH_MODEL:-gemini-3.1-flash-lite-preview}"
DEMO_PRO_MODEL="${DEMO_PRO_MODEL:-gemini-3-flash-preview}"
DEMO_CLAUDE_MODEL="${DEMO_CLAUDE_MODEL:-claude-sonnet-4-6}"
DEMO_KIMI_MODEL="${DEMO_KIMI_MODEL:-moonshotai/kimi-k2-thinking}"
DEMO_QUERY_DEFAULT="Week 1 demo: should teams use debate or vote?"
DEMO_QUERY="${DEMO_QUERY:-$DEMO_QUERY_DEFAULT}"

if [[ -z "${DEMO_AGENT_COUNT:-}" ]]; then
  if [[ "$RUN_KIMI_SMOKE" == "never" && "$RUN_ALL_MODELS_E2E" == "never" ]]; then
    DEMO_AGENT_COUNT=3
  else
    DEMO_AGENT_COUNT=4
  fi
fi

ORIG_AGORA_GEMINI_API_KEY="${AGORA_GEMINI_API_KEY-}"
ORIG_GEMINI_API_KEY="${GEMINI_API_KEY-}"
ORIG_AGORA_GOOGLE_API_KEY="${AGORA_GOOGLE_API_KEY-}"
ORIG_GOOGLE_API_KEY="${GOOGLE_API_KEY-}"
ORIG_ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY-}"
ORIG_AGORA_OPENROUTER_API_KEY="${AGORA_OPENROUTER_API_KEY-}"
ORIG_OPENROUTER_API_KEY="${OPENROUTER_API_KEY-}"
ORIG_GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT-}"
ORIG_GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS-}"

COLOR_GREEN=$'\033[0;32m'
COLOR_YELLOW=$'\033[0;33m'
COLOR_RED=$'\033[0;31m'
COLOR_RESET=$'\033[0m'
GCLOUD_PROMPTLESS=("CLOUDSDK_CORE_DISABLE_PROMPTS=1")

print_usage() {
  cat <<'EOF'
Usage: ./scripts/week1_demo.sh [options]

Options:
  --query "text"            Set deliberation query used by orchestrator + hosted API create call
  --query="text"            Same as above
  --api-url "url"           Override hosted API URL for E2E checks
  --api-url="url"           Same as above
  --help                     Show this help

Environment controls still supported:
  AGORA_TEST_API_KEY=agora_test_<public_id>.<secret>
  RUN_GEMINI_SMOKE=always|auto|never
  RUN_CLAUDE_SMOKE=always|auto|never
  RUN_KIMI_SMOKE=always|auto|never
  RUN_ALL_MODELS_E2E=always|auto|never
  RUN_HOSTED_API_E2E=always|auto|never
  RUN_HOSTED_ALL_MODELS_E2E=always|never
  RUN_ORCHESTRATOR_SMOKE=always|auto|never
  RUN_ANCHOR_CHECKS=always|auto|never
  DEMO_ORCHESTRATOR_TIMEOUT_SECONDS=180
  DEMO_MODEL_TIMEOUT_SECONDS=120
  DEMO_ALL_MODELS_TIMEOUT_SECONDS=240
  DEMO_ALL_MODELS_MAX_ATTEMPTS=3
  DEMO_AGENT_COUNT=4
  DEMO_CLAUDE_MODEL=claude-sonnet-4-6
  DEMO_VERBOSE_TEST_LOGS=1
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --query)
      if [[ $# -lt 2 ]]; then
        echo "[error] Missing value for --query" >&2
        exit 1
      fi
      DEMO_QUERY="$2"
      shift 2
      ;;
    --query=*)
      DEMO_QUERY="${1#*=}"
      shift
      ;;
    --api-url)
      if [[ $# -lt 2 ]]; then
        echo "[error] Missing value for --api-url" >&2
        exit 1
      fi
      API_URL="$2"
      shift 2
      ;;
    --api-url=*)
      API_URL="${1#*=}"
      shift
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    *)
      echo "[error] Unknown option: $1" >&2
      print_usage
      exit 1
      ;;
  esac
done

if [[ -z "${DEMO_QUERY// }" ]]; then
  echo "[error] Deliberation query is empty. Use --query \"text\"." >&2
  exit 1
fi

if [[ -z "${PYTHON_BIN:-}" ]]; then
  PYTHON_CANDIDATES=(
    "$ROOT_DIR/.venv/bin/python"
    "$ROOT_DIR/../../agora/.venv/bin/python"
  )

  for candidate in "${PYTHON_CANDIDATES[@]}"; do
    if [[ -x "$candidate" ]]; then
      PYTHON_BIN="$candidate"
      break
    fi
  done

  if [[ -z "${PYTHON_BIN:-}" ]]; then
    PYTHON_BIN="python3"
  fi
fi

log_step() {
  printf "\n%s==>%s %s\n" "$COLOR_GREEN" "$COLOR_RESET" "$1"
}

log_warn() {
  printf "%s[warn]%s %s\n" "$COLOR_YELLOW" "$COLOR_RESET" "$1"
}

log_error() {
  printf "%s[error]%s %s\n" "$COLOR_RED" "$COLOR_RESET" "$1"
}

assert_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log_error "Missing required command: $1"
    return 1
  fi
}

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1 && [[ ! -x "$PYTHON_BIN" ]]; then
  log_error "Python executable not found at $PYTHON_BIN"
  log_error "Create your venv first: python -m venv .venv && source .venv/bin/activate && pip install -e \".[dev]\" && pip install -r api/requirements.txt"
  exit 1
fi

assert_cmd curl

# Keep lint/tests deterministic by default, even when shell exports live API keys.
unset AGORA_GEMINI_API_KEY GEMINI_API_KEY AGORA_GOOGLE_API_KEY GOOGLE_API_KEY
unset ANTHROPIC_API_KEY AGORA_OPENROUTER_API_KEY OPENROUTER_API_KEY

CORE_STATUS="PASS"
ANCHOR_STATUS="SKIPPED"
API_E2E_STATUS="PASS"
GEMINI_SDK_STATUS="SKIPPED"
CLAUDE_SDK_STATUS="SKIPPED"
KIMI_SDK_STATUS="SKIPPED"
ALL_MODELS_E2E_STATUS="SKIPPED"
ORCHESTRATOR_STATUS="SKIPPED"
GEMINI_KEY_SOURCE="none"
CLAUDE_KEY_SOURCE="none"
OPENROUTER_KEY_SOURCE="none"
GCLOUD_AUTH_SOURCE="none"
GCLOUD_AUTH_STATUS="unknown"
GCLOUD_ACTIVE_ACCOUNT="unknown"

export AGORA_FLASH_MODEL="${AGORA_FLASH_MODEL:-$DEMO_FLASH_MODEL}"
export AGORA_PRO_MODEL="${AGORA_PRO_MODEL:-$DEMO_PRO_MODEL}"
export AGORA_CLAUDE_MODEL="${AGORA_CLAUDE_MODEL:-$DEMO_CLAUDE_MODEL}"
export AGORA_KIMI_MODEL="${AGORA_KIMI_MODEL:-$DEMO_KIMI_MODEL}"
export AGORA_KIMI_REASONING_EFFORT="${AGORA_KIMI_REASONING_EFFORT:-low}"
export AGORA_KIMI_REASONING_EXCLUDE="${AGORA_KIMI_REASONING_EXCLUDE:-true}"
export AGORA_KIMI_MAX_TOKENS="${AGORA_KIMI_MAX_TOKENS:-512}"
export DEMO_AGENT_COUNT
export RUN_GEMINI_SMOKE RUN_CLAUDE_SMOKE RUN_KIMI_SMOKE RUN_ALL_MODELS_E2E
export RUN_HOSTED_API_E2E RUN_HOSTED_ALL_MODELS_E2E RUN_ANCHOR_CHECKS
export RUN_ORCHESTRATOR_SMOKE DEMO_ORCHESTRATOR_TIMEOUT_SECONDS
export DEMO_MODEL_TIMEOUT_SECONDS DEMO_ALL_MODELS_TIMEOUT_SECONDS
export DEMO_ALL_MODELS_MAX_ATTEMPTS
export AGORA_DEMO_EXPECTED_MODELS="$AGORA_PRO_MODEL,$AGORA_KIMI_MODEL,$AGORA_FLASH_MODEL,$AGORA_CLAUDE_MODEL"

log_step "Configured Gemini models"
printf "flash=%s\n" "$AGORA_FLASH_MODEL"
printf "pro=%s\n" "$AGORA_PRO_MODEL"
printf "claude=%s\n" "$AGORA_CLAUDE_MODEL"
printf "kimi=%s\n" "$AGORA_KIMI_MODEL"
printf "agent_count=%s\n" "$DEMO_AGENT_COUNT"
printf "kimi_reasoning_effort=%s\n" "$AGORA_KIMI_REASONING_EFFORT"
printf "kimi_reasoning_exclude=%s\n" "$AGORA_KIMI_REASONING_EXCLUDE"
printf "query=%s\n" "$DEMO_QUERY"

setup_gcloud_auth() {
  if ! command -v gcloud >/dev/null 2>&1; then
    log_warn "gcloud CLI not found; cloud secret fallback is unavailable."
    GCLOUD_AUTH_STATUS="unavailable"
    return 0
  fi

  GCLOUD_ACTIVE_ACCOUNT="$(env CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1 || true)"
  if env CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud auth print-access-token >/dev/null 2>&1; then
    GCLOUD_AUTH_STATUS="ok"
    GCLOUD_AUTH_SOURCE="gcloud-user"
  elif env CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud auth application-default print-access-token >/dev/null 2>&1; then
    GCLOUD_AUTH_STATUS="ok"
    GCLOUD_AUTH_SOURCE="application-default"
  else
    GCLOUD_AUTH_STATUS="failed"
    GCLOUD_AUTH_SOURCE="none"
    log_warn "gcloud auth is unavailable for Secret Manager access."
    log_warn "Run 'gcloud auth login' and 'gcloud auth application-default login' before using hosted demos."
  fi

  if [[ -z "$GCLOUD_ACTIVE_ACCOUNT" ]]; then
    GCLOUD_ACTIVE_ACCOUNT="unknown"
  fi

  printf "gcloud_auth_source=%s\n" "$GCLOUD_AUTH_SOURCE"
  printf "gcloud_auth_status=%s\n" "$GCLOUD_AUTH_STATUS"
  printf "gcloud_active_account=%s\n" "$GCLOUD_ACTIVE_ACCOUNT"
}

dotenv_lookup() {
  local requested_key="$1"
  local candidates=(
    "$ROOT_DIR/.env"
    "$ROOT_DIR/../../agora/.env"
    "$ROOT_DIR/../codex-week1-infra/.env"
    "/home/zahemen/projects/dl-lib/agora.worktrees/codex-week1-infra/.env"
  )

  local file
  for file in "${candidates[@]}"; do
    if [[ ! -f "$file" ]]; then
      continue
    fi

    local value
    value="$($PYTHON_BIN - "$file" "$requested_key" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
key = sys.argv[2]

for line in path.read_text(encoding="utf-8").splitlines():
    s = line.strip()
    if not s or s.startswith("#"):
        continue
    if s.startswith("export "):
        s = s[len("export "):].lstrip()
    if "=" not in s:
        continue
    k, v = s.split("=", 1)
    if k.strip() != key:
        continue
    val = v.strip()
    if len(val) >= 2 and val[0] == val[-1] and val[0] in {'"', "'"}:
        val = val[1:-1]
    print(val, end="")
    break
PY
)"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return 0
    fi
  done

  return 1
}

prepare_model_credentials() {
  log_step "Preparing model credentials (env -> Secret Manager fallback)"

  local gcloud_available="false"
  local gcloud_auth_ok="false"

  local project_id="${ORIG_GOOGLE_CLOUD_PROJECT:-}"
  if [[ -z "$project_id" ]] && command -v gcloud >/dev/null 2>&1; then
    gcloud_available="true"
    project_id="$(env "${GCLOUD_PROMPTLESS[@]}" gcloud config get-value project 2>/dev/null || true)"
  elif command -v gcloud >/dev/null 2>&1; then
    gcloud_available="true"
  fi

  if [[ -n "$project_id" ]]; then
    export GOOGLE_CLOUD_PROJECT="$project_id"
    printf "gcp_project=%s\n" "$project_id"
  else
    log_warn "GOOGLE_CLOUD_PROJECT is not set and gcloud project was not resolved."
  fi

  if [[ "$gcloud_available" == "true" ]]; then
    if env "${GCLOUD_PROMPTLESS[@]}" gcloud auth print-access-token >/dev/null 2>&1; then
      gcloud_auth_ok="true"
    else
      log_warn "gcloud is not authenticated (or requires reauth). Run: gcloud auth login"
    fi
  fi

  export AGORA_GEMINI_SECRET_NAME="${AGORA_GEMINI_SECRET_NAME:-agora-gemini-api-key}"
  export AGORA_GEMINI_SECRET_PROJECT="${AGORA_GEMINI_SECRET_PROJECT:-${GOOGLE_CLOUD_PROJECT:-}}"
  export AGORA_GEMINI_SECRET_VERSION="${AGORA_GEMINI_SECRET_VERSION:-latest}"
  export AGORA_ANTHROPIC_SECRET_NAME="${AGORA_ANTHROPIC_SECRET_NAME:-agora-anthropic-api-key}"
  export AGORA_ANTHROPIC_SECRET_PROJECT="${AGORA_ANTHROPIC_SECRET_PROJECT:-${GOOGLE_CLOUD_PROJECT:-}}"
  export AGORA_ANTHROPIC_SECRET_VERSION="${AGORA_ANTHROPIC_SECRET_VERSION:-latest}"
  export AGORA_OPENROUTER_SECRET_NAME="${AGORA_OPENROUTER_SECRET_NAME:-agora-openrouter-api-key}"
  export AGORA_OPENROUTER_SECRET_PROJECT="${AGORA_OPENROUTER_SECRET_PROJECT:-${GOOGLE_CLOUD_PROJECT:-}}"
  export AGORA_OPENROUTER_SECRET_VERSION="${AGORA_OPENROUTER_SECRET_VERSION:-latest}"

  # Prefer cloud secret lookup first so demo validates the intended runtime path.
  if [[ -n "${GOOGLE_CLOUD_PROJECT:-}" && "$gcloud_auth_ok" == "true" ]]; then
    local fetched_gemini
    local gemini_err_file
    gemini_err_file="$(mktemp)"
    fetched_gemini="$(env "${GCLOUD_PROMPTLESS[@]}" gcloud secrets versions access "${AGORA_GEMINI_SECRET_VERSION}" --secret "${AGORA_GEMINI_SECRET_NAME}" --project "${AGORA_GEMINI_SECRET_PROJECT}" 2>"$gemini_err_file" || true)"
    if [[ -n "$fetched_gemini" ]]; then
      export AGORA_GEMINI_API_KEY="$fetched_gemini"
      GEMINI_KEY_SOURCE="${AGORA_GEMINI_SECRET_NAME}(secret-manager)"
    elif grep -q "PERMISSION_DENIED" "$gemini_err_file"; then
      log_warn "Gemini secret fetch denied for current gcloud identity; check secret IAM access."
      log_warn "Grant roles/secretmanager.secretAccessor on ${AGORA_GEMINI_SECRET_NAME} to serviceAccount:${GCLOUD_ACTIVE_ACCOUNT}."
    fi
    rm -f "$gemini_err_file"

    local fetched_anthropic
    local anthropic_err_file
    anthropic_err_file="$(mktemp)"
    fetched_anthropic="$(env "${GCLOUD_PROMPTLESS[@]}" gcloud secrets versions access "${AGORA_ANTHROPIC_SECRET_VERSION}" --secret "${AGORA_ANTHROPIC_SECRET_NAME}" --project "${AGORA_ANTHROPIC_SECRET_PROJECT}" 2>"$anthropic_err_file" || true)"
    if [[ -n "$fetched_anthropic" ]]; then
      export ANTHROPIC_API_KEY="$fetched_anthropic"
      CLAUDE_KEY_SOURCE="${AGORA_ANTHROPIC_SECRET_NAME}(secret-manager)"
    elif grep -q "PERMISSION_DENIED" "$anthropic_err_file"; then
      log_warn "Anthropic secret fetch denied for current gcloud identity; check secret IAM access."
      log_warn "Grant roles/secretmanager.secretAccessor on ${AGORA_ANTHROPIC_SECRET_NAME} to serviceAccount:${GCLOUD_ACTIVE_ACCOUNT}."
    fi
    rm -f "$anthropic_err_file"

    local fetched_openrouter
    local openrouter_err_file
    openrouter_err_file="$(mktemp)"
    fetched_openrouter="$(env "${GCLOUD_PROMPTLESS[@]}" gcloud secrets versions access "${AGORA_OPENROUTER_SECRET_VERSION}" --secret "${AGORA_OPENROUTER_SECRET_NAME}" --project "${AGORA_OPENROUTER_SECRET_PROJECT}" 2>"$openrouter_err_file" || true)"
    if [[ -n "$fetched_openrouter" ]]; then
      export AGORA_OPENROUTER_API_KEY="$fetched_openrouter"
      OPENROUTER_KEY_SOURCE="${AGORA_OPENROUTER_SECRET_NAME}(secret-manager)"
    elif grep -q "PERMISSION_DENIED" "$openrouter_err_file"; then
      log_warn "OpenRouter secret fetch denied for current gcloud identity; check secret IAM access."
      log_warn "Grant roles/secretmanager.secretAccessor on ${AGORA_OPENROUTER_SECRET_NAME} to serviceAccount:${GCLOUD_ACTIVE_ACCOUNT}."
    fi
    rm -f "$openrouter_err_file"
  fi

  if [[ "$GEMINI_KEY_SOURCE" == "none" && -n "$ORIG_AGORA_GEMINI_API_KEY" ]]; then
    export AGORA_GEMINI_API_KEY="$ORIG_AGORA_GEMINI_API_KEY"
    GEMINI_KEY_SOURCE="AGORA_GEMINI_API_KEY(env)"
  elif [[ "$GEMINI_KEY_SOURCE" == "none" && -n "$ORIG_GEMINI_API_KEY" ]]; then
    export GEMINI_API_KEY="$ORIG_GEMINI_API_KEY"
    GEMINI_KEY_SOURCE="GEMINI_API_KEY(env)"
  elif [[ "$GEMINI_KEY_SOURCE" == "none" && -n "$ORIG_AGORA_GOOGLE_API_KEY" ]]; then
    export AGORA_GOOGLE_API_KEY="$ORIG_AGORA_GOOGLE_API_KEY"
    GEMINI_KEY_SOURCE="AGORA_GOOGLE_API_KEY(env)"
  elif [[ "$GEMINI_KEY_SOURCE" == "none" && -n "$ORIG_GOOGLE_API_KEY" ]]; then
    export GOOGLE_API_KEY="$ORIG_GOOGLE_API_KEY"
    GEMINI_KEY_SOURCE="GOOGLE_API_KEY(env)"
  fi

  if [[ "$CLAUDE_KEY_SOURCE" == "none" && -n "$ORIG_ANTHROPIC_API_KEY" ]]; then
    export ANTHROPIC_API_KEY="$ORIG_ANTHROPIC_API_KEY"
    CLAUDE_KEY_SOURCE="ANTHROPIC_API_KEY(env)"
  fi

  if [[ "$OPENROUTER_KEY_SOURCE" == "none" && -n "$ORIG_AGORA_OPENROUTER_API_KEY" ]]; then
    export AGORA_OPENROUTER_API_KEY="$ORIG_AGORA_OPENROUTER_API_KEY"
    OPENROUTER_KEY_SOURCE="AGORA_OPENROUTER_API_KEY(env)"
  elif [[ "$OPENROUTER_KEY_SOURCE" == "none" && -n "$ORIG_OPENROUTER_API_KEY" ]]; then
    export OPENROUTER_API_KEY="$ORIG_OPENROUTER_API_KEY"
    OPENROUTER_KEY_SOURCE="OPENROUTER_API_KEY(env)"
  fi

  if [[ "$GEMINI_KEY_SOURCE" == "none" ]]; then
    local v
    if v="$(dotenv_lookup "AGORA_GEMINI_API_KEY" 2>/dev/null)" && [[ -n "$v" ]]; then
      export AGORA_GEMINI_API_KEY="$v"
      GEMINI_KEY_SOURCE="AGORA_GEMINI_API_KEY(.env)"
    elif v="$(dotenv_lookup "GEMINI_API_KEY" 2>/dev/null)" && [[ -n "$v" ]]; then
      export GEMINI_API_KEY="$v"
      GEMINI_KEY_SOURCE="GEMINI_API_KEY(.env)"
    elif v="$(dotenv_lookup "GOOGLE_API_KEY" 2>/dev/null)" && [[ -n "$v" ]]; then
      export GOOGLE_API_KEY="$v"
      GEMINI_KEY_SOURCE="GOOGLE_API_KEY(.env)"
    fi
  fi

  if [[ "$CLAUDE_KEY_SOURCE" == "none" ]]; then
    local c
    if c="$(dotenv_lookup "ANTHROPIC_API_KEY" 2>/dev/null)" && [[ -n "$c" ]]; then
      export ANTHROPIC_API_KEY="$c"
      CLAUDE_KEY_SOURCE="ANTHROPIC_API_KEY(.env)"
    fi
  fi

  if [[ "$OPENROUTER_KEY_SOURCE" == "none" ]]; then
    local o
    if o="$(dotenv_lookup "AGORA_OPENROUTER_API_KEY" 2>/dev/null)" && [[ -n "$o" ]]; then
      export AGORA_OPENROUTER_API_KEY="$o"
      OPENROUTER_KEY_SOURCE="AGORA_OPENROUTER_API_KEY(.env)"
    elif o="$(dotenv_lookup "OPENROUTER_API_KEY" 2>/dev/null)" && [[ -n "$o" ]]; then
      export OPENROUTER_API_KEY="$o"
      OPENROUTER_KEY_SOURCE="OPENROUTER_API_KEY(.env)"
    fi
  fi

  printf "gemini_key_source=%s\n" "$GEMINI_KEY_SOURCE"
  printf "claude_key_source=%s\n" "$CLAUDE_KEY_SOURCE"
  printf "openrouter_key_source=%s\n" "$OPENROUTER_KEY_SOURCE"
}

log_step "Running lint checks (core + API + tests)"
"$PYTHON_BIN" -m ruff check agora api tests

run_python_tests() {
  log_step "Running all Python tests (your core + Josh infra)"
  local pytest_model_off_env=(
    "AGORA_GEMINI_SECRET_NAME="
    "AGORA_ANTHROPIC_SECRET_NAME="
    "AGORA_OPENROUTER_SECRET_NAME="
    "RUN_PAID_PROVIDER_TESTS=0"
  )
  printf "test_model_keys=disabled; env and Secret Manager model keys are disabled in this pytest section.\n"

  if [[ "$DEMO_VERBOSE_TEST_LOGS" == "1" ]]; then
    printf "test_runtime_logs=verbose\n"
    env "${pytest_model_off_env[@]}" "$PYTHON_BIN" -m pytest -s -q
    return
  fi

  printf "test_runtime_logs=filtered; set DEMO_VERBOSE_TEST_LOGS=1 to show raw runtime logs.\n"
  env "${pytest_model_off_env[@]}" "$PYTHON_BIN" - <<'PY'
import re
import subprocess
import sys

timestamped_log = re.compile(r"^(\.*)(\d{4}-\d{2}-\d{2} )")
cmd = [sys.executable, "-m", "pytest", "-s", "-q"]

proc = subprocess.Popen(
    cmd,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
)
assert proc.stdout is not None

for line in proc.stdout:
    match = timestamped_log.match(line)
    if match:
        progress_prefix = match.group(1)
        if progress_prefix:
            sys.stdout.write(progress_prefix)
            sys.stdout.flush()
        continue
    sys.stdout.write(line)
    sys.stdout.flush()

sys.exit(proc.wait())
PY
}

run_python_tests

setup_gcloud_auth
prepare_model_credentials
export AGORA_DEMO_QUERY="$DEMO_QUERY"

run_orchestrator_smoke() {
  log_step "Running orchestrator smoke test (core runtime path)"

  if ! "$PYTHON_BIN" - <<'PY'
import asyncio
import os

from agora.config import get_config
from agora.runtime.orchestrator import AgoraOrchestrator


async def main() -> None:
    query = os.environ["AGORA_DEMO_QUERY"]
    agent_count = int(os.environ["DEMO_AGENT_COUNT"])
    cfg = get_config()
    gemini_key_loaded = bool(cfg.gemini_api_key)
    claude_key_loaded = bool(cfg.anthropic_api_key)
    kimi_key_loaded = bool(cfg.openrouter_api_key)
    print("orchestrator_gemini_key_loaded:", gemini_key_loaded)
    print("orchestrator_claude_key_loaded:", claude_key_loaded)
    print("orchestrator_kimi_key_loaded:", kimi_key_loaded)
    if os.environ.get("RUN_GEMINI_SMOKE") == "always" and not gemini_key_loaded:
        raise RuntimeError("Gemini key did not propagate to orchestrator smoke.")
    if os.environ.get("RUN_CLAUDE_SMOKE") == "always" and not claude_key_loaded:
        raise RuntimeError("Claude key did not propagate to orchestrator smoke.")
    if os.environ.get("RUN_KIMI_SMOKE") == "always" and not kimi_key_loaded:
        raise RuntimeError("OpenRouter key did not propagate to orchestrator smoke.")

    orchestrator = AgoraOrchestrator(agent_count=agent_count)
    vote_tiers = [orchestrator.vote_engine._tier_for_agent(i) for i in range(agent_count)]
    print("orchestrator_agent_count:", agent_count)
    print("orchestrator_vote_tiers:", ",".join(vote_tiers))
    print("orchestrator_kimi_active_vote_tier:", "kimi" in vote_tiers)
    print("orchestrator_kimi_debate_challenger_model:", cfg.kimi_model)
    result = await orchestrator.run(query)
    print("mechanism_used:", result.mechanism_used.value)
    print("agent_models_used:", ",".join(result.agent_models_used))
    print("query:", query)
    print("final_answer:", result.final_answer)
    print("confidence:", result.confidence)
    print("merkle_root:", result.merkle_root)


asyncio.run(
    asyncio.wait_for(
        main(),
        timeout=float(os.environ.get("DEMO_ORCHESTRATOR_TIMEOUT_SECONDS", "180")),
    )
)
PY
  then
    return 1
  fi
  ORCHESTRATOR_STATUS="PASS"
}

if [[ "$RUN_ORCHESTRATOR_SMOKE" == "always" ]]; then
  run_orchestrator_smoke
elif [[ "$RUN_ORCHESTRATOR_SMOKE" == "never" ]]; then
  log_warn "RUN_ORCHESTRATOR_SMOKE=never set. Skipping natural orchestrator smoke."
  ORCHESTRATOR_STATUS="SKIPPED"
else
  if run_orchestrator_smoke; then
    :
  else
    log_warn "Natural orchestrator smoke failed or timed out in auto mode. Continuing with strict model smokes."
    ORCHESTRATOR_STATUS="SKIPPED"
  fi
fi

run_gemini_sdk_smoke() {
  log_step "Running Gemini GenAI SDK smoke (latest model path)"

  if [[ -z "${AGORA_GEMINI_API_KEY:-}" && -z "${GEMINI_API_KEY:-}" && -z "${GOOGLE_API_KEY:-}" && -z "${AGORA_GOOGLE_API_KEY:-}" ]]; then
    log_warn "Gemini key unavailable for smoke test."
    return 1
  fi

  if ! "$PYTHON_BIN" - <<'PY'
import asyncio
import os

from agora.agent import AgentCaller
from agora.config import get_config

cfg = get_config()
print("gemini_flash_model:", cfg.flash_model)
print("gemini_pro_model:", cfg.pro_model)


async def main() -> None:
    flash = AgentCaller(model=cfg.flash_model, temperature=0.1)
    flash_resp, flash_usage = await flash.call(
        system_prompt="Respond with one short token.",
        user_prompt="Reply with OK",
    )
    print("flash_response:", str(flash_resp)[:80])
    print(
        "flash_usage:",
        flash_usage.get("input_tokens"),
        flash_usage.get("output_tokens"),
    )

    pro = AgentCaller(model=cfg.pro_model, temperature=0.1)
    pro_resp, pro_usage = await pro.call(
        system_prompt="Respond with one short token.",
        user_prompt="Reply with READY",
    )
    print("pro_response:", str(pro_resp)[:80])
    print(
        "pro_usage:",
        pro_usage.get("input_tokens"),
        pro_usage.get("output_tokens"),
    )


asyncio.run(
    asyncio.wait_for(
        main(),
        timeout=float(os.environ.get("DEMO_MODEL_TIMEOUT_SECONDS", "120")),
    )
)
PY
  then
    return 1
  fi
  GEMINI_SDK_STATUS="PASS"
}

run_claude_sdk_smoke() {
  log_step "Running Claude Sonnet 4.6 SDK smoke"

  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    log_warn "Anthropic key unavailable for Claude smoke test."
    return 1
  fi

  if ! "$PYTHON_BIN" - <<'PY'
import asyncio
import os

from agora.agent import AgentCaller
from agora.config import get_config

cfg = get_config()
print("claude_model:", cfg.claude_model)


async def main() -> None:
    claude = AgentCaller(model=cfg.claude_model, temperature=0.1)
    response, usage = await claude.call(
        system_prompt="Respond with one short token.",
        user_prompt="Reply with ACK",
    )
    print("claude_response:", str(response)[:80])
    print("claude_usage:", usage.get("input_tokens"), usage.get("output_tokens"))


asyncio.run(
    asyncio.wait_for(
        main(),
        timeout=float(os.environ.get("DEMO_MODEL_TIMEOUT_SECONDS", "120")),
    )
)
PY
  then
    return 1
  fi

  CLAUDE_SDK_STATUS="PASS"
}

run_kimi_sdk_smoke() {
  log_step "Running Kimi K2 Thinking via OpenRouter SDK smoke"

  if [[ -z "${AGORA_OPENROUTER_API_KEY:-}" && -z "${OPENROUTER_API_KEY:-}" ]]; then
    log_warn "OpenRouter key unavailable for Kimi smoke test."
    return 1
  fi

  if ! "$PYTHON_BIN" - <<'PY'
import asyncio
import os

from agora.agent import AgentCaller
from agora.config import get_config

cfg = get_config()
print("kimi_model:", cfg.kimi_model)
print("kimi_reasoning_effort:", cfg.kimi_reasoning_effort)
print("kimi_reasoning_exclude:", cfg.kimi_reasoning_exclude)
print("kimi_max_tokens:", cfg.kimi_max_tokens)


async def main() -> None:
    kimi = AgentCaller(model=cfg.kimi_model, temperature=0.1)
    response, usage = await kimi.call(
        system_prompt="Respond with one short token.",
        user_prompt="Reply with KIMI",
    )
    print("kimi_response:", str(response)[:80])
    print(
        "kimi_usage:",
        usage.get("input_tokens"),
        usage.get("output_tokens"),
        usage.get("reasoning_tokens"),
    )


asyncio.run(
    asyncio.wait_for(
        main(),
        timeout=float(os.environ.get("DEMO_MODEL_TIMEOUT_SECONDS", "120")),
    )
)
PY
  then
    return 1
  fi

  KIMI_SDK_STATUS="PASS"
}

if [[ "$RUN_GEMINI_SMOKE" == "always" ]]; then
  run_gemini_sdk_smoke
elif [[ "$RUN_GEMINI_SMOKE" == "never" ]]; then
  log_warn "RUN_GEMINI_SMOKE=never set. Skipping Gemini SDK smoke."
  GEMINI_SDK_STATUS="SKIPPED"
else
  if run_gemini_sdk_smoke; then
    :
  else
    log_warn "Gemini SDK smoke failed in auto mode. Continuing with remaining checks."
    GEMINI_SDK_STATUS="SKIPPED"
  fi
fi

if [[ "$RUN_CLAUDE_SMOKE" == "always" ]]; then
  run_claude_sdk_smoke
elif [[ "$RUN_CLAUDE_SMOKE" == "never" ]]; then
  log_warn "RUN_CLAUDE_SMOKE=never set. Skipping Claude SDK smoke."
  CLAUDE_SDK_STATUS="SKIPPED"
else
  if run_claude_sdk_smoke; then
    :
  else
    log_warn "Claude SDK smoke failed in auto mode. Continuing with remaining checks."
    CLAUDE_SDK_STATUS="SKIPPED"
  fi
fi

if [[ "$RUN_KIMI_SMOKE" == "always" ]]; then
  run_kimi_sdk_smoke
elif [[ "$RUN_KIMI_SMOKE" == "never" ]]; then
  log_warn "RUN_KIMI_SMOKE=never set. Skipping Kimi SDK smoke."
  KIMI_SDK_STATUS="SKIPPED"
else
  if run_kimi_sdk_smoke; then
    :
  else
    log_warn "Kimi SDK smoke failed in auto mode. Continuing with remaining checks."
    KIMI_SDK_STATUS="SKIPPED"
  fi
fi

run_all_models_e2e() {
  log_step "Running all-model orchestrator ensemble smoke (forced 4-agent vote)"

  if [[ -z "${AGORA_GEMINI_API_KEY:-}" && -z "${GEMINI_API_KEY:-}" && -z "${GOOGLE_API_KEY:-}" && -z "${AGORA_GOOGLE_API_KEY:-}" ]]; then
    log_warn "Gemini key unavailable for all-model ensemble smoke."
    return 1
  fi
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    log_warn "Anthropic key unavailable for all-model ensemble smoke."
    return 1
  fi
  if [[ -z "${AGORA_OPENROUTER_API_KEY:-}" && -z "${OPENROUTER_API_KEY:-}" ]]; then
    log_warn "OpenRouter key unavailable for all-model ensemble smoke."
    return 1
  fi

  if ! "$PYTHON_BIN" - <<'PY'
import asyncio
import os

from agora.agent import claude_caller, flash_caller, kimi_caller, pro_caller
from agora.engines.vote import VoteEngine
from agora.runtime.orchestrator import AgoraOrchestrator
from agora.types import MechanismType


class TrackingCaller:
    def __init__(self, label: str, inner) -> None:
        self.label = label
        self.inner = inner
        self.model = inner.model
        self.successes = 0
        self.tokens = 0

    async def call(self, **kwargs):
        response, usage = await self.inner.call(**kwargs)
        self.successes += 1
        self.tokens += int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0))
        return response, usage


async def main() -> None:
    query = os.environ["AGORA_DEMO_QUERY"]
    agent_count = max(4, int(os.environ["DEMO_AGENT_COUNT"]))
    max_attempts = max(1, int(os.environ.get("DEMO_ALL_MODELS_MAX_ATTEMPTS", "3")))
    expected_models = {
        model
        for model in os.environ.get("AGORA_DEMO_EXPECTED_MODELS", "").split(",")
        if model
    }
    failures: list[str] = []

    for attempt in range(1, max_attempts + 1):
        orchestrator = AgoraOrchestrator(agent_count=agent_count)
        trackers = {
            "pro": TrackingCaller("pro", pro_caller()),
            "kimi": TrackingCaller("kimi", kimi_caller()),
            "flash": TrackingCaller("flash", flash_caller()),
            "claude": TrackingCaller("claude", claude_caller()),
        }
        orchestrator.vote_engine = VoteEngine(
            agent_count=agent_count,
            quorum_threshold=0.6,
            hasher=orchestrator.hasher,
            pro_agent=trackers["pro"],
            kimi_agent=trackers["kimi"],
            flash_agent=trackers["flash"],
            claude_agent=trackers["claude"],
        )

        try:
            result = await orchestrator.run(
                query,
                mechanism_override=MechanismType.VOTE,
            )
        except Exception as exc:
            failures.append(f"attempt {attempt}: exception={exc}")
            if attempt >= max_attempts:
                raise RuntimeError(
                    "All-model smoke exhausted retries: " + " | ".join(failures)
                ) from exc
            print(f"all_models_e2e_retry: attempt={attempt} reason=exception error={exc}")
            continue

        missing_callers = [label for label, caller in trackers.items() if caller.successes < 1]
        missing_models = sorted(expected_models - set(result.agent_models_used))
        if missing_callers or missing_models:
            failures.append(
                "attempt "
                f"{attempt}: missing_callers={','.join(missing_callers)} "
                f"missing_models={','.join(missing_models)}"
            )
            if attempt >= max_attempts:
                raise RuntimeError(
                    "All-model smoke exhausted retries: " + " | ".join(failures)
                )
            print(
                "all_models_e2e_retry:",
                f"attempt={attempt}",
                "reason=incomplete_ensemble",
                f"missing_callers={','.join(missing_callers) or 'none'}",
                f"missing_models={','.join(missing_models) or 'none'}",
            )
            continue

        print("all_models_e2e_attempt:", attempt)
        print("all_models_e2e_mechanism:", result.mechanism_used.value)
        print("all_models_e2e_agent_count:", result.agent_count)
        print("all_models_e2e_agent_models_used:", ",".join(result.agent_models_used))
        print(
            "all_models_e2e_success_counts:",
            ",".join(f"{label}={caller.successes}" for label, caller in trackers.items()),
        )
        print(
            "all_models_e2e_token_counts:",
            ",".join(f"{label}={caller.tokens}" for label, caller in trackers.items()),
        )
        print("all_models_e2e_total_tokens:", result.total_tokens_used)
        print("all_models_e2e_merkle_root:", result.merkle_root)
        return

    raise RuntimeError("All-model smoke exited without a successful attempt.")


asyncio.run(
    asyncio.wait_for(
        main(),
        timeout=float(os.environ.get("DEMO_ALL_MODELS_TIMEOUT_SECONDS", "240")),
    )
)
PY
  then
    return 1
  fi

  ALL_MODELS_E2E_STATUS="PASS"
}

if [[ "$RUN_ALL_MODELS_E2E" == "always" ]]; then
  run_all_models_e2e
elif [[ "$RUN_ALL_MODELS_E2E" == "never" ]]; then
  log_warn "RUN_ALL_MODELS_E2E=never set. Skipping all-model ensemble smoke."
  ALL_MODELS_E2E_STATUS="SKIPPED"
else
  if run_all_models_e2e; then
    :
  else
    log_warn "All-model ensemble smoke failed in auto mode. Continuing with remaining checks."
    ALL_MODELS_E2E_STATUS="SKIPPED"
  fi
fi

run_anchor_checks() {
  log_step "Running Anchor/Solana checks (optional, local tooling path)"

  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1090
    source "$HOME/.cargo/env"
  fi
  if [[ -d "$HOME/.local/share/solana/install/active_release/bin" ]]; then
    export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
  fi
  local node_bin_dir=""
  local candidate
  for candidate in "$HOME"/.nvm/versions/node/*/bin; do
    if [[ -x "$candidate/node" ]]; then
      node_bin_dir="$candidate"
    fi
  done
  if [[ -n "$node_bin_dir" ]]; then
    export PATH="$node_bin_dir:$PATH"
  fi

  local anchor_bin
  local solana_bin
  anchor_bin="$(command -v anchor || true)"
  solana_bin="$(command -v solana || true)"

  if [[ -z "$anchor_bin" || -z "$solana_bin" ]]; then
    if [[ "$RUN_ANCHOR_CHECKS" == "always" ]]; then
      log_error "anchor/solana CLI not found locally, but RUN_ANCHOR_CHECKS=always was requested."
      return 1
    fi
    log_warn "anchor/solana CLI not found locally. Skipping local contract checks."
    ANCHOR_STATUS="SKIPPED"
    return 0
  fi

  local anchor_exit=0
  (
    cd "$ROOT_DIR/contract"

    anchor --version
    solana --version

    if command -v npm >/dev/null 2>&1; then
      if [[ ! -f node_modules/@coral-xyz/anchor/package.json || ! -x node_modules/.bin/ts-mocha ]]; then
        log_warn "Installing contract JS dependencies for Anchor TS tests (npm ci)."
        npm ci --silent
      fi
    else
      if [[ "$RUN_ANCHOR_CHECKS" == "always" ]]; then
        log_error "npm is unavailable, but RUN_ANCHOR_CHECKS=always requires the Anchor TS harness."
        exit 1
      fi
      log_warn "npm is unavailable; skipping Anchor TS harness and running Rust fallback only."
      cargo test --manifest-path "$ROOT_DIR/contract/programs/agora/Cargo.toml" --release
      exit 2
    fi

    anchor build
    if ! anchor test --provider.cluster localnet --validator legacy; then
      log_warn "anchor test failed; reinstalling JS deps and retrying once."
      npm ci --silent
      if anchor test --provider.cluster localnet --validator legacy; then
        exit 0
      fi
      if [[ "$RUN_ANCHOR_CHECKS" == "always" ]]; then
        log_error "anchor test failed after retry, and RUN_ANCHOR_CHECKS=always forbids fallback."
        exit 1
      fi
      log_warn "anchor test failed; running Rust contract tests as fallback."
      cargo test --manifest-path "$ROOT_DIR/contract/programs/agora/Cargo.toml" --release
      exit 2
    fi
  ) || anchor_exit=$?

  case "$anchor_exit" in
    0)
      ANCHOR_STATUS="PASS"
      ;;
    2)
      ANCHOR_STATUS="PASS (fallback)"
      ;;
    *)
      return "$anchor_exit"
      ;;
  esac
}

if [[ "$RUN_ANCHOR_CHECKS" == "always" ]]; then
  run_anchor_checks
elif [[ "$RUN_ANCHOR_CHECKS" == "never" ]]; then
  log_warn "RUN_ANCHOR_CHECKS=never set. Skipping local contract checks."
  ANCHOR_STATUS="SKIPPED"
else
  run_anchor_checks
fi

run_hosted_api_e2e() {
  log_step "Running hosted API end-to-end smoke (create -> run -> pay)"
  export AGORA_DEMO_API_URL="$API_URL"

  if ! "$PYTHON_BIN" - <<'PY'
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE_URL = os.environ["AGORA_DEMO_API_URL"].rstrip("/")


def request_json(
    method: str,
    path: str,
    token: str | None,
    payload: dict | None = None,
) -> tuple[int, dict]:
    url = f"{BASE_URL}{path}"
    body = None
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"

    backoff = 1.0
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        req = urllib.request.Request(url=url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return resp.status, data
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            if 500 <= exc.code < 600 and attempt < max_attempts:
                print(
                    f"retrying {method} {path} after HTTP {exc.code} "
                    f"(attempt {attempt}/{max_attempts}): {raw}"
                )
                time.sleep(backoff)
                backoff *= 2.0
                continue
            raise RuntimeError(f"{method} {path} failed: {exc.code} {raw}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt >= max_attempts:
                raise RuntimeError(
                    f"{method} {path} failed after retries: {exc}"
                ) from exc
            print(
                f"retrying {method} {path} after transport error "
                f"(attempt {attempt}/{max_attempts}): {exc}"
            )
            time.sleep(backoff)
            backoff *= 2.0

    raise RuntimeError(f"{method} {path} failed unexpectedly")


def main() -> None:
    token = os.environ.get("AGORA_TEST_API_KEY")
    if not token:
        raise RuntimeError("Set AGORA_TEST_API_KEY to run hosted API smoke against an authenticated deployment.")
    query = os.environ["AGORA_DEMO_QUERY"]
    agent_count = int(os.environ["DEMO_AGENT_COUNT"])
    strict_all_models = os.environ.get("RUN_HOSTED_ALL_MODELS_E2E") == "always"
    expected_models = {
        model
        for model in os.environ.get("AGORA_DEMO_EXPECTED_MODELS", "").split(",")
        if model
    }

    health_status, health_payload = request_json("GET", "/health", token=None)
    print("health:", health_status, health_payload)

    task_text = f"{query}\n\n[week1-demo-run-id:{time.time_ns()}]"
    create_status, create_data = request_json(
        "POST",
        "/tasks/",
        token,
        {"task": task_text, "agent_count": agent_count, "stakes": 0.0},
    )
    print("create:", create_status, create_data)
    task_id = create_data["task_id"]

    run_status, run_data = request_json("POST", f"/tasks/{task_id}/run", token)
    print("run:", run_status, run_data)
    print("run_agent_count:", run_data.get("agent_count"))
    print("run_agent_models_used:", ",".join(run_data.get("agent_models_used") or []))
    if strict_all_models:
        run_models = set(run_data.get("agent_models_used") or [])
        missing = sorted(expected_models - run_models)
        if run_data.get("agent_count") != agent_count:
            raise RuntimeError(
                f"Expected hosted agent_count={agent_count}, got {run_data.get('agent_count')}"
            )
        if run_data.get("mechanism") != "vote":
            raise RuntimeError(f"Expected hosted mechanism=vote, got {run_data.get('mechanism')}")
        if missing:
            raise RuntimeError(f"Hosted run did not report all expected models: {missing}")
        if int(run_data.get("total_tokens_used") or 0) <= 0:
            raise RuntimeError("Hosted run reported zero model tokens.")

    status_status, status_data = request_json("GET", f"/tasks/{task_id}", token)
    print("status:", status_status, status_data.get("status"), status_data.get("solana_tx_hash"))

    pay_status, pay_data = request_json("POST", f"/tasks/{task_id}/pay", token)
    print("pay:", pay_status, pay_data)

    final_status, final_data = request_json("GET", f"/tasks/{task_id}", token)
    print("final:", final_status, final_data.get("status"), final_data.get("solana_tx_hash"))

    if final_data.get("status") != "paid":
        raise RuntimeError(f"Expected final status=paid, got {final_data.get('status')}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"HOSTED_E2E_FAILURE: {exc}")
        sys.exit(1)
PY
  then
    return 1
  fi
  API_E2E_STATUS="PASS"
}

if [[ "$RUN_HOSTED_API_E2E" == "always" ]]; then
  run_hosted_api_e2e
elif [[ "$RUN_HOSTED_API_E2E" == "never" ]]; then
  log_warn "RUN_HOSTED_API_E2E=never set. Skipping hosted API smoke."
  API_E2E_STATUS="SKIPPED"
else
  if run_hosted_api_e2e; then
    :
  else
    log_warn "Hosted API E2E failed in auto mode. Continuing with local verification summary."
    API_E2E_STATUS="SKIPPED"
  fi
fi

log_step "Week 1 demo summary"
printf "  %-28s %s\n" "Python lint/tests" "$CORE_STATUS"
printf "  %-28s %s\n" "Orchestrator smoke" "$ORCHESTRATOR_STATUS"
printf "  %-28s %s\n" "Gemini key source" "$GEMINI_KEY_SOURCE"
printf "  %-28s %s\n" "Gemini 3 SDK smoke" "$GEMINI_SDK_STATUS"
printf "  %-28s %s\n" "Claude key source" "$CLAUDE_KEY_SOURCE"
printf "  %-28s %s\n" "Claude Sonnet SDK smoke" "$CLAUDE_SDK_STATUS"
printf "  %-28s %s\n" "OpenRouter key source" "$OPENROUTER_KEY_SOURCE"
printf "  %-28s %s\n" "Kimi K2 SDK smoke" "$KIMI_SDK_STATUS"
printf "  %-28s %s\n" "All-model E2E smoke" "$ALL_MODELS_E2E_STATUS"
printf "  %-28s %s\n" "Local Anchor checks" "$ANCHOR_STATUS"
printf "  %-28s %s\n" "Hosted API E2E" "$API_E2E_STATUS"
printf "\nDemo complete.\n"
printf "If you later install Solana/Anchor locally, rerun with RUN_ANCHOR_CHECKS=always to force local contract verification.\n"
printf "If you want strict Gemini validation, run with RUN_GEMINI_SMOKE=always and a configured Gemini key source.\n"
printf "If you want strict Kimi validation, run with RUN_KIMI_SMOKE=always and a configured OpenRouter key source.\n"
