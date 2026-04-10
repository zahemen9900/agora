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
    google_cloud_location: str = Field(
        default_factory=lambda: os.getenv("AGORA_GOOGLE_CLOUD_LOCATION", "us-central1")
    )

    flash_model: str = Field(
        default_factory=lambda: os.getenv("AGORA_FLASH_MODEL", "gemini-2.5-flash")
    )
    pro_model: str = Field(
        default_factory=lambda: os.getenv("AGORA_PRO_MODEL", "gemini-2.5-pro")
    )
    claude_model: str = Field(
        default_factory=lambda: os.getenv("AGORA_CLAUDE_MODEL", "claude-sonnet-4-6")
    )
    anthropic_api_key: str | None = Field(default_factory=lambda: os.getenv("ANTHROPIC_API_KEY"))
    anthropic_max_tokens: int = Field(
        default_factory=lambda: int(os.getenv("AGORA_ANTHROPIC_MAX_TOKENS", "1024")),
        ge=1,
    )

    # Gemini runtime feature controls.
    gemini_enable_streaming: bool = True
    gemini_enable_thinking: bool = True
    gemini_thinking_budget: int = Field(default=1024, ge=0)

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
