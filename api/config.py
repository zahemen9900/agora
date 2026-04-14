"""Runtime settings for the Agora API service."""

from __future__ import annotations

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-driven API settings."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    helius_rpc_url: str = "https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
    solana_keypair_path: str = "~/.config/solana/devnet-keypair.json"
    solana_keypair_secret_name: str = ""
    solana_keypair_secret_project: str = ""
    solana_keypair_secret_version: str = "latest"
    solana_network: str = "devnet"
    program_id: str = "82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd"

    google_cloud_project: str = ""
    gcs_bucket: str = "agora-data"
    api_use_real_orchestrator: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "AGORA_API_USE_REAL_ORCHESTRATOR",
            "API_USE_REAL_ORCHESTRATOR",
        ),
    )
    api_force_mechanism: str = Field(
        default="",
        validation_alias=AliasChoices("AGORA_API_FORCE_MECHANISM", "API_FORCE_MECHANISM"),
    )

    workos_client_id: str = ""


settings = Settings()
