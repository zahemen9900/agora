"""Runtime settings for the Agora API service."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_REPO_ROOT = Path(__file__).resolve().parents[1]
_SETTINGS_ENV_FILES = (
    str(_REPO_ROOT / ".env"),
    str(_REPO_ROOT / ".env.development"),
)


class Settings(BaseSettings):
    """Environment-driven API settings."""

    model_config = SettingsConfigDict(
        env_file=_SETTINGS_ENV_FILES,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    helius_rpc_url: str = Field(
        default="https://devnet.helius-rpc.com/?api-key=YOUR_KEY",
        validation_alias=AliasChoices("HELIUS_RPC_URL", "HELIUS_URL"),
    )
    solana_keypair_path: str = "~/.config/solana/devnet-keypair.json"
    solana_keypair_secret_name: str = ""
    solana_keypair_secret_project: str = ""
    solana_keypair_secret_version: str = "latest"
    solana_network: str = "devnet"
    program_id: str = "82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd"

    google_cloud_project: str = ""
    gcs_bucket: str = ""
    source_upload_expiry_minutes: int = Field(
        default=15,
        ge=1,
        le=60,
        validation_alias=AliasChoices(
            "AGORA_SOURCE_UPLOAD_EXPIRY_MINUTES",
            "SOURCE_UPLOAD_EXPIRY_MINUTES",
        ),
    )
    source_max_file_bytes: int = Field(
        default=5 * 1024 * 1024,
        ge=1,
        le=25_000_000,
        validation_alias=AliasChoices(
            "AGORA_SOURCE_MAX_FILE_BYTES",
            "SOURCE_MAX_FILE_BYTES",
        ),
    )
    source_max_attachments_per_task: int = Field(
        default=3,
        ge=1,
        le=10,
        validation_alias=AliasChoices(
            "AGORA_SOURCE_MAX_ATTACHMENTS_PER_TASK",
            "SOURCE_MAX_ATTACHMENTS_PER_TASK",
        ),
    )
    local_data_dir: str = Field(
        default="api/data",
        validation_alias=AliasChoices("AGORA_LOCAL_DATA_DIR", "LOCAL_DATA_DIR"),
    )
    api_force_mechanism: str = Field(
        default="",
        validation_alias=AliasChoices("AGORA_API_FORCE_MECHANISM", "API_FORCE_MECHANISM"),
    )

    auth_required: bool = True
    demo_mode: bool = False
    environment: str = Field(
        default="development",
        validation_alias=AliasChoices("AGORA_ENVIRONMENT", "ENVIRONMENT"),
    )
    benchmark_admin_token: str = ""
    stream_ticket_ttl_seconds: int = Field(default=60, ge=5, le=600)
    task_run_lock_ttl_seconds: int = Field(default=900, ge=30, le=86_400)
    background_recovery_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "AGORA_BACKGROUND_RECOVERY_ENABLED",
            "BACKGROUND_RECOVERY_ENABLED",
        ),
    )
    background_recovery_poll_seconds: int = Field(
        default=30,
        ge=5,
        le=3_600,
        validation_alias=AliasChoices(
            "AGORA_BACKGROUND_RECOVERY_POLL_SECONDS",
            "BACKGROUND_RECOVERY_POLL_SECONDS",
        ),
    )
    background_recovery_stale_seconds: int = Field(
        default=420,
        ge=30,
        le=86_400,
        validation_alias=AliasChoices(
            "AGORA_BACKGROUND_RECOVERY_STALE_SECONDS",
            "BACKGROUND_RECOVERY_STALE_SECONDS",
        ),
    )
    background_recovery_scan_limit: int = Field(
        default=500,
        ge=1,
        le=10_000,
        validation_alias=AliasChoices(
            "AGORA_BACKGROUND_RECOVERY_SCAN_LIMIT",
            "BACKGROUND_RECOVERY_SCAN_LIMIT",
        ),
    )
    task_create_rate_limit_per_minute: int = Field(
        default=60,
        ge=0,
        le=10_000,
        validation_alias=AliasChoices(
            "AGORA_TASK_CREATE_RATE_LIMIT_PER_MINUTE",
            "TASK_CREATE_RATE_LIMIT_PER_MINUTE",
        ),
    )
    task_run_rate_limit_per_minute: int = Field(
        default=30,
        ge=0,
        le=10_000,
        validation_alias=AliasChoices(
            "AGORA_TASK_RUN_RATE_LIMIT_PER_MINUTE",
            "TASK_RUN_RATE_LIMIT_PER_MINUTE",
        ),
    )
    workspace_concurrent_task_runs: int = Field(
        default=4,
        ge=0,
        le=1_000,
        validation_alias=AliasChoices(
            "AGORA_WORKSPACE_CONCURRENT_TASK_RUNS",
            "WORKSPACE_CONCURRENT_TASK_RUNS",
        ),
    )
    coordination_backend: str = Field(
        default="memory",
        validation_alias=AliasChoices("AGORA_COORDINATION_BACKEND", "COORDINATION_BACKEND"),
    )
    redis_url: str = Field(
        default="",
        validation_alias=AliasChoices("AGORA_REDIS_URL", "REDIS_URL"),
    )
    coordination_namespace: str = Field(
        default="agora",
        validation_alias=AliasChoices(
            "AGORA_COORDINATION_NAMESPACE",
            "COORDINATION_NAMESPACE",
        ),
    )
    webhook_secret: str = Field(
        default="",
        validation_alias=AliasChoices("AGORA_WEBHOOK_SECRET", "WEBHOOK_SECRET"),
    )
    webhook_max_bytes: int = Field(default=262_144, ge=1024)
    webhook_timestamp_skew_seconds: int = Field(default=300, ge=5, le=3600)
    webhook_replay_ttl_seconds: int = Field(default=900, ge=30, le=86_400)
    strict_chain_writes: bool = False
    workos_client_id: str = Field(
        default="",
        validation_alias=AliasChoices("AGORA_WORKOS_CLIENT_ID", "WORKOS_CLIENT_ID"),
    )
    workos_authkit_domain: str = Field(
        default="",
        validation_alias=AliasChoices("AGORA_WORKOS_AUTHKIT_DOMAIN", "WORKOS_AUTHKIT_DOMAIN"),
    )
    auth_issuer: str = Field(
        default="",
        validation_alias=AliasChoices("AGORA_AUTH_ISSUER", "AUTH_ISSUER"),
    )
    auth_audience: str = Field(
        default="",
        validation_alias=AliasChoices("AGORA_AUTH_AUDIENCE", "AUTH_AUDIENCE"),
    )
    auth_audiences: str = Field(
        default="",
        validation_alias=AliasChoices("AGORA_AUTH_AUDIENCES", "AUTH_AUDIENCES"),
    )
    auth_jwks_url: str = Field(
        default="",
        validation_alias=AliasChoices("AGORA_AUTH_JWKS_URL", "AUTH_JWKS_URL"),
    )
    api_key_pepper: str = Field(
        default="",
        validation_alias=AliasChoices("AGORA_API_KEY_PEPPER", "API_KEY_PEPPER"),
    )
    api_key_default_ttl_days: int = Field(
        default=365,
        ge=0,
        validation_alias=AliasChoices("AGORA_API_KEY_DEFAULT_TTL_DAYS", "API_KEY_DEFAULT_TTL_DAYS"),
    )
    sandbox_runner_url: str = Field(
        default="",
        validation_alias=AliasChoices("AGORA_SANDBOX_RUNNER_URL", "SANDBOX_RUNNER_URL"),
    )
    sandbox_runner_bearer_token: str = Field(
        default="",
        validation_alias=AliasChoices(
            "AGORA_SANDBOX_RUNNER_BEARER_TOKEN",
            "SANDBOX_RUNNER_BEARER_TOKEN",
        ),
    )
    sandbox_execution_timeout_seconds: int = Field(
        default=20,
        ge=1,
        le=30,
        validation_alias=AliasChoices(
            "AGORA_SANDBOX_EXECUTION_TIMEOUT_SECONDS",
            "SANDBOX_EXECUTION_TIMEOUT_SECONDS",
        ),
    )
    axiom_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices("AGORA_AXIOM_ENABLED", "AXIOM_ENABLED"),
    )
    axiom_token: str = Field(
        default="",
        validation_alias=AliasChoices("AGORA_AXIOM_TOKEN", "AXIOM_TOKEN"),
    )
    axiom_traces_dataset: str = Field(
        default="",
        validation_alias=AliasChoices(
            "AGORA_AXIOM_TRACES_DATASET",
            "AXIOM_DATASET",
        ),
    )
    axiom_base_url: str = Field(
        default="",
        validation_alias=AliasChoices(
            "AGORA_AXIOM_BASE_URL",
            "AXIOM_EDGE_URL",
        ),
    )
    axiom_domain: str = Field(
        default="",
        validation_alias=AliasChoices("AXIOM_DOMAIN"),
    )
    axiom_sample_ratio: float = Field(
        default=1.0,
        ge=0.0,
        le=1.0,
        validation_alias=AliasChoices("AGORA_AXIOM_SAMPLE_RATIO", "AXIOM_SAMPLE_RATIO"),
    )
    axiom_capture_content: Literal["metadata_only", "full"] = Field(
        default="metadata_only",
        validation_alias=AliasChoices(
            "AGORA_AXIOM_CAPTURE_CONTENT",
            "AXIOM_CAPTURE_CONTENT",
        ),
    )


settings = Settings()
