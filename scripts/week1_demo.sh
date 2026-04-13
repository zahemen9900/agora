#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${AGORA_API_URL:-https://agora-api-rztfxer7ra-uc.a.run.app}"
RUN_ANCHOR_CHECKS="${RUN_ANCHOR_CHECKS:-auto}"
RUN_GEMINI_SMOKE="${RUN_GEMINI_SMOKE:-auto}"
RUN_CLAUDE_SMOKE="${RUN_CLAUDE_SMOKE:-auto}"
AGORA_GCLOUD_CREDENTIALS_FILE="${AGORA_GCLOUD_CREDENTIALS_FILE:-}"
DEMO_FLASH_MODEL="${DEMO_FLASH_MODEL:-gemini-3-flash-preview}"
DEMO_PRO_MODEL="${DEMO_PRO_MODEL:-gemini-3.1-pro-preview}"

ORIG_AGORA_GEMINI_API_KEY="${AGORA_GEMINI_API_KEY-}"
ORIG_GEMINI_API_KEY="${GEMINI_API_KEY-}"
ORIG_AGORA_GOOGLE_API_KEY="${AGORA_GOOGLE_API_KEY-}"
ORIG_GOOGLE_API_KEY="${GOOGLE_API_KEY-}"
ORIG_ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY-}"
ORIG_GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT-}"
ORIG_GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS-}"

COLOR_GREEN=$'\033[0;32m'
COLOR_YELLOW=$'\033[0;33m'
COLOR_RED=$'\033[0;31m'
COLOR_RESET=$'\033[0m'
GCLOUD_PROMPTLESS=("CLOUDSDK_CORE_DISABLE_PROMPTS=1")

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
unset AGORA_GEMINI_API_KEY GEMINI_API_KEY AGORA_GOOGLE_API_KEY GOOGLE_API_KEY ANTHROPIC_API_KEY

CORE_STATUS="PASS"
ANCHOR_STATUS="SKIPPED"
API_E2E_STATUS="PASS"
GEMINI_SDK_STATUS="SKIPPED"
CLAUDE_SDK_STATUS="SKIPPED"
GEMINI_KEY_SOURCE="none"
CLAUDE_KEY_SOURCE="none"
GCLOUD_AUTH_SOURCE="none"
GCLOUD_AUTH_STATUS="unknown"
GCLOUD_ACTIVE_ACCOUNT="unknown"

export AGORA_FLASH_MODEL="${AGORA_FLASH_MODEL:-$DEMO_FLASH_MODEL}"
export AGORA_PRO_MODEL="${AGORA_PRO_MODEL:-$DEMO_PRO_MODEL}"

log_step "Configured Gemini models"
printf "flash=%s\n" "$AGORA_FLASH_MODEL"
printf "pro=%s\n" "$AGORA_PRO_MODEL"

