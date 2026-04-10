"""Global configuration values for Agora protocol runtime."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


def _parse_env_assignment(line: str) -> tuple[str, str] | None:
    """Parse one dotenv-style assignment line."""

    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export "):
        stripped = stripped[7:].lstrip()
    if "=" not in stripped:
        return None

    key, raw_value = stripped.split("=", 1)
    key = key.strip()
    if not key:
        return None

    value = raw_value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        value = value[1:-1]
    return key, value


def _load_dotenv_if_present() -> None:
    """Load a local `.env` file without overriding exported environment variables."""

    repo_root = Path(__file__).resolve().parents[1]
    candidate_paths = [Path.cwd() / ".env", repo_root / ".env"]
    seen: set[Path] = set()

    for candidate in candidate_paths:
        try:
            resolved = candidate.resolve()
        except FileNotFoundError:
            resolved = candidate.absolute()
        if resolved in seen or not candidate.is_file():
            continue
        seen.add(resolved)

        for line in candidate.read_text(encoding="utf-8").splitlines():
            assignment = _parse_env_assignment(line)
            if assignment is None:
                continue
            key, value = assignment
            os.environ.setdefault(key, value)


class AgoraConfig(BaseModel):
    """Typed runtime configuration for model routing and thresholds."""

    model_config = ConfigDict(frozen=True)

    google_cloud_project: str | None = Field(
        default_factory=lambda: os.getenv("GOOGLE_CLOUD_PROJECT")
    )
    anthropic_api_key: str | None = Field(default_factory=lambda: os.getenv("ANTHROPIC_API_KEY"))
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

    _load_dotenv_if_present()
    return AgoraConfig()
