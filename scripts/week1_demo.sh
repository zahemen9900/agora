#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${AGORA_API_URL:-https://agora-api-rztfxer7ra-uc.a.run.app}"
RUN_ANCHOR_CHECKS="${RUN_ANCHOR_CHECKS:-auto}"

COLOR_GREEN=$'\033[0;32m'
COLOR_YELLOW=$'\033[0;33m'
COLOR_RED=$'\033[0;31m'
COLOR_RESET=$'\033[0m'

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

CORE_STATUS="PASS"
ANCHOR_STATUS="SKIPPED"
API_E2E_STATUS="PASS"

log_step "Running lint checks (core + API + tests)"
"$PYTHON_BIN" -m ruff check agora api tests

log_step "Running all Python tests (your core + Josh infra)"
"$PYTHON_BIN" -m pytest -q

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

    anchor build
    anchor test --provider.cluster localnet --validator legacy
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


def request_json(method: str, path: str, token: str, payload: dict | None = None) -> tuple[int, dict]:
    url = f"{BASE_URL}{path}"
    body = None
    headers = {"Authorization": f"Bearer {token}"}
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url=url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return resp.status, data
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed: {exc.code} {raw}") from exc


def main() -> None:
    token = make_token()

    health_req = urllib.request.Request(f"{BASE_URL}/health", method="GET")
    with urllib.request.urlopen(health_req, timeout=30) as resp:
        health_payload = json.loads(resp.read().decode("utf-8"))
        print("health:", health_payload)

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
printf "  %-28s %s\n" "Local Anchor checks" "$ANCHOR_STATUS"
printf "  %-28s %s\n" "Hosted API E2E" "$API_E2E_STATUS"
printf "\nDemo complete.\n"
printf "If you later install Solana/Anchor locally, rerun with RUN_ANCHOR_CHECKS=always to force local contract verification.\n"
