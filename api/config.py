"""Runtime settings for the Agora API service."""

from __future__ import annotations

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

    auth_required: bool = True
    strict_chain_writes: bool = False
    workos_client_id: str = ""
    workos_authkit_domain: str = ""
    auth_issuer: str = ""
    auth_audience: str = ""
    auth_jwks_url: str = ""


settings = Settings()
