"""Runtime settings for the Agora API service."""

from __future__ import annotations

from pathlib import Path

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
    gcs_bucket: str = "agora-data"
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


settings = Settings()
