#!/usr/bin/env python3
"""Render per-service runtime secret files from SSM Parameter Store."""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

PARAMETER_PATH = "/agora/prod"
RUNTIME_DIR = Path("/run/agora")
API_ENV = RUNTIME_DIR / "api.env"
RUNNER_ENV = RUNTIME_DIR / "runner.env"
REDIS_CONF = RUNTIME_DIR / "redis.conf"
REDIS_PASSWORD = RUNTIME_DIR / "redis-password"
KEYPAIR = RUNTIME_DIR / "devnet-keypair.json"

REQUIRED = {
    "AGORA_GEMINI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AGORA_OPENROUTER_API_KEY",
    "HELIUS_RPC_URL",
    "AGORA_API_KEY_PEPPER",
    "BENCHMARK_ADMIN_TOKEN",
    "AGORA_AXIOM_TOKEN",
    "AGORA_BRAVE_API_KEY",
    "AGORA_BRAVE_API_KEY_2",
    "AGORA_BRAVE_API_KEY_3",
    "AGORA_SANDBOX_RUNNER_BEARER_TOKEN",
    "AGORA_REDIS_PASSWORD",
    "SOLANA_KEYPAIR_JSON",
}


def _aws_parameters() -> dict[str, str]:
    aws = shutil.which("aws")
    if aws is None:
        raise RuntimeError("aws CLI is not installed on the host")
    result = subprocess.run(
        [
            aws,
            "ssm",
            "get-parameters-by-path",
            "--path",
            PARAMETER_PATH,
            "--recursive",
            "--with-decryption",
            "--output",
            "json",
        ],
        capture_output=True,
        check=True,
    )
    payload = json.loads(result.stdout.decode("utf-8"))
    values: dict[str, str] = {}
    for item in payload.get("Parameters", []):
        name = str(item.get("Name") or "")
        if name.startswith(PARAMETER_PATH + "/"):
            values[name.rsplit("/", 1)[-1]] = str(item.get("Value") or "")
    missing = sorted(REQUIRED - set(values))
    if missing:
        raise RuntimeError(f"Missing required SSM parameters: {', '.join(missing)}")
    return values


def _validate(value: str, *, name: str) -> None:
    if "\n" in value or "\r" in value:
        raise RuntimeError(f"SSM parameter {name} contains a newline")
    if "\x00" in value:
        raise RuntimeError(f"SSM parameter {name} contains a NUL byte")


def _atomic_write(path: Path, payload: str, *, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _env_lines(values: dict[str, str]) -> str:
    lines: list[str] = []
    for name in sorted(values):
        value = values[name]
        _validate(value, name=name)
        lines.append(f"{name}={value}")
    return "\n".join(lines) + "\n"


def main() -> int:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(RUNTIME_DIR, 0o700)
    values = _aws_parameters()

    api_values = {
        name: value
        for name, value in values.items()
        if name
        not in {
            "AGORA_REDIS_PASSWORD",
            "SOLANA_KEYPAIR_JSON",
        }
    }
    redis_password = values["AGORA_REDIS_PASSWORD"]
    api_values["AGORA_REDIS_URL"] = f"redis://:{redis_password}@redis:6379/0"
    _atomic_write(API_ENV, _env_lines(api_values), mode=stat.S_IRUSR | stat.S_IWUSR)

    runner_values = {
        "AGORA_SANDBOX_RUNNER_BEARER_TOKEN": values[
            "AGORA_SANDBOX_RUNNER_BEARER_TOKEN"
        ],
    }
    _atomic_write(RUNNER_ENV, _env_lines(runner_values), mode=stat.S_IRUSR | stat.S_IWUSR)

    redis_config = "\n".join(
        [
            f"requirepass {redis_password}",
            "appendonly yes",
            "appendfsync everysec",
            "maxmemory 96mb",
            "maxmemory-policy noeviction",
            "protected-mode yes",
            "bind 0.0.0.0",
            "dir /data",
            "",
        ]
    )
    # The Redis image runs as its own unprivileged user; the bind-mounted
    # config and password file must be readable inside the container.
    _atomic_write(REDIS_CONF, redis_config, mode=0o644)
    _atomic_write(REDIS_PASSWORD, redis_password + "\n", mode=0o644)

    keypair = json.loads(values["SOLANA_KEYPAIR_JSON"])
    if not isinstance(keypair, list) or len(keypair) != 64:
        raise RuntimeError("SOLANA_KEYPAIR_JSON is not a canonical 64-byte JSON list")
    _atomic_write(KEYPAIR, json.dumps(keypair), mode=stat.S_IRUSR)
    os.chown(KEYPAIR, 10001, 10001)

    print("rendered runtime secrets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
