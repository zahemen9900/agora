"""Runtime settings for the Agora API service."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-driven API settings."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    helius_rpc_url: str = "https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
    solana_keypair_path: str = "~/.config/solana/devnet-keypair.json"
    solana_network: str = "devnet"
    program_id: str = "8QujRWcvR318hQFQmWB3P6epBPBMKdY4c5tHLpshvZDu"

    google_cloud_project: str = ""
    gcs_bucket: str = ""

    workos_client_id: str = ""


settings = Settings()
