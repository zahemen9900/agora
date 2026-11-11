#!/usr/bin/env python3
"""Copy Agora production secrets from GCP Secret Manager into SSM SecureString.

Values are read and written in process memory. This script never prints a secret
value, never passes one as a shell argument, and never writes one to disk.
"""

from __future__ import annotations

import argparse
import base64
import json
import secrets
import subprocess
import sys
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError

REPO_ROOT = Path(__file__).resolve().parents[1]


def _read_gcp_secret(*, project: str, secret_name: str) -> bytes | None:
    result = subprocess.run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            f"--secret={secret_name}",
            f"--project={project}",
        ],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, raw_value = stripped.split("=", 1)
        key = key.strip()
        value = raw_value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def _canonical_solana_keypair(raw: bytes) -> str:
    text = raw.decode("utf-8").strip()
    try:
        parsed: Any = json.loads(text)
    except json.JSONDecodeError:
        parsed = text

    material: bytes | None = None
    if isinstance(parsed, list):
        material = bytes(parsed)
    elif isinstance(parsed, dict):
        for key in ("secret_key", "keypair", "bytes"):
            value = parsed.get(key)
            if isinstance(value, list):
                material = bytes(value)
                break
            if isinstance(value, str):
                material = _decode_key_material(value)
                break
    elif isinstance(parsed, str):
        material = _decode_key_material(parsed)

    if material is None:
        raise RuntimeError("Unable to parse Solana keypair secret")

    from solders.keypair import Keypair

    Keypair.from_bytes(material)
    return json.dumps(list(material))


def _decode_key_material(value: str) -> bytes:
    candidate = value.strip()
    if candidate.startswith("0x"):
        candidate = candidate[2:]
    if len(candidate) % 2 == 0 and all(ch in "0123456789abcdefABCDEF" for ch in candidate):
        return bytes.fromhex(candidate)
    return base64.b64decode(candidate, validate=True)


def _validate_value(value: str, *, name: str) -> None:
    if "\r" in value or "\n" in value:
        raise RuntimeError(
            f"Secret {name} contains a newline and cannot be stored as a single SSM value"
        )
    if len(value.encode("utf-8")) > 4096:
        raise RuntimeError(f"Secret {name} exceeds the 4096-byte SSM Standard SecureString limit")


def _get_parameter(client: Any, name: str) -> str | None:
    try:
        response = client.get_parameter(Name=name, WithDecryption=True)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ParameterNotFound":
            return None
        raise
    return str(response["Parameter"]["Value"])


def _put_parameter(client: Any, *, name: str, value: str, overwrite: bool) -> None:
    client.put_parameter(
        Name=name,
        Value=value,
        Type="SecureString",
        Tier="Standard",
        Overwrite=overwrite,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", default="gsl-admin")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--project", default="agora-ai-1190")
    parser.add_argument(
        "--map",
        type=Path,
        default=REPO_ROOT / "deploy" / "aws" / "secret-map.json",
    )
    parser.add_argument("--env-file", type=Path, default=REPO_ROOT / ".env")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write parameters. Default is dry-run.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Explicitly request a dry run (the default).",
    )
    parser.add_argument(
        "--rotate",
        action="store_true",
        help="Allow overwriting an existing parameter whose value changed.",
    )
    args = parser.parse_args()

    entries = json.loads(args.map.read_text(encoding="utf-8"))
    local_env = _read_env_file(args.env_file)
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    ssm = session.client("ssm")

    failures: list[str] = []
    for entry in entries:
        env_name = str(entry["ssm_name"])
        parameter_name = f"/agora/prod/{env_name}"
        required = bool(entry.get("required", False))
        transform = entry.get("transform")
        generate = entry.get("generate")

        existing = _get_parameter(ssm, parameter_name)

        if generate == "redis_password":
            if existing is not None:
                print(f"{env_name}: unchanged")
                continue
            if not args.apply:
                print(f"{env_name}: would-generate")
                continue
            value = secrets.token_urlsafe(32)
            _put_parameter(ssm, name=parameter_name, value=value, overwrite=False)
            print(f"{env_name}: created")
            continue

        raw: bytes | None = None
        gcp_secret = entry.get("gcp_secret")
        if gcp_secret:
            raw = _read_gcp_secret(project=args.project, secret_name=str(gcp_secret))
        if raw is None:
            fallback_name = str(entry.get("env_fallback") or env_name)
            fallback = local_env.get(fallback_name)
            if fallback is not None:
                raw = fallback.encode("utf-8")
        if raw is None:
            if required:
                print(f"{env_name}: MISSING")
                failures.append(env_name)
            else:
                print(f"{env_name}: skipped (optional, not found)")
            continue

        if transform == "solana_keypair":
            value = _canonical_solana_keypair(raw)
        else:
            value = raw.decode("utf-8").rstrip("\n")
        _validate_value(value, name=env_name)

        if existing is None:
            if not args.apply:
                print(f"{env_name}: would-create")
                continue
            _put_parameter(ssm, name=parameter_name, value=value, overwrite=False)
            print(f"{env_name}: created")
            continue

        if existing == value:
            print(f"{env_name}: unchanged")
            continue

        if args.rotate:
            if not args.apply:
                print(f"{env_name}: would-update")
                continue
            _put_parameter(ssm, name=parameter_name, value=value, overwrite=True)
            print(f"{env_name}: updated")
            continue

        print(f"{env_name}: DIFFERS (rerun with --rotate to overwrite)")
        failures.append(env_name)

    if failures:
        print({"failed": failures}, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
