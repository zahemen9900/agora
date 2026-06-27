#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_FILE="${RWX_TASK_FILE:-$ROOT_DIR/.rwx/ci.yml}"
TARGET="${RWX_TARGET:-restore-validation}"
RUN_LOCAL_HOSTED_SMOKE="${RUN_LOCAL_HOSTED_SMOKE:-0}"
REPOSITORY_REF="${RWX_GIT_REF:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"

usage() {
  cat <<'EOF'
Usage: ./scripts/run_rwx_restore_validation.sh

Runs the repo restore-validation task through the RWX CLI.

Environment:
  RWX_TASK_FILE            Override the RWX task definition file
  RWX_TARGET               Override the task key to execute
  RUN_LOCAL_HOSTED_SMOKE   Set to 1 to run ./scripts/phase2_sdk_smoke/run.sh after RWX succeeds
EOF
}

log() {
  printf '[info] %s\n' "$*"
}

die() {
  printf '[error] %s\n' "$*" >&2
  exit 1
}

load_local_env() {
  local env_file
  for env_file in \
    "$ROOT_DIR/.env" \
    "$ROOT_DIR/.env.local" \
    "$ROOT_DIR/.env.development" \
    "$ROOT_DIR/agora-web/.env.local"
  do
    [[ -f "$env_file" ]] || continue
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  done
}

require_rwx() {
  if command -v rwx >/dev/null 2>&1; then
    return 0
  fi

  die "rwx CLI is not installed. Install with 'brew install rwx-cloud/tap/rwx' on macOS or download the latest Linux binary from https://github.com/rwx-cloud/rwx/releases."
}

main() {
  case "${1:-}" in
    -h|--help|help)
      usage
      exit 0
      ;;
  esac

  load_local_env

  if [[ -n "${RWX_TOKEN:-}" && -z "${RWX_ACCESS_TOKEN:-}" ]]; then
    export RWX_ACCESS_TOKEN="$RWX_TOKEN"
  fi

  require_rwx
  [[ -f "$TASK_FILE" ]] || die "RWX task file not found: $TASK_FILE"

  if ! rwx whoami >/dev/null 2>&1; then
    if [[ -z "${RWX_ACCESS_TOKEN:-}" ]]; then
      die "RWX is not authenticated. Run 'rwx login' or export RWX_TOKEN in the environment."
    fi
    log "Proceeding with RWX_ACCESS_TOKEN from the local environment."
  fi

  log "Running RWX task '$TARGET' from $TASK_FILE"
  rwx run "$TASK_FILE" \
    --target "$TARGET" \
    --wait \
    --init "ref=${REPOSITORY_REF}"

  if [[ "$RUN_LOCAL_HOSTED_SMOKE" == "1" ]]; then
    log "Running local hosted SDK smoke after RWX validation"
    "$ROOT_DIR/scripts/phase2_sdk_smoke/run.sh"
  fi
}

main "$@"
