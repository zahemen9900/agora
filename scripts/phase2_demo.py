#!/usr/bin/env python3
"""Strict Phase 2 demo harness for local API-key bootstrap and hosted SDK flow."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

DEFAULT_QUERY = (
    "Deterministic integration check: reply with exactly the single token "
    "AGORA_DEMO_OK and nothing else."
)
DEFAULT_OUTPUT = "benchmarks/results/phase2_demo.json"
DEFAULT_STAKES = 0.01
DEFAULT_AGENT_COUNT = 4
DEFAULT_MECHANISM = "vote"
DEFAULT_SOLANA_NETWORK = "devnet"
DEFAULT_TEMP_ROOT = "/tmp"
DEFAULT_TARGET = "hosted"
DEFAULT_HOSTED_API_URL = "https://agora-api-rztfxer7ra-uc.a.run.app"
DEFAULT_HTTP_TIMEOUT_SECONDS = 30.0
DEFAULT_HTTP_RETRIES = 3
DEFAULT_HOSTED_AUTH_TOKEN_SECRET = "agora-test-api-key"
DEFAULT_GEMINI_SECRET = "agora-gemini-api-key"
DEFAULT_ANTHROPIC_SECRET = "agora-anthropic-api-key"
DEFAULT_OPENROUTER_SECRET = "agora-openrouter-api-key"
DEFAULT_HELIUS_RPC_SECRET = "agora-helius-rpc-url"
DEFAULT_SOLANA_KEYPAIR_SECRET = "agora-solana-devnet-keypair"

_RUNTIME_GET_CONFIG: Any | None = None
_RUNTIME_SETTINGS: Any | None = None
_RUNTIME_BRIDGE: Any | None = None


def _promptless_gcloud_env() -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("CLOUDSDK_CORE_DISABLE_PROMPTS", "1")
    env.setdefault("CLOUDSDK_PAGER", "")
    return env


def _run_gcloud(*args: str) -> subprocess.CompletedProcess[str] | None:
    if shutil.which("gcloud") is None:
        return None

    return _run(
        ["gcloud", *args],
        env=_promptless_gcloud_env(),
        check=False,
        capture_output=True,
    )


def _run_gcloud_with_input(
    *args: str,
    input_text: str,
) -> subprocess.CompletedProcess[str] | None:
    if shutil.which("gcloud") is None:
        return None

    return subprocess.run(
        ["gcloud", *args],
        check=False,
        capture_output=True,
        text=True,
        input=input_text,
        env=_promptless_gcloud_env(),
    )


def _discover_service_account_credentials() -> Path | None:
    candidates: list[Path] = []

    explicit_path = os.getenv("AGORA_GCLOUD_CREDENTIALS_FILE", "").strip()
    if explicit_path:
        candidates.append(Path(explicit_path).expanduser())

    configured_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if configured_path:
        candidates.append(Path(configured_path).expanduser())

    credentials_dir = REPO_ROOT / ".credentials"
    preferred_file = credentials_dir / "even-ally-480821-f3-be2827895913.json"
    if preferred_file.exists():
        candidates.append(preferred_file)
    if credentials_dir.exists():
        candidates.extend(sorted(credentials_dir.glob("*.json")))

    seen: set[Path] = set()
    for candidate in candidates:
        if not candidate.is_file():
            continue
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        return resolved

    return None


def _configure_cloud_auth_context() -> dict[str, Any]:
    force_service_account = os.getenv("AGORA_FORCE_GCLOUD_SERVICE_ACCOUNT", "").strip().lower()
    should_force_service_account = force_service_account in {"1", "true", "yes", "on"}
    summary: dict[str, Any] = {
        "gcloud_available": shutil.which("gcloud") is not None,
        "gcloud_auth_status": "unknown",
        "credentials_source": "none",
        "auth_strategy": "existing-account",
    }

    credentials_file = _discover_service_account_credentials()
    if credentials_file is not None:
        credentials_path = str(credentials_file)
        summary["credentials_source"] = credentials_path

        try:
            payload = json.loads(credentials_file.read_text(encoding="utf-8"))
        except Exception:
            payload = {}

        key_project = str(payload.get("project_id") or "").strip()
        if key_project:
            os.environ.setdefault("GOOGLE_CLOUD_PROJECT", key_project)

    if summary["gcloud_available"]:
        active_account_before = ""
        active_before = _run_gcloud(
            "auth",
            "list",
            "--filter=status:ACTIVE",
            "--format=value(account)",
        )
        if active_before is not None and active_before.returncode == 0:
            active_account_before = active_before.stdout.strip()

        if (
            credentials_file is not None
            and (should_force_service_account or not active_account_before)
        ):
            credentials_path = str(credentials_file)
            os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", credentials_path)
            os.environ["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"] = credentials_path
            _run_gcloud("auth", "activate-service-account", "--key-file", str(credentials_file))
            summary["auth_strategy"] = "service-account"
        else:
            os.environ.pop("CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", None)

        token_check = _run_gcloud("auth", "print-access-token")
        if token_check is not None and token_check.returncode == 0:
            summary["gcloud_auth_status"] = "ok"
        else:
            summary["gcloud_auth_status"] = "missing-or-expired"

        active_after = _run_gcloud(
            "auth",
            "list",
            "--filter=status:ACTIVE",
            "--format=value(account)",
        )
        if active_after is not None and active_after.returncode == 0:
            account = active_after.stdout.strip()
            if account:
                summary["gcloud_active_account"] = account

        if not os.getenv("GOOGLE_CLOUD_PROJECT", "").strip():
            project_result = _run_gcloud("config", "get-value", "project")
            if project_result is not None and project_result.returncode == 0:
                project = project_result.stdout.strip()
                if project and project != "(unset)":
                    os.environ["GOOGLE_CLOUD_PROJECT"] = project

    project_id = os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()
    if project_id:
        summary["google_cloud_project"] = project_id

    return summary


def _load_secret_via_gcloud(
    *,
    secret_name: str,
    project_id: str,
    version: str = "latest",
) -> str | None:
    if not secret_name or not project_id:
        return None

    result = _run_gcloud(
        "secrets",
        "versions",
        "access",
        version,
        "--secret",
        secret_name,
        "--project",
        project_id,
    )
    if result is None or result.returncode != 0:
        return None

    payload = result.stdout.strip()
    return payload or None


def _ensure_phase2_secret_defaults() -> None:
    project = os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()

    os.environ.setdefault("AGORA_GEMINI_SECRET_NAME", DEFAULT_GEMINI_SECRET)
    os.environ.setdefault("AGORA_ANTHROPIC_SECRET_NAME", DEFAULT_ANTHROPIC_SECRET)
    os.environ.setdefault("AGORA_OPENROUTER_SECRET_NAME", DEFAULT_OPENROUTER_SECRET)

    if project:
        os.environ.setdefault("AGORA_GEMINI_SECRET_PROJECT", project)
        os.environ.setdefault("AGORA_ANTHROPIC_SECRET_PROJECT", project)
        os.environ.setdefault("AGORA_OPENROUTER_SECRET_PROJECT", project)

    os.environ.setdefault("AGORA_GEMINI_SECRET_VERSION", "latest")
    os.environ.setdefault("AGORA_ANTHROPIC_SECRET_VERSION", "latest")
    os.environ.setdefault("AGORA_OPENROUTER_SECRET_VERSION", "latest")

    os.environ.setdefault("AGORA_HELIUS_RPC_SECRET_NAME", DEFAULT_HELIUS_RPC_SECRET)
    os.environ.setdefault("AGORA_HELIUS_RPC_VERSION", "latest")
    if project:
        os.environ.setdefault("AGORA_HELIUS_RPC_SECRET_PROJECT", project)

    keypair_secret_name = os.getenv("AGORA_SOLANA_KEYPAIR_SECRET_NAME", "").strip()
    os.environ.setdefault(
        "SOLANA_KEYPAIR_SECRET_NAME",
        keypair_secret_name or DEFAULT_SOLANA_KEYPAIR_SECRET,
    )
    os.environ.setdefault("SOLANA_KEYPAIR_SECRET_VERSION", "latest")
    if project:
        os.environ.setdefault("SOLANA_KEYPAIR_SECRET_PROJECT", project)


def _bootstrap_credentials_for_phase2_demo() -> dict[str, Any]:
    summary = _configure_cloud_auth_context()
    _ensure_phase2_secret_defaults()

    project = os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()

    gemini_sources = (
        "AGORA_GEMINI_API_KEY",
        "GEMINI_API_KEY",
        "AGORA_GOOGLE_API_KEY",
        "GOOGLE_API_KEY",
    )
    if any(os.getenv(name, "").strip() for name in gemini_sources):
        summary["gemini_key_source"] = "env"
    else:
        value = _load_secret_via_gcloud(
            secret_name=os.getenv("AGORA_GEMINI_SECRET_NAME", DEFAULT_GEMINI_SECRET).strip(),
            project_id=os.getenv("AGORA_GEMINI_SECRET_PROJECT", project).strip(),
            version=os.getenv("AGORA_GEMINI_SECRET_VERSION", "latest").strip() or "latest",
        )
        if value:
            os.environ["AGORA_GEMINI_API_KEY"] = value
            summary["gemini_key_source"] = "secret-manager:gcloud"
        else:
            summary["gemini_key_source"] = "unresolved"

    if os.getenv("ANTHROPIC_API_KEY", "").strip():
        summary["anthropic_key_source"] = "env"
    else:
        value = _load_secret_via_gcloud(
            secret_name=os.getenv("AGORA_ANTHROPIC_SECRET_NAME", DEFAULT_ANTHROPIC_SECRET).strip(),
            project_id=os.getenv("AGORA_ANTHROPIC_SECRET_PROJECT", project).strip(),
            version=os.getenv("AGORA_ANTHROPIC_SECRET_VERSION", "latest").strip() or "latest",
        )
        if value:
            os.environ["ANTHROPIC_API_KEY"] = value
            summary["anthropic_key_source"] = "secret-manager:gcloud"
        else:
            summary["anthropic_key_source"] = "unresolved"

    if os.getenv("AGORA_OPENROUTER_API_KEY", "").strip() or os.getenv(
        "OPENROUTER_API_KEY",
        "",
    ).strip():
        summary["openrouter_key_source"] = "env"
    else:
        value = _load_secret_via_gcloud(
            secret_name=os.getenv(
                "AGORA_OPENROUTER_SECRET_NAME",
                DEFAULT_OPENROUTER_SECRET,
            ).strip(),
            project_id=os.getenv("AGORA_OPENROUTER_SECRET_PROJECT", project).strip(),
            version=os.getenv("AGORA_OPENROUTER_SECRET_VERSION", "latest").strip() or "latest",
        )
        if value:
            os.environ["AGORA_OPENROUTER_API_KEY"] = value
            summary["openrouter_key_source"] = "secret-manager:gcloud"
        else:
            summary["openrouter_key_source"] = "unresolved"

    helius_rpc = os.getenv("HELIUS_RPC_URL", "").strip() or os.getenv("HELIUS_URL", "").strip()
    if helius_rpc and "YOUR_KEY" not in helius_rpc:
        os.environ.setdefault("HELIUS_RPC_URL", helius_rpc)
        summary["helius_rpc_source"] = "env"
    else:
        value = _load_secret_via_gcloud(
            secret_name=os.getenv(
                "AGORA_HELIUS_RPC_SECRET_NAME",
                DEFAULT_HELIUS_RPC_SECRET,
            ).strip(),
            project_id=os.getenv("AGORA_HELIUS_RPC_SECRET_PROJECT", project).strip(),
            version=os.getenv("AGORA_HELIUS_RPC_VERSION", "latest").strip() or "latest",
        )
        if value:
            os.environ["HELIUS_RPC_URL"] = value
            summary["helius_rpc_source"] = "secret-manager:gcloud"
        else:
            summary["helius_rpc_source"] = "unresolved"

    summary["solana_keypair_source"] = (
        "secret-configured"
        if os.getenv("SOLANA_KEYPAIR_SECRET_NAME", "").strip()
        and (
            os.getenv("SOLANA_KEYPAIR_SECRET_PROJECT", "").strip()
            or os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()
        )
        else "unresolved"
    )

    return summary


def _initialize_runtime_bindings() -> None:
    global _RUNTIME_GET_CONFIG, _RUNTIME_SETTINGS, _RUNTIME_BRIDGE

    import api.config as api_config_module
    import api.solana_bridge as solana_bridge_module
    from agora import config as agora_config_module

    agora_config_module.get_config.cache_clear()
    _RUNTIME_GET_CONFIG = agora_config_module.get_config
    api_config_module = importlib.reload(api_config_module)
    solana_bridge_module = importlib.reload(solana_bridge_module)
    _RUNTIME_SETTINGS = api_config_module.settings
    _RUNTIME_BRIDGE = solana_bridge_module.bridge


def _runtime_bindings() -> tuple[Any, Any, Any]:
    if _RUNTIME_GET_CONFIG is None or _RUNTIME_SETTINGS is None or _RUNTIME_BRIDGE is None:
        raise RuntimeError("Runtime bindings not initialized")
    return _RUNTIME_GET_CONFIG, _RUNTIME_SETTINGS, _RUNTIME_BRIDGE


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    bootstrap_if_missing_default = os.getenv(
        "AGORA_PHASE2_BOOTSTRAP_IF_MISSING_TOKEN",
        "true",
    ).strip().lower() in {"1", "true", "yes", "on"}
    bootstrap_store_secret_default = os.getenv(
        "AGORA_PHASE2_BOOTSTRAP_STORE_SECRET",
        "true",
    ).strip().lower() in {"1", "true", "yes", "on"}
    bootstrap_key_name_default = (
        os.getenv("AGORA_PHASE2_BOOTSTRAP_KEY_NAME", "").strip()
        or f"phase2-demo-{int(time.time())}"
    )

    parser.add_argument(
        "--target",
        choices=("hosted", "local"),
        default=os.getenv("AGORA_PHASE2_TARGET", DEFAULT_TARGET),
        help=(
            "Execution target for the strict phase 2 demo. "
            "Use hosted (default) for Cloud Run validation or local for local API bootstrap."
        ),
    )
    parser.add_argument(
        "--api-url",
        default=os.getenv("AGORA_API_URL", DEFAULT_HOSTED_API_URL),
        help="Hosted API base URL used when --target hosted.",
    )
    parser.add_argument(
        "--auth-token",
        default=(
            os.getenv("AGORA_PHASE2_AUTH_TOKEN")
            or os.getenv("AGORA_TEST_API_KEY")
            or ""
        ),
        help=(
            "Hosted bearer token (recommended: AGORA_TEST_API_KEY). "
            "Required when --target hosted."
        ),
    )
    parser.add_argument(
        "--bootstrap-if-missing-token",
        dest="bootstrap_if_missing_token",
        action="store_true",
        default=bootstrap_if_missing_default,
        help=(
            "When hosted auth token is missing, auto-create one via /api-keys using a "
            "human JWT and then store it in Secret Manager."
        ),
    )
    parser.add_argument(
        "--no-bootstrap-if-missing-token",
        dest="bootstrap_if_missing_token",
        action="store_false",
        help="Disable hosted token bootstrap and fail immediately if token lookup fails.",
    )
    parser.add_argument(
        "--bootstrap-jwt-token",
        default=(
            os.getenv("AGORA_PHASE2_BOOTSTRAP_JWT")
            or os.getenv("AGORA_WORKOS_JWT")
            or os.getenv("WORKOS_JWT")
            or ""
        ),
        help=(
            "Human WorkOS/AuthKit JWT used to call /api-keys during hosted token bootstrap."
        ),
    )
    parser.add_argument(
        "--bootstrap-key-name",
        default=bootstrap_key_name_default,
        help="API key name used when hosted token bootstrap creates a fresh key.",
    )
    parser.add_argument(
        "--bootstrap-store-secret",
        dest="bootstrap_store_secret",
        action="store_true",
        default=bootstrap_store_secret_default,
        help="Store bootstrap-created hosted token in Secret Manager (default: enabled).",
    )
    parser.add_argument(
        "--no-bootstrap-store-secret",
        dest="bootstrap_store_secret",
        action="store_false",
        help="Skip Secret Manager storage after hosted token bootstrap.",
    )
    parser.add_argument(
        "--bootstrap-secret-name",
        default=(
            os.getenv("AGORA_TEST_API_KEY_SECRET_NAME")
            or os.getenv("AGORA_HOSTED_AUTH_TOKEN_SECRET_NAME")
            or DEFAULT_HOSTED_AUTH_TOKEN_SECRET
        ),
        help="Secret Manager secret name used to persist bootstrap-created hosted API keys.",
    )
    parser.add_argument(
        "--bootstrap-secret-project",
        default=(
            os.getenv("AGORA_TEST_API_KEY_SECRET_PROJECT")
            or os.getenv("AGORA_HOSTED_AUTH_TOKEN_SECRET_PROJECT")
            or os.getenv("GOOGLE_CLOUD_PROJECT")
            or ""
        ),
        help="Secret Manager project used to persist bootstrap-created hosted API keys.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        default=os.getenv("AGORA_PHASE2_VERBOSE", "").strip().lower()
        in {"1", "true", "yes", "on"},
        help="Print detailed run summaries to terminal in addition to artifact output.",
    )
    parser.add_argument(
        "--http-timeout-seconds",
        type=float,
        default=float(
            os.getenv("AGORA_PHASE2_HTTP_TIMEOUT_SECONDS", str(DEFAULT_HTTP_TIMEOUT_SECONDS))
        ),
        help="HTTP timeout used for hosted preflight checks.",
    )
    parser.add_argument(
        "--http-retries",
        type=int,
        default=int(os.getenv("AGORA_PHASE2_HTTP_RETRIES", str(DEFAULT_HTTP_RETRIES))),
        help="Max attempts for hosted preflight HTTP checks.",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help="Artifact path written after the demo run.",
    )
    parser.add_argument(
        "--query",
        default=DEFAULT_QUERY,
        help="Task text used for the strict phase 2 demo run.",
    )
    parser.add_argument(
        "--stakes",
        type=float,
        default=DEFAULT_STAKES,
        help=(
            "Stake amount in SOL for the demo run. Strict defaults enforce 0.01 unless "
            "--allow-unsafe-overrides is set."
        ),
    )
    parser.add_argument(
        "--agent-count",
        type=int,
        default=DEFAULT_AGENT_COUNT,
        help=(
            "Hosted agent count for the demo run. Strict defaults enforce 4 unless "
            "--allow-unsafe-overrides is set."
        ),
    )
    parser.add_argument(
        "--mechanism",
        default=DEFAULT_MECHANISM,
        choices=("vote", "debate"),
        help=(
            "Mechanism override used for the demo run. Strict defaults enforce vote unless "
            "--allow-unsafe-overrides is set."
        ),
    )
    parser.add_argument(
        "--allow-unsafe-overrides",
        action="store_true",
        help=(
            "Allow non-default stakes/mechanism/agent-count values. Disabled by default "
            "to keep the strict phase 2 acceptance run deterministic."
        ),
    )
    parser.add_argument(
        "--keep-temp",
        action="store_true",
        help="Keep temporary API/venv/log files after a successful run.",
    )
    parser.add_argument(
        "--temp-root",
        default=os.getenv("AGORA_PHASE2_TEMP_ROOT", DEFAULT_TEMP_ROOT),
        help=(
            "Parent directory for the throwaway demo workspace. Defaults to "
            "AGORA_PHASE2_TEMP_ROOT or /tmp."
        ),
    )
    return parser.parse_args(argv)


def _resolve_expected_models_from_env() -> list[str] | None:
    raw = (
        os.getenv("AGORA_PHASE2_EXPECTED_MODELS", "").strip()
        or os.getenv("AGORA_DEMO_EXPECTED_MODELS", "").strip()
    )
    if not raw:
        return None

    models = [value.strip() for value in raw.split(",") if value.strip()]
    return models or None


def _resolve_hosted_auth_token_from_secret() -> str | None:
    secret_name = (
        os.getenv("AGORA_TEST_API_KEY_SECRET_NAME", "").strip()
        or os.getenv("AGORA_HOSTED_AUTH_TOKEN_SECRET_NAME", "").strip()
        or DEFAULT_HOSTED_AUTH_TOKEN_SECRET
    )
    project_id = (
        os.getenv("AGORA_TEST_API_KEY_SECRET_PROJECT", "").strip()
        or os.getenv("AGORA_HOSTED_AUTH_TOKEN_SECRET_PROJECT", "").strip()
        or os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()
    )
    version = (
        os.getenv("AGORA_TEST_API_KEY_SECRET_VERSION", "").strip()
        or os.getenv("AGORA_HOSTED_AUTH_TOKEN_SECRET_VERSION", "").strip()
        or "latest"
    )
    if not secret_name or not project_id:
        return None

    token = _load_secret_via_gcloud(
        secret_name=secret_name,
        project_id=project_id,
        version=version,
    )
    if token:
        os.environ.setdefault("AGORA_TEST_API_KEY", token)
        os.environ.setdefault("AGORA_PHASE2_AUTH_TOKEN", token)
    return token


def _store_bootstrap_token_in_secret_manager(
    *,
    token: str,
    secret_name: str,
    project_id: str,
) -> dict[str, Any]:
    if not secret_name:
        raise RuntimeError("Hosted token bootstrap secret name is empty")
    if not project_id:
        raise RuntimeError(
            "Hosted token bootstrap requires GOOGLE_CLOUD_PROJECT or --bootstrap-secret-project"
        )

    describe_result = _run_gcloud(
        "secrets",
        "describe",
        secret_name,
        "--project",
        project_id,
    )
    if describe_result is None:
        raise RuntimeError("gcloud CLI is required to store bootstrap tokens in Secret Manager")

    secret_created = False
    if describe_result.returncode != 0:
        create_result = _run_gcloud(
            "secrets",
            "create",
            secret_name,
            "--replication-policy",
            "automatic",
            "--project",
            project_id,
        )
        if create_result is None or create_result.returncode != 0:
            create_error = (
                ((create_result.stderr or "").strip() if create_result else "")
                or ((create_result.stdout or "").strip() if create_result else "")
                or "unknown gcloud error"
            )
            raise RuntimeError(
                "Failed to create bootstrap token secret "
                f"{secret_name!r} in project {project_id!r}: {create_error}"
            )
        secret_created = True

    add_result = _run_gcloud_with_input(
        "secrets",
        "versions",
        "add",
        secret_name,
        "--data-file=-",
        "--project",
        project_id,
        input_text=token,
    )
    if add_result is None or add_result.returncode != 0:
        add_error = (
            ((add_result.stderr or "").strip() if add_result else "")
            or ((add_result.stdout or "").strip() if add_result else "")
            or "unknown gcloud error"
        )
        raise RuntimeError(
            "Failed to add a secret version for hosted bootstrap token "
            f"{secret_name!r} in project {project_id!r}: {add_error}"
        )

    return {
        "status": "stored",
        "secret_name": secret_name,
        "secret_project": project_id,
        "secret_created": secret_created,
    }


def _bootstrap_hosted_auth_token(args: argparse.Namespace) -> tuple[str, dict[str, Any]]:
    bootstrap_jwt = str(getattr(args, "bootstrap_jwt_token", "") or "").strip()
    if not bootstrap_jwt:
        raise RuntimeError(
            "Hosted token bootstrap requires a human JWT. "
            "Set AGORA_PHASE2_BOOTSTRAP_JWT or pass --bootstrap-jwt-token."
        )

    base_url = str(getattr(args, "api_url", DEFAULT_HOSTED_API_URL) or DEFAULT_HOSTED_API_URL)
    timeout_seconds = float(
        getattr(args, "http_timeout_seconds", DEFAULT_HTTP_TIMEOUT_SECONDS)
    )
    retries = int(getattr(args, "http_retries", DEFAULT_HTTP_RETRIES))
    verbose = bool(getattr(args, "verbose", False))
    key_name = str(getattr(args, "bootstrap_key_name", "") or "").strip()
    if not key_name:
        key_name = f"phase2-demo-{int(time.time())}"
    if len(key_name) > 100:
        raise RuntimeError("Hosted bootstrap key name must be <= 100 characters")

    auth_me_payload = _request_json_with_retry(
        base_url=base_url,
        method="GET",
        path="/auth/me",
        token=bootstrap_jwt,
        timeout_seconds=timeout_seconds,
        retries=retries,
        label="bootstrap-auth-me",
        verbose=verbose,
    )
    principal = auth_me_payload.get("principal")
    if not isinstance(principal, dict) or principal.get("auth_method") != "jwt":
        raise RuntimeError(
            "Hosted token bootstrap requires a human JWT principal for /api-keys access"
        )

    api_key_payload = _request_json_with_retry(
        base_url=base_url,
        method="POST",
        path="/api-keys/",
        token=bootstrap_jwt,
        json_body={"name": key_name},
        timeout_seconds=timeout_seconds,
        retries=retries,
        label="bootstrap-create-api-key",
        verbose=verbose,
    )
    api_key = str(api_key_payload.get("api_key", "")).strip()
    if not api_key or "." not in api_key:
        raise RuntimeError("Hosted token bootstrap received an invalid API key response")
    if not (api_key.startswith("agora_test_") or api_key.startswith("agora_live_")):
        raise RuntimeError("Hosted token bootstrap received API key with unsupported prefix")

    metadata = api_key_payload.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}

    storage_summary: dict[str, Any]
    if bool(getattr(args, "bootstrap_store_secret", True)):
        secret_name = str(getattr(args, "bootstrap_secret_name", "") or "").strip()
        secret_project = str(getattr(args, "bootstrap_secret_project", "") or "").strip()
        if not secret_project:
            secret_project = os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()
        storage_summary = _store_bootstrap_token_in_secret_manager(
            token=api_key,
            secret_name=secret_name,
            project_id=secret_project,
        )
    else:
        storage_summary = {
            "status": "skipped",
            "reason": "--no-bootstrap-store-secret",
        }

    os.environ["AGORA_TEST_API_KEY"] = api_key
    os.environ["AGORA_PHASE2_AUTH_TOKEN"] = api_key

    bootstrap_summary = {
        "mode": "jwt",
        "api_key_hint": api_key.split(".", 1)[0],
        "bootstrap_key_name": key_name,
        "workspace_id": (
            str((auth_me_payload.get("workspace") or {}).get("id", ""))
            if isinstance(auth_me_payload.get("workspace"), dict)
            else ""
        ),
        "principal_auth_method": principal.get("auth_method"),
        "created_key_id": str(metadata.get("key_id", "")),
        "created_key_public_id": str(metadata.get("public_id", "")),
        "secret_storage": storage_summary,
    }
    return api_key, bootstrap_summary


def _resolve_hosted_auth_context(
    args: argparse.Namespace,
) -> tuple[str, str, dict[str, Any] | None]:
    token = str(getattr(args, "auth_token", "") or "").strip()
    if token:
        return token, "cli-or-env-arg", None

    env_token = (
        os.getenv("AGORA_TEST_API_KEY", "").strip()
        or os.getenv("AGORA_PHASE2_AUTH_TOKEN", "").strip()
    )
    if env_token:
        return env_token, "process-env", None

    secret_token = _resolve_hosted_auth_token_from_secret()
    if secret_token:
        return secret_token, "secret-manager:gcloud", None

    bootstrap_if_missing = bool(getattr(args, "bootstrap_if_missing_token", True))
    bootstrap_jwt = str(getattr(args, "bootstrap_jwt_token", "") or "").strip()
    if bootstrap_if_missing and bootstrap_jwt:
        bootstrapped_token, bootstrap_summary = _bootstrap_hosted_auth_token(args)
        return bootstrapped_token, "jwt-bootstrap", bootstrap_summary

    bootstrap_guidance = (
        "Set AGORA_PHASE2_BOOTSTRAP_JWT (human JWT) to auto-create and store one."
        if bootstrap_if_missing
        else "Enable --bootstrap-if-missing-token with --bootstrap-jwt-token to auto-create one."
    )

    raise RuntimeError(
        "Hosted phase 2 demo requires an auth token. "
        "Set AGORA_TEST_API_KEY, pass --auth-token, or configure "
        "AGORA_TEST_API_KEY_SECRET_NAME for Secret Manager lookup. "
        f"{bootstrap_guidance} "
        "Hosted mode cannot auto-generate a key from API-key auth alone because "
        "/api-keys requires a human JWT session. "
        "If you want to skip hosted token requirements, run --target local."
    )


def _resolve_hosted_auth_token(args: argparse.Namespace) -> str:
    token, _, _ = _resolve_hosted_auth_context(args)
    return token


def _normalize_task_event(raw_event: Any) -> dict[str, Any] | None:
    if not isinstance(raw_event, dict):
        return None

    event_name = str(raw_event.get("event", "")).strip()
    if not event_name:
        return None

    timestamp_value = raw_event.get("timestamp")
    timestamp = str(timestamp_value).strip() if timestamp_value is not None else ""

    data = raw_event.get("data")
    if not isinstance(data, dict):
        data = {}

    return {
        "event": event_name,
        "timestamp": timestamp or None,
        "data": data,
    }


def _event_signature(event_payload: dict[str, Any]) -> str:
    event_data = event_payload.get("data")
    return json.dumps(
        {
            "event": event_payload.get("event"),
            "timestamp": event_payload.get("timestamp"),
            "data": event_data if isinstance(event_data, dict) else {},
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _collect_task_events(sdk_flow: dict[str, Any]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    seen_signatures: set[str] = set()

    for status_key in ("status_after_create", "status_after_run", "status_after_pay"):
        status_payload = sdk_flow.get(status_key)
        if not isinstance(status_payload, dict):
            continue

        raw_events = status_payload.get("events")
        if not isinstance(raw_events, list):
            continue

        for raw_event in raw_events:
            normalized = _normalize_task_event(raw_event)
            if normalized is None:
                continue

            signature = _event_signature(normalized)
            if signature in seen_signatures:
                continue

            seen_signatures.add(signature)
            events.append(normalized)

    return events


def _event_data_excerpt(data: dict[str, Any], *, max_items: int = 6) -> dict[str, Any]:
    preferred_keys = (
        "task_id",
        "status",
        "payment_status",
        "mechanism",
        "agent_id",
        "role",
        "faction",
        "round_index",
        "round",
        "confidence",
        "quorum_reached",
        "solana_tx_hash",
        "tx_hash",
        "error",
        "reason",
    )

    excerpt: dict[str, Any] = {}
    for key in preferred_keys:
        if len(excerpt) >= max_items or key not in data:
            continue
        value = data[key]
        if isinstance(value, (str, int, float, bool)) or value is None:
            excerpt[key] = value

    if len(excerpt) >= max_items:
        return excerpt

    for key in sorted(data):
        if len(excerpt) >= max_items or key in excerpt:
            continue
        value = data[key]
        if isinstance(value, (str, int, float, bool)) or value is None:
            excerpt[key] = value

    return excerpt


def _parse_iso_timestamp(raw: str | None) -> datetime | None:
    if not raw:
        return None

    candidate = raw.strip()
    if not candidate:
        return None
    if candidate.endswith("Z"):
        candidate = f"{candidate[:-1]}+00:00"

    try:
        return datetime.fromisoformat(candidate)
    except ValueError:
        return None


def _build_event_timeline(
    sdk_flow: dict[str, Any],
    *,
    excerpt_size: int = 5,
) -> dict[str, Any]:
    if excerpt_size < 1:
        raise ValueError("excerpt_size must be >= 1")

    events = _collect_task_events(sdk_flow)
    counts = Counter(event["event"] for event in events)
    event_counts = dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))

    first_timestamp = events[0].get("timestamp") if events else None
    last_timestamp = events[-1].get("timestamp") if events else None

    span_seconds: float | None = None
    first_dt = _parse_iso_timestamp(first_timestamp)
    last_dt = _parse_iso_timestamp(last_timestamp)
    if first_dt is not None and last_dt is not None and last_dt >= first_dt:
        span_seconds = round((last_dt - first_dt).total_seconds(), 3)

    summarized = [
        {
            "event": event["event"],
            "timestamp": event.get("timestamp"),
            "data_excerpt": _event_data_excerpt(event.get("data") or {}),
        }
        for event in events
    ]

    return {
        "event_count": len(events),
        "unique_event_types": len(event_counts),
        "event_counts": event_counts,
        "first_timestamp": first_timestamp,
        "last_timestamp": last_timestamp,
        "event_span_seconds": span_seconds,
        "mechanism_switch_count": event_counts.get("mechanism_switch", 0),
        "error_event_count": event_counts.get("error", 0),
        "first_events": summarized[:excerpt_size],
        "last_events": summarized[-excerpt_size:] if summarized else [],
    }


def _build_acceptance_checks(sdk_flow: dict[str, Any]) -> dict[str, bool]:
    status_after_create = sdk_flow.get("status_after_create") or {}
    status_after_run = sdk_flow.get("status_after_run") or {}
    status_after_pay = sdk_flow.get("status_after_pay") or {}
    verification = sdk_flow.get("receipt_verification") or {}

    return {
        "initialize_tx_present": bool(status_after_create.get("solana_tx_hash")),
        "receipt_tx_present": bool(status_after_run.get("solana_tx_hash")),
        "payment_tx_present": bool(status_after_pay.get("solana_tx_hash")),
        "final_status_paid": status_after_pay.get("status") == "paid",
        "payment_status_released": status_after_pay.get("payment_status") == "released",
        "receipt_merkle_match": verification.get("merkle_match") is True,
        "receipt_hosted_metadata_match": verification.get("hosted_metadata_match") is True,
    }


def _build_status_snapshots(sdk_flow: dict[str, Any]) -> dict[str, dict[str, Any]]:
    snapshots: dict[str, dict[str, Any]] = {}
    for status_key in ("status_after_create", "status_after_run", "status_after_pay"):
        status_payload = sdk_flow.get(status_key)
        if not isinstance(status_payload, dict):
            continue

        raw_events = status_payload.get("events")
        event_count = len(raw_events) if isinstance(raw_events, list) else 0
        snapshots[status_key] = {
            "status": status_payload.get("status"),
            "payment_status": status_payload.get("payment_status"),
            "mechanism": status_payload.get("mechanism"),
            "solana_tx_hash": status_payload.get("solana_tx_hash"),
            "event_count": event_count,
        }

    return snapshots


def _build_run_summary(
    sdk_flow: dict[str, Any],
    *,
    event_timeline: dict[str, Any] | None = None,
) -> dict[str, Any]:
    status_after_create = sdk_flow.get("status_after_create") or {}
    status_after_run = sdk_flow.get("status_after_run") or {}
    status_after_pay = sdk_flow.get("status_after_pay") or {}
    run_result = status_after_run.get("result") or {}
    verification = sdk_flow.get("receipt_verification") or {}
    timeline = event_timeline or _build_event_timeline(sdk_flow)
    latest_events = [
        f"{event.get('timestamp') or 'n/a'}::{event.get('event')}"
        for event in (timeline.get("last_events") or [])
    ]

    transcript_hashes = run_result.get("transcript_hashes") or []
    if not isinstance(transcript_hashes, list):
        transcript_hashes = []

    return {
        "task_id": status_after_run.get("task_id") or status_after_create.get("task_id"),
        "mechanism": status_after_run.get("mechanism"),
        "final_status": status_after_pay.get("status"),
        "payment_status": status_after_pay.get("payment_status"),
        "final_answer": run_result.get("final_answer"),
        "confidence": run_result.get("confidence"),
        "round_count": run_result.get("round_count"),
        "mechanism_switches": run_result.get("mechanism_switches"),
        "total_tokens_used": run_result.get("total_tokens_used"),
        "latency_ms": run_result.get("latency_ms"),
        "agent_models_used": run_result.get("agent_models_used") or [],
        "transcript_hash_count": len(transcript_hashes),
        "event_count": int(timeline.get("event_count") or 0),
        "event_type_count": int(timeline.get("unique_event_types") or 0),
        "event_types": list((timeline.get("event_counts") or {}).keys()),
        "event_span_seconds": timeline.get("event_span_seconds"),
        "latest_events": latest_events,
        "receipt_verification": {
            "merkle_match": verification.get("merkle_match"),
            "hosted_metadata_match": verification.get("hosted_metadata_match"),
        },
        "acceptance_checks": _build_acceptance_checks(sdk_flow),
    }


def _print_verbose_run_summary(*, label: str, summary: dict[str, Any]) -> None:
    print(f"==> verbose[{label}] selected_mechanism: {summary.get('mechanism')}")
    print(f"==> verbose[{label}] final_answer: {summary.get('final_answer')}")
    print(f"==> verbose[{label}] confidence: {summary.get('confidence')}")
    print(f"==> verbose[{label}] round_count: {summary.get('round_count')}")
    print(f"==> verbose[{label}] mechanism_switches: {summary.get('mechanism_switches')}")
    print(f"==> verbose[{label}] total_tokens_used: {summary.get('total_tokens_used')}")
    print(f"==> verbose[{label}] latency_ms: {summary.get('latency_ms')}")
    print(f"==> verbose[{label}] event_count: {summary.get('event_count')}")
    print(f"==> verbose[{label}] event_types: {summary.get('event_types') or []}")
    print(f"==> verbose[{label}] event_span_seconds: {summary.get('event_span_seconds')}")
    latest_events = summary.get("latest_events") or []
    if latest_events:
        print(f"==> verbose[{label}] latest_events: {latest_events}")
    print(
        f"==> verbose[{label}] agent_models_used: "
        f"{summary.get('agent_models_used') or []}"
    )
    verification = summary.get("receipt_verification") or {}
    print(
        f"==> verbose[{label}] receipt_verification: "
        f"merkle_match={verification.get('merkle_match')} "
        f"hosted_metadata_match={verification.get('hosted_metadata_match')}"
    )
    print(
        f"==> verbose[{label}] acceptance_checks: "
        f"{summary.get('acceptance_checks') or {}}"
    )


def _ensure_output_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _float_equal(left: float, right: float, *, tolerance: float = 1e-9) -> bool:
    return abs(left - right) <= tolerance


def _enforce_strict_defaults(args: argparse.Namespace) -> None:
    """Fail closed unless explicit override escape hatch is enabled."""

    if args.allow_unsafe_overrides:
        return

    violations: list[str] = []
    if not _float_equal(float(args.stakes), DEFAULT_STAKES):
        violations.append(f"--stakes must be {DEFAULT_STAKES}")
    if int(args.agent_count) != DEFAULT_AGENT_COUNT:
        violations.append(f"--agent-count must be {DEFAULT_AGENT_COUNT}")
    if str(args.mechanism).lower() != DEFAULT_MECHANISM:
        violations.append(f"--mechanism must be {DEFAULT_MECHANISM}")

    if violations:
        raise RuntimeError(
            "Strict phase 2 demo defaults are enforced unless --allow-unsafe-overrides is set:\n- "
            + "\n- ".join(violations)
        )


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return int(sock.getsockname()[1])


def _run(
    command: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    check: bool = True,
    capture_output: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=str(cwd) if cwd is not None else None,
        env=env,
        check=check,
        text=True,
        capture_output=capture_output,
    )


def _build_sdk_wheel() -> Path:
    if importlib.util.find_spec("build") is not None:
        _run([sys.executable, "-m", "build", "sdk"], cwd=REPO_ROOT)
    else:
        _run(
            [
                sys.executable,
                "-m",
                "pip",
                "wheel",
                "--no-deps",
                "--wheel-dir",
                str(REPO_ROOT / "sdk" / "dist"),
                str(REPO_ROOT / "sdk"),
            ],
            cwd=REPO_ROOT,
        )
    wheels = sorted(
        (REPO_ROOT / "sdk" / "dist").glob("*.whl"),
        key=lambda path: path.stat().st_mtime,
    )
    if not wheels:
        raise RuntimeError("SDK build did not produce a wheel in sdk/dist")
    return wheels[-1]


def _create_throwaway_venv(venv_dir: Path, wheel_path: Path) -> Path:
    _run([sys.executable, "-m", "venv", str(venv_dir)])
    venv_python = venv_dir / "bin" / "python"
    _run([str(venv_python), "-m", "pip", "install", "--upgrade", "pip"])
    _run([str(venv_python), "-m", "pip", "install", "--force-reinstall", str(wheel_path)])
    return venv_python


def _wait_for_health(base_url: str, *, timeout_seconds: float = 45.0) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with httpx.Client(base_url=base_url, timeout=5.0) as client:
                response = client.get("/health")
                response.raise_for_status()
                return response.json()
        except Exception as exc:  # pragma: no cover - timing dependent
            last_error = exc
            time.sleep(1.0)
    raise RuntimeError(f"Local API did not become healthy: {last_error}")


def _request_json(
    client: httpx.Client,
    method: str,
    path: str,
    *,
    token: str | None = None,
    json_body: dict[str, Any] | None = None,
    expected_status: int = 200,
) -> dict[str, Any]:
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    response = client.request(method, path, headers=headers, json=json_body)
    if response.status_code != expected_status:
        raise RuntimeError(
            f"{method} {path} returned {response.status_code}: {response.text}"
        )
    return response.json()


def _request_json_with_retry(
    *,
    base_url: str,
    method: str,
    path: str,
    timeout_seconds: float,
    retries: int,
    token: str | None = None,
    json_body: dict[str, Any] | None = None,
    expected_status: int = 200,
    label: str = "request",
    verbose: bool = False,
) -> dict[str, Any]:
    if retries < 1:
        raise ValueError("retries must be >= 1")

    last_error: str | None = None
    for attempt in range(1, retries + 1):
        headers: dict[str, str] = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        try:
            with httpx.Client(base_url=base_url, timeout=timeout_seconds) as client:
                response = client.request(method, path, headers=headers, json=json_body)

            if response.status_code == expected_status:
                return response.json()

            last_error = f"{method} {path} returned {response.status_code}: {response.text}"
            retriable_status = response.status_code >= 500 or response.status_code == 429
            if retriable_status and attempt < retries:
                if verbose:
                    print(
                        f"==> retry[{label}] attempt={attempt + 1}/{retries} "
                        f"after status {response.status_code}"
                    )
                time.sleep(min(2 ** (attempt - 1), 5))
                continue

            raise RuntimeError(last_error)
        except httpx.HTTPError as exc:
            last_error = str(exc)
            if attempt < retries:
                if verbose:
                    print(
                        f"==> retry[{label}] attempt={attempt + 1}/{retries} "
                        f"after transport error: {exc}"
                    )
                time.sleep(min(2 ** (attempt - 1), 5))
                continue

            raise RuntimeError(
                f"{method} {path} failed after {retries} attempts: {exc}"
            ) from exc

    raise RuntimeError(f"{label} failed after retries: {last_error}")


def _expected_models() -> list[str]:
    runtime_get_config, _, _ = _runtime_bindings()
    cfg = runtime_get_config()
    return [
        cfg.pro_model,
        cfg.kimi_model,
        cfg.flash_model,
        cfg.claude_model,
    ]


def _preflight() -> dict[str, Any]:
    runtime_get_config, runtime_settings, runtime_bridge = _runtime_bindings()
    cfg = runtime_get_config()
    failures: list[str] = []
    if not cfg.gemini_api_key:
        failures.append("Gemini credential not resolved")
    if not cfg.anthropic_api_key:
        failures.append("Anthropic credential not resolved")
    if not cfg.openrouter_api_key:
        failures.append("OpenRouter credential not resolved")
    if not runtime_bridge.is_configured():
        failures.append(
            "Solana bridge is not configured with a real HELIUS_RPC_URL and keypair source"
        )

    network = runtime_settings.solana_network.strip().lower()
    if network != DEFAULT_SOLANA_NETWORK:
        failures.append(
            "Strict phase 2 demo requires devnet. "
            f"Configured network={runtime_settings.solana_network!r}."
        )

    if failures:
        raise RuntimeError("Phase 2 demo preflight failed:\n- " + "\n- ".join(failures))
    return {
        "expected_models": _expected_models(),
        "helius_rpc_url": runtime_settings.helius_rpc_url,
        "program_id": runtime_settings.program_id,
        "solana_network": network,
    }


def _start_api_process(
    temp_root: Path,
    port: int,
    *,
    mechanism: str,
) -> tuple[subprocess.Popen[str], Path]:
    log_path = temp_root / "phase2_demo_api.log"
    log_file = log_path.open("w", encoding="utf-8")
    env = os.environ.copy()
    env.update(
        {
            "AUTH_REQUIRED": "false",
            "DEMO_MODE": "true",
            "AGORA_ENVIRONMENT": "development",
            "STRICT_CHAIN_WRITES": "true",
            "AGORA_API_FORCE_MECHANISM": mechanism,
            "AGORA_LOCAL_DATA_DIR": str(temp_root / "api-data"),
            # Keep local strict demo state on disk instead of GCS to avoid ADC reauth drift.
            "GOOGLE_CLOUD_PROJECT": "",
            "AGORA_API_KEY_PEPPER": secrets.token_hex(32),
        }
    )
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "api.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=REPO_ROOT,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return process, log_path


def _terminate_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:  # pragma: no cover - defensive cleanup
        process.kill()
        process.wait(timeout=5)


def _sdk_runner_script(path: Path) -> None:
    script = textwrap.dedent(
        """
        import argparse
        import asyncio
        import inspect
        import json
        from pathlib import Path

        import agora
        from agora.sdk import AgoraArbitrator


        def parse_args() -> argparse.Namespace:
            parser = argparse.ArgumentParser()
            parser.add_argument("--api-url", required=True)
            parser.add_argument("--token", required=True)
            parser.add_argument("--task", required=True)
            parser.add_argument("--stakes", type=float, required=True)
            parser.add_argument("--agent-count", type=int, required=True)
            parser.add_argument("--mechanism", required=True)
            parser.add_argument("--output", required=True)
            return parser.parse_args()


        async def main() -> None:
            args = parse_args()
            arbitrator = AgoraArbitrator(
                api_url=args.api_url,
                auth_token=args.token,
                mechanism=args.mechanism,
                agent_count=args.agent_count,
                strict_verification=False,
            )
            try:
                created = await arbitrator.create_task(args.task, stakes=args.stakes)
                status_after_create = await arbitrator.get_task_status(
                    created.task_id,
                    detailed=True,
                )
                run_result = await arbitrator.run_task(created.task_id)
                status_after_run = await arbitrator.get_task_status(
                    created.task_id,
                    detailed=True,
                )
                result = await arbitrator.get_task_result(created.task_id)
                verification = await arbitrator.verify_receipt(result, strict=False)
                payment = await arbitrator.release_payment(created.task_id)
                status_after_pay = await arbitrator.get_task_status(
                    created.task_id,
                    detailed=True,
                )
                payload = {
                    "created": created.model_dump(mode="json"),
                    "run_result": run_result.model_dump(mode="json"),
                    "status_after_create": status_after_create.model_dump(mode="json"),
                    "status_after_run": status_after_run.model_dump(mode="json"),
                    "status_after_pay": status_after_pay.model_dump(mode="json"),
                    "deliberation_result": result.model_dump(mode="json"),
                    "receipt_verification": verification,
                    "payment": payment.model_dump(mode="json"),
                    "latest_task_id": arbitrator.latest_task_id,
                    "task_id_for_result": arbitrator.task_id_for_result(result),
                    "module_paths": {
                        "agora": str(Path(agora.__file__).resolve()),
                        "arbitrator": str(Path(inspect.getfile(AgoraArbitrator)).resolve()),
                    },
                }
            finally:
                await arbitrator.aclose()

            output_path = Path(args.output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


        asyncio.run(main())
        """
    ).strip()
    path.write_text(script + "\n", encoding="utf-8")


def _run_sdk_flow(
    venv_python: Path,
    *,
    base_url: str,
    token: str,
    task: str,
    stakes: float,
    agent_count: int,
    mechanism: str,
    output_path: Path,
) -> tuple[dict[str, Any], subprocess.CompletedProcess[str]]:
    runner_path = output_path.parent / "phase2_demo_sdk_runner.py"
    _sdk_runner_script(runner_path)
    runner_env = os.environ.copy()
    runner_env.pop("PYTHONPATH", None)
    result = _run(
        [
            str(venv_python),
            str(runner_path),
            "--api-url",
            base_url,
            "--token",
            token,
            "--task",
            task,
            "--stakes",
            str(stakes),
            "--agent-count",
            str(agent_count),
            "--mechanism",
            mechanism,
            "--output",
            str(output_path),
        ],
        cwd=output_path.parent,
        env=runner_env,
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "Installed SDK runner failed.\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
    if not output_path.exists():
        raise RuntimeError(
            "Installed SDK runner did not write "
            f"{output_path}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return json.loads(output_path.read_text(encoding="utf-8")), result


def _assert_installed_sdk_provenance(sdk_flow: dict[str, Any]) -> dict[str, str]:
    """Require SDK imports to resolve from the throwaway venv site-packages."""

    module_paths = sdk_flow.get("module_paths")
    if not isinstance(module_paths, dict):
        raise RuntimeError("SDK runner payload missing module_paths provenance")

    resolved: dict[str, str] = {}
    repo_root = str(REPO_ROOT.resolve())
    for label in ("agora", "arbitrator"):
        raw_path = module_paths.get(label)
        if not isinstance(raw_path, str) or not raw_path:
            raise RuntimeError(f"SDK runner module path missing for {label}")
        module_path = str(Path(raw_path).resolve())
        if repo_root in module_path:
            raise RuntimeError(
                f"Installed SDK runner imported {label} from repository source: {module_path}"
            )
        if "site-packages" not in Path(module_path).parts:
            raise RuntimeError(
                f"Installed SDK runner imported {label} from non-site-packages path: {module_path}"
            )
        resolved[label] = module_path

    return resolved


def _confirm_transaction(
    rpc_url: str,
    signature: str,
    *,
    timeout_seconds: float = 60.0,
) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    request_body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTransaction",
        "params": [
            signature,
            {
                "encoding": "json",
                "commitment": "confirmed",
                "maxSupportedTransactionVersion": 0,
            },
        ],
    }
    last_payload: dict[str, Any] | None = None
    with httpx.Client(timeout=10.0) as client:
        while time.time() < deadline:
            response = client.post(rpc_url, json=request_body)
            response.raise_for_status()
            payload = response.json()
            last_payload = payload
            if payload.get("result") is not None:
                return payload["result"]
            time.sleep(2.0)
    raise RuntimeError(f"Timed out waiting for transaction {signature}: {last_payload}")


def _assert_demo_expectations(
    *,
    expected_models: list[str] | None,
    required_model_count: int,
    sdk_flow: dict[str, Any],
) -> dict[str, Any]:
    status_after_create = sdk_flow["status_after_create"]
    status_after_run = sdk_flow["status_after_run"]
    status_after_pay = sdk_flow["status_after_pay"]
    verification = sdk_flow["receipt_verification"]

    if status_after_create.get("solana_tx_hash") is None:
        raise RuntimeError("Task create did not record an initialize-task Solana tx hash")
    if status_after_run.get("solana_tx_hash") is None:
        raise RuntimeError("Task run did not record a receipt-submission Solana tx hash")
    if status_after_pay.get("solana_tx_hash") is None:
        raise RuntimeError("Task pay did not record a release-payment Solana tx hash")
    if status_after_pay.get("status") != "paid":
        raise RuntimeError(f"Expected final task status paid, got {status_after_pay.get('status')}")
    if status_after_pay.get("payment_status") != "released":
        raise RuntimeError(
            f"Expected final payment_status released, got {status_after_pay.get('payment_status')}"
        )
    if not verification.get("merkle_match"):
        raise RuntimeError("SDK receipt verification failed merkle_match")
    if verification.get("hosted_metadata_match") is not True:
        raise RuntimeError("SDK receipt verification failed hosted_metadata_match")

    reported_models = status_after_run.get("result", {}).get("agent_models_used") or []
    if expected_models:
        missing = sorted(set(expected_models) - set(reported_models))
        if missing:
            raise RuntimeError(f"Strict demo did not report all expected models: {missing}")
    elif len(set(reported_models)) < required_model_count:
        raise RuntimeError(
            "Strict demo reported fewer models than required. "
            f"required={required_model_count} observed={reported_models}"
        )

    return {
        "initialize_tx_hash": status_after_create["solana_tx_hash"],
        "initialize_explorer_url": status_after_create.get("explorer_url"),
        "receipt_tx_hash": status_after_run["solana_tx_hash"],
        "receipt_explorer_url": status_after_run.get("explorer_url"),
        "payment_tx_hash": status_after_pay["solana_tx_hash"],
        "payment_explorer_url": status_after_pay.get("explorer_url"),
        "agent_models_used": reported_models,
    }


def _preflight_hosted(
    args: argparse.Namespace,
) -> tuple[dict[str, Any], str, dict[str, Any] | None]:
    token, token_source, bootstrap_summary = _resolve_hosted_auth_context(args)

    helius_rpc_url = os.getenv("HELIUS_RPC_URL", "").strip() or os.getenv("HELIUS_URL", "").strip()
    if not helius_rpc_url or "YOUR_KEY" in helius_rpc_url:
        raise RuntimeError(
            "Hosted phase 2 demo requires a real HELIUS RPC URL for transaction confirmation."
        )

    expected_models = _resolve_expected_models_from_env()
    token_hint = token.split(".", 1)[0]
    preflight = {
        "target": "hosted",
        "api_url": args.api_url.rstrip("/"),
        "helius_rpc_url": helius_rpc_url,
        "solana_network": DEFAULT_SOLANA_NETWORK,
        "expected_models": expected_models or [],
        "auth_token_hint": token_hint,
        "auth_token_source": token_source,
    }
    return preflight, token, bootstrap_summary


def main() -> None:
    args = _parse_args()
    if args.http_timeout_seconds <= 0:
        raise RuntimeError("--http-timeout-seconds must be > 0")
    if args.http_retries < 1:
        raise RuntimeError("--http-retries must be >= 1")

    output_path = Path(args.output).resolve()
    _ensure_output_parent(output_path)
    temp_parent = Path(args.temp_root).expanduser().resolve()
    temp_parent.mkdir(parents=True, exist_ok=True)

    artifact: dict[str, Any] = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "query": args.query,
        "stakes": args.stakes,
        "agent_count": args.agent_count,
        "mechanism": args.mechanism,
        "target": args.target,
        "strict_defaults_enforced": not args.allow_unsafe_overrides,
        "status": "running",
    }
    if args.target == "hosted":
        artifact["api_url"] = args.api_url.rstrip("/")

    temp_root = Path(
        tempfile.mkdtemp(prefix="agora-phase2-demo-", dir=str(temp_parent))
    )
    artifact["temp_root"] = str(temp_root)

    api_process: subprocess.Popen[str] | None = None
    try:
        print("==> bootstrapping credential context (env + Secret Manager)")
        artifact["credential_bootstrap"] = _bootstrap_credentials_for_phase2_demo()
        _initialize_runtime_bindings()

        _enforce_strict_defaults(args)
        hosted_token = ""
        hosted_auth_bootstrap: dict[str, Any] | None = None
        if args.target == "local":
            preflight = _preflight()
        else:
            preflight, hosted_token, hosted_auth_bootstrap = _preflight_hosted(args)
        artifact["preflight"] = preflight
        if hosted_auth_bootstrap is not None:
            artifact["hosted_auth_bootstrap"] = hosted_auth_bootstrap

        print("==> building local SDK wheel")
        wheel_path = _build_sdk_wheel()
        artifact["wheel_path"] = str(wheel_path)

        print("==> creating throwaway SDK venv")
        venv_python = _create_throwaway_venv(temp_root / "sdk-venv", wheel_path)
        artifact["sdk_venv_python"] = str(venv_python)

        if args.target == "local":
            port = _free_port()
            base_url = f"http://127.0.0.1:{port}"
            print(f"==> starting local API on {base_url}")
            api_process, api_log_path = _start_api_process(
                temp_root,
                port,
                mechanism=args.mechanism,
            )
            artifact["api_log_path"] = str(api_log_path)

            health = _wait_for_health(base_url)
            artifact["health"] = health
            print("==> local API healthy")

            with httpx.Client(base_url=base_url, timeout=30.0) as client:
                print("==> bootstrapping demo human session")
                auth_me_payload = _request_json(client, "GET", "/auth/me")
                artifact["demo_auth_me"] = auth_me_payload

                workspace_payload = auth_me_payload.get("workspace")
                if not isinstance(workspace_payload, dict) or not workspace_payload.get("id"):
                    raise RuntimeError("/auth/me did not return a real workspace payload")
                artifact["workspace_id"] = str(workspace_payload["id"])

                print("==> creating real workspace API key through /api-keys")
                api_key_payload = _request_json(
                    client,
                    "POST",
                    "/api-keys/",
                    json_body={"name": "phase2-demo"},
                )
                artifact["api_key_metadata"] = api_key_payload["metadata"]
                api_key = str(api_key_payload["api_key"])
                if not api_key.startswith("agora_test_"):
                    raise RuntimeError(
                        "Strict local demo expected a non-production API key prefix (agora_test_)"
                    )

                metadata = api_key_payload.get("metadata")
                if isinstance(metadata, dict):
                    artifact["api_key_public_id"] = str(metadata.get("public_id", ""))
                    artifact["api_key_id"] = str(metadata.get("key_id", ""))

                print("==> running installed-wheel SDK against the local API")
                sdk_output_path = temp_root / "phase2_demo_sdk_output.json"
                sdk_flow, sdk_result = _run_sdk_flow(
                    venv_python,
                    base_url=base_url,
                    token=api_key,
                    task=args.query,
                    stakes=args.stakes,
                    agent_count=args.agent_count,
                    mechanism=args.mechanism,
                    output_path=sdk_output_path,
                )
                artifact["sdk_flow"] = sdk_flow
                artifact["sdk_runner_stdout"] = sdk_result.stdout
                artifact["sdk_runner_stderr"] = sdk_result.stderr
                artifact["sdk_module_paths"] = _assert_installed_sdk_provenance(sdk_flow)
                event_timeline = _build_event_timeline(sdk_flow)
                artifact["event_timeline"] = event_timeline
                artifact["acceptance_checks"] = _build_acceptance_checks(sdk_flow)
                artifact["status_snapshots"] = _build_status_snapshots(sdk_flow)
                run_summary = _build_run_summary(sdk_flow, event_timeline=event_timeline)
                artifact["run_summary"] = run_summary

                if args.verbose:
                    _print_verbose_run_summary(label="local", summary=run_summary)

                created_payload = sdk_flow.get("created", {})
                status_after_run = sdk_flow.get("status_after_run", {})
                status_after_pay = sdk_flow.get("status_after_pay", {})
                if isinstance(created_payload, dict):
                    artifact["task_id"] = str(created_payload.get("task_id", ""))
                if isinstance(status_after_run, dict):
                    artifact["selected_mechanism"] = str(status_after_run.get("mechanism", ""))
                if isinstance(status_after_pay, dict):
                    artifact["final_status"] = str(status_after_pay.get("status", ""))
                    artifact["payment_status"] = str(status_after_pay.get("payment_status", ""))

                receipt_verification = sdk_flow.get("receipt_verification")
                if isinstance(receipt_verification, dict):
                    artifact["receipt_verification"] = receipt_verification

                tx_summary = _assert_demo_expectations(
                    expected_models=preflight["expected_models"],
                    required_model_count=args.agent_count,
                    sdk_flow=sdk_flow,
                )
                artifact["tx_summary"] = tx_summary
                artifact["agent_models_used"] = tx_summary["agent_models_used"]
                artifact["initialize_tx_hash"] = tx_summary["initialize_tx_hash"]
                artifact["initialize_explorer_url"] = tx_summary.get("initialize_explorer_url")
                artifact["receipt_tx_hash"] = tx_summary["receipt_tx_hash"]
                artifact["receipt_explorer_url"] = tx_summary.get("receipt_explorer_url")
                artifact["payment_tx_hash"] = tx_summary["payment_tx_hash"]
                artifact["payment_explorer_url"] = tx_summary.get("payment_explorer_url")

                print("==> confirming initialize, receipt, and payment transactions on devnet")
                artifact["chain_confirmations"] = {
                    "initialize": _confirm_transaction(
                        preflight["helius_rpc_url"],
                        tx_summary["initialize_tx_hash"],
                    ),
                    "receipt": _confirm_transaction(
                        preflight["helius_rpc_url"],
                        tx_summary["receipt_tx_hash"],
                    ),
                    "payment": _confirm_transaction(
                        preflight["helius_rpc_url"],
                        tx_summary["payment_tx_hash"],
                    ),
                }

                print("==> revoking API key and proving reuse is rejected")
                revoke_payload = _request_json(
                    client,
                    "POST",
                    f"/api-keys/{artifact['api_key_metadata']['key_id']}/revoke",
                )
                artifact["api_key_revocation"] = revoke_payload

                rejected = client.get(
                    "/auth/me",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if rejected.status_code != 401:
                    raise RuntimeError(
                        "Expected revoked API key to fail with 401, "
                        f"got {rejected.status_code}: {rejected.text}"
                    )
                artifact["revoked_key_reuse_status"] = rejected.status_code
                artifact["revocation_proof"] = {
                    "api_key_id": str(
                        artifact.get("api_key_id") or artifact["api_key_metadata"].get("key_id", "")
                    ),
                    "revoked_at": revoke_payload.get("revoked_at"),
                    "reuse_http_status": rejected.status_code,
                }
        else:
            base_url = str(preflight["api_url"])
            print(f"==> checking hosted API health at {base_url}")
            artifact["health"] = _request_json_with_retry(
                base_url=base_url,
                method="GET",
                path="/health",
                timeout_seconds=args.http_timeout_seconds,
                retries=args.http_retries,
                label="hosted-health",
                verbose=args.verbose,
            )

            print("==> validating hosted API key via /auth/me")
            auth_me_payload = _request_json_with_retry(
                base_url=base_url,
                method="GET",
                path="/auth/me",
                token=hosted_token,
                timeout_seconds=args.http_timeout_seconds,
                retries=args.http_retries,
                label="hosted-auth-me",
                verbose=args.verbose,
            )
            artifact["demo_auth_me"] = auth_me_payload

            workspace_payload = auth_me_payload.get("workspace")
            if not isinstance(workspace_payload, dict) or not workspace_payload.get("id"):
                raise RuntimeError(
                    "Hosted /auth/me did not return a workspace payload for the provided token"
                )
            artifact["workspace_id"] = str(workspace_payload["id"])

            print("==> running installed-wheel SDK against hosted API")
            sdk_output_path = temp_root / "phase2_demo_sdk_output_hosted.json"
            sdk_flow, sdk_result = _run_sdk_flow(
                venv_python,
                base_url=base_url,
                token=hosted_token,
                task=args.query,
                stakes=args.stakes,
                agent_count=args.agent_count,
                mechanism=args.mechanism,
                output_path=sdk_output_path,
            )
            artifact["sdk_flow"] = sdk_flow
            artifact["sdk_runner_stdout"] = sdk_result.stdout
            artifact["sdk_runner_stderr"] = sdk_result.stderr
            artifact["sdk_module_paths"] = _assert_installed_sdk_provenance(sdk_flow)
            event_timeline = _build_event_timeline(sdk_flow)
            artifact["event_timeline"] = event_timeline
            artifact["acceptance_checks"] = _build_acceptance_checks(sdk_flow)
            artifact["status_snapshots"] = _build_status_snapshots(sdk_flow)
            run_summary = _build_run_summary(sdk_flow, event_timeline=event_timeline)
            artifact["run_summary"] = run_summary

            if args.verbose:
                _print_verbose_run_summary(label="hosted", summary=run_summary)

            created_payload = sdk_flow.get("created", {})
            status_after_run = sdk_flow.get("status_after_run", {})
            status_after_pay = sdk_flow.get("status_after_pay", {})
            if isinstance(created_payload, dict):
                artifact["task_id"] = str(created_payload.get("task_id", ""))
            if isinstance(status_after_run, dict):
                artifact["selected_mechanism"] = str(status_after_run.get("mechanism", ""))
            if isinstance(status_after_pay, dict):
                artifact["final_status"] = str(status_after_pay.get("status", ""))
                artifact["payment_status"] = str(status_after_pay.get("payment_status", ""))

            receipt_verification = sdk_flow.get("receipt_verification")
            if isinstance(receipt_verification, dict):
                artifact["receipt_verification"] = receipt_verification

            expected_models = preflight.get("expected_models") or None
            tx_summary = _assert_demo_expectations(
                expected_models=expected_models,
                required_model_count=args.agent_count,
                sdk_flow=sdk_flow,
            )
            artifact["tx_summary"] = tx_summary
            artifact["agent_models_used"] = tx_summary["agent_models_used"]
            artifact["initialize_tx_hash"] = tx_summary["initialize_tx_hash"]
            artifact["initialize_explorer_url"] = tx_summary.get("initialize_explorer_url")
            artifact["receipt_tx_hash"] = tx_summary["receipt_tx_hash"]
            artifact["receipt_explorer_url"] = tx_summary.get("receipt_explorer_url")
            artifact["payment_tx_hash"] = tx_summary["payment_tx_hash"]
            artifact["payment_explorer_url"] = tx_summary.get("payment_explorer_url")

            print("==> confirming initialize, receipt, and payment transactions on devnet")
            artifact["chain_confirmations"] = {
                "initialize": _confirm_transaction(
                    preflight["helius_rpc_url"],
                    tx_summary["initialize_tx_hash"],
                ),
                "receipt": _confirm_transaction(
                    preflight["helius_rpc_url"],
                    tx_summary["receipt_tx_hash"],
                ),
                "payment": _confirm_transaction(
                    preflight["helius_rpc_url"],
                    tx_summary["payment_tx_hash"],
                ),
            }

            artifact["revoked_key_reuse_status"] = None
            artifact["revocation_proof"] = {
                "status": "skipped",
                "reason": (
                    "Hosted target uses a pre-issued token. "
                    "API key issuance/revocation proof is validated in local target mode."
                ),
            }

        artifact["status"] = "passed"
        artifact["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        output_path.write_text(json.dumps(artifact, indent=2), encoding="utf-8")
        print(f"==> phase 2 strict demo passed; artifact written to {output_path}")
    except Exception as exc:
        artifact["status"] = "failed"
        artifact["error"] = str(exc)
        artifact["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        output_path.write_text(json.dumps(artifact, indent=2), encoding="utf-8")
        raise
    finally:
        if api_process is not None:
            _terminate_process(api_process)
        if artifact.get("status") == "passed" and not args.keep_temp:
            shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