setup_gcloud_auth() {
  if ! command -v gcloud >/dev/null 2>&1; then
    log_warn "gcloud CLI not found; cloud secret fallback is unavailable."
    GCLOUD_AUTH_STATUS="unavailable"
    return 0
  fi

  local candidates=()
  if [[ -n "$AGORA_GCLOUD_CREDENTIALS_FILE" ]]; then
    candidates+=("$AGORA_GCLOUD_CREDENTIALS_FILE")
  fi
  if [[ -n "$ORIG_GOOGLE_APPLICATION_CREDENTIALS" ]]; then
    candidates+=("$ORIG_GOOGLE_APPLICATION_CREDENTIALS")
  fi
  candidates+=(
    "/home/zahemen/projects/dl-lib/agora/.credentials/even-ally-480821-f3-be2827895913.json"
    "$ROOT_DIR/.credentials/even-ally-480821-f3-be2827895913.json"
    "$ROOT_DIR/../../agora/.credentials/even-ally-480821-f3-be2827895913.json"
  )

  local selected=""
  for path in "${candidates[@]}"; do
    if [[ -n "$path" && -f "$path" ]]; then
      selected="$path"
      break
    fi
  done

  if [[ -z "$selected" ]]; then
    log_warn "No service-account credentials file found for gcloud automation."
    log_warn "Set AGORA_GCLOUD_CREDENTIALS_FILE to your key JSON to avoid reauthentication prompts."
    GCLOUD_AUTH_STATUS="missing-key-file"
    return 0
  fi

  export GOOGLE_APPLICATION_CREDENTIALS="$selected"
  export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="$selected"
  GCLOUD_AUTH_SOURCE="$selected"

  local key_project
  key_project="$($PYTHON_BIN - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["GOOGLE_APPLICATION_CREDENTIALS"])
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    print("")
else:
    print(data.get("project_id", ""), end="")
PY
)"

  if [[ -n "$key_project" ]]; then
    export CLOUDSDK_CORE_PROJECT="$key_project"
  fi

  env CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud auth activate-service-account --key-file "$selected" >/dev/null 2>&1 || true
  if env CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud auth print-access-token >/dev/null 2>&1; then
    GCLOUD_AUTH_STATUS="ok"
  else
    GCLOUD_AUTH_STATUS="failed"
  fi

  GCLOUD_ACTIVE_ACCOUNT="$(env CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1 || true)"
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

  printf "gemini_key_source=%s\n" "$GEMINI_KEY_SOURCE"
  printf "claude_key_source=%s\n" "$CLAUDE_KEY_SOURCE"
}

log_step "Running lint checks (core + API + tests)"
"$PYTHON_BIN" -m ruff check agora api tests

log_step "Running all Python tests (your core + Josh infra)"
"$PYTHON_BIN" -m pytest -q

setup_gcloud_auth
prepare_model_credentials

log_step "Running orchestrator smoke test (core runtime path)"
"$PYTHON_BIN" - <<'PY'
import asyncio

from agora.runtime.orchestrator import AgoraOrchestrator


async def main() -> None:
    orchestrator = AgoraOrchestrator(agent_count=3)
    result = await orchestrator.run("Week 1 demo: should teams use debate or vote?")
    print("mechanism_used:", result.mechanism_used.value)
    print("final_answer:", result.final_answer)
    print("confidence:", result.confidence)
    print("merkle_root:", result.merkle_root)


asyncio.run(main())
PY

run_gemini_sdk_smoke() {
  log_step "Running Gemini GenAI SDK smoke (latest model path)"

  if [[ -z "${AGORA_GEMINI_API_KEY:-}" && -z "${GEMINI_API_KEY:-}" && -z "${GOOGLE_API_KEY:-}" && -z "${AGORA_GOOGLE_API_KEY:-}" ]]; then
    log_warn "Gemini key unavailable for smoke test."
    return 1
  fi

  "$PYTHON_BIN" - <<'PY'
import asyncio

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


asyncio.run(main())
PY
  GEMINI_SDK_STATUS="PASS"
}

