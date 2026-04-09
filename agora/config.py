"""Global configuration values for Agora protocol runtime."""

from __future__ import annotations

import os
from functools import lru_cache

from pydantic import BaseModel, ConfigDict, Field


class AgoraConfig(BaseModel):
    """Typed runtime configuration for model routing and thresholds."""

    model_config = ConfigDict(frozen=True)

    google_cloud_project: str | None = Field(
        default_factory=lambda: os.getenv("GOOGLE_CLOUD_PROJECT")
    )
    google_cloud_location: str = "us-central1"

    flash_model: str = "gemini-3.0-flash-preview"
    pro_model: str = "gemini-3.1-pro-preview"
    claude_model: str = "claude-sonnet-4-6"

    max_rounds: int = 4
    quorum_threshold: float = 0.6
    plateau_threshold: float = 0.05
    plateau_rounds: int = 2


@lru_cache(maxsize=1)
def get_config() -> AgoraConfig:
    """Return a cached configuration instance.

    Returns:
        AgoraConfig: Shared immutable config for the current process.
    """

    return AgoraConfig()
