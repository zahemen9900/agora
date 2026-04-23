#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

if command -v node >/dev/null 2>&1; then
  current_node="$(command -v node)"
  case "$current_node" in
    /mnt/*|\\\\wsl.localhost/*)
      ;;
    *)
      exec "$@"
      ;;
  esac
fi

nvm_root="${NVM_DIR:-$HOME/.nvm}/versions/node"
candidate_node="$(find "$nvm_root" -maxdepth 3 -type f -path '*/bin/node' 2>/dev/null | sort -V | tail -n 1)"

if [ -z "$candidate_node" ]; then
  echo "No WSL-native Node install found under $nvm_root" >&2
  exit 127
fi

candidate_bin="$(dirname "$candidate_node")"
PATH="$candidate_bin:$PATH" exec "$@"