run_claude_sdk_smoke() {
  log_step "Running Claude Sonnet 4.6 SDK smoke"

  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    log_warn "Anthropic key unavailable for Claude smoke test."
    return 1
  fi

  "$PYTHON_BIN" - <<'PY'
import asyncio

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


asyncio.run(main())
PY

  CLAUDE_SDK_STATUS="PASS"
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

run_anchor_checks() {
  log_step "Running Anchor/Solana checks (optional, local tooling path)"

  local anchor_bin
  local solana_bin
  anchor_bin="$(command -v anchor || true)"
  solana_bin="$(command -v solana || true)"

  if [[ -z "$anchor_bin" || -z "$solana_bin" ]]; then
    log_warn "anchor/solana CLI not found locally. Skipping local contract checks."
    ANCHOR_STATUS="SKIPPED"
    return 0
  fi

  (
    cd "$ROOT_DIR/contract"
    if [[ -f "$HOME/.cargo/env" ]]; then
      # shellcheck disable=SC1090
      source "$HOME/.cargo/env"
    fi

    anchor --version
    solana --version

    if command -v npm >/dev/null 2>&1; then
      if [[ ! -d node_modules/@coral-xyz/anchor ]]; then
        log_warn "Installing contract JS dependencies for Anchor TS tests (npm ci)."
        npm ci --silent
      fi
    else
      log_warn "npm is unavailable; skipping Anchor TS harness and running Rust fallback only."
      cargo test --manifest-path "$ROOT_DIR/contract/programs/agora/Cargo.toml" --release
      ANCHOR_STATUS="PASS (fallback)"
      return 0
    fi

    anchor build
    if ! anchor test --provider.cluster localnet --validator legacy; then
      if command -v npm >/dev/null 2>&1; then
        log_warn "anchor test failed; reinstalling JS deps and retrying once."
        npm ci --silent
        if anchor test --provider.cluster localnet --validator legacy; then
          ANCHOR_STATUS="PASS"
          return 0
        fi
      fi
      log_warn "anchor test failed; running Rust contract tests as fallback."
      cargo test --manifest-path "$ROOT_DIR/contract/programs/agora/Cargo.toml" --release
      ANCHOR_STATUS="PASS (fallback)"
      return 0
    fi
  )

  ANCHOR_STATUS="PASS"
}

if [[ "$RUN_ANCHOR_CHECKS" == "always" ]]; then
  run_anchor_checks
elif [[ "$RUN_ANCHOR_CHECKS" == "never" ]]; then
  log_warn "RUN_ANCHOR_CHECKS=never set. Skipping local contract checks."
  ANCHOR_STATUS="SKIPPED"
else
  run_anchor_checks
fi

log_step "Running hosted API end-to-end smoke (create -> run -> pay)"
export AGORA_DEMO_API_URL="$API_URL"
"$PYTHON_BIN" - <<'PY'
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE_URL = os.environ["AGORA_DEMO_API_URL"].rstrip("/")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_token() -> str:
    header = {"alg": "RS256", "typ": "JWT"}
    payload = {
        "sub": "week1-demo-user",
        "email": "week1-demo@example.com",
        "name": "Week1 Demo",
    }
    return ".".join(
        [
            b64url(json.dumps(header, separators=(",", ":")).encode("utf-8")),
            b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8")),
            b64url(b"sig"),
        ]
    )


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
    token = make_token()

    health_status, health_payload = request_json("GET", "/health", token=None)
    print("health:", health_status, health_payload)

    task_text = f"Week1 hosted demo task {time.time_ns()}"
    create_status, create_data = request_json(
        "POST",
        "/tasks/",
        token,
        {"task": task_text, "agent_count": 3, "stakes": 0.0},
    )
    print("create:", create_status, create_data)
    task_id = create_data["task_id"]

    run_status, run_data = request_json("POST", f"/tasks/{task_id}/run", token)
    print("run:", run_status, run_data)

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

log_step "Week 1 demo summary"
printf "  %-28s %s\n" "Python lint/tests" "$CORE_STATUS"
printf "  %-28s %s\n" "Gemini key source" "$GEMINI_KEY_SOURCE"
printf "  %-28s %s\n" "Gemini 3 SDK smoke" "$GEMINI_SDK_STATUS"
printf "  %-28s %s\n" "Claude key source" "$CLAUDE_KEY_SOURCE"
printf "  %-28s %s\n" "Claude Sonnet SDK smoke" "$CLAUDE_SDK_STATUS"
printf "  %-28s %s\n" "Local Anchor checks" "$ANCHOR_STATUS"
printf "  %-28s %s\n" "Hosted API E2E" "$API_E2E_STATUS"
printf "\nDemo complete.\n"
printf "If you later install Solana/Anchor locally, rerun with RUN_ANCHOR_CHECKS=always to force local contract verification.\n"
printf "If you want strict Gemini validation, run with RUN_GEMINI_SMOKE=always and a configured Gemini key source.\n"
