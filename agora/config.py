"""Global configuration values for Agora protocol runtime."""

from __future__ import annotations

import os
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


def _env_bool(name: str, default: bool) -> bool:
    """Parse common boolean environment value formats."""

    raw = os.getenv(name)
    if raw is None:
        return default

    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _env_optional_str(name: str, default: str | None = None) -> str | None:
    """Read a stripped string value, treating empty strings as unset."""

    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip()
    return value or None


def _env_optional_str_alias(
    primary: str,
    *aliases: str,
    default: str | None = None,
) -> str | None:
    """Read a stripped string from the first populated env name."""

    for name in (primary, *aliases):
        value = _env_optional_str(name)
        if value is not None:
            return value
    return default


def _env_bool_alias(primary: str, *aliases: str, default: bool) -> bool:
    """Read a boolean from the first populated env name."""

    for name in (primary, *aliases):
        if os.getenv(name) is not None:
            return _env_bool(name, default)
    return default


def _env_int_alias(primary: str, *aliases: str, default: int) -> int:
    """Read an int from the first populated env name."""

    for name in (primary, *aliases):
        raw = os.getenv(name)
        if raw is not None:
            return int(raw)
    return default


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
    candidate_paths: list[Path] = []
    explicit_env_file = os.getenv("AGORA_ENV_FILE", "").strip()
    if explicit_env_file:
        candidate_paths.append(Path(explicit_env_file).expanduser())
    candidate_paths.extend([Path.cwd() / ".env", repo_root / ".env"])
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


def _load_secret_manager_value(
    project_id: str,
    secret_name: str,
    version: str = "latest",
) -> str | None:
    """Read a secret value from Google Secret Manager when available."""

    try:
        payload = _load_secret_manager_value_via_client(
            project_id=project_id,
            secret_name=secret_name,
            version=version,
        )
        if payload:
            return payload
    except Exception:
        pass

    try:
        return _load_secret_manager_value_via_gcloud(
            project_id=project_id,
            secret_name=secret_name,
            version=version,
        )
    except Exception:
        return None


def _load_secret_manager_value_via_client(
    project_id: str,
    secret_name: str,
    version: str = "latest",
) -> str | None:
    """Read a secret value via Google Secret Manager client libraries."""

    from google.cloud import secretmanager

    client = secretmanager.SecretManagerServiceClient()
    secret_path = f"projects/{project_id}/secrets/{secret_name}/versions/{version}"
    response = client.access_secret_version(request={"name": secret_path})
    payload = response.payload.data.decode("utf-8").strip()
    return payload or None


def _load_secret_manager_value_via_gcloud(
    project_id: str,
    secret_name: str,
    version: str = "latest",
) -> str | None:
    """Fallback to gcloud CLI for shells authenticated with gcloud user credentials."""

    if shutil.which("gcloud") is None:
        return None

    env = os.environ.copy()
    env.setdefault("CLOUDSDK_PAGER", "")
    env.setdefault("CLOUDSDK_CORE_DISABLE_PROMPTS", "1")
    result = subprocess.run(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            version,
            "--secret",
            secret_name,
            "--project",
            project_id,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=env,
        timeout=20,
    )
    if result.returncode != 0:
        return None
    payload = result.stdout.strip()
    return payload or None


def _resolve_anthropic_api_key() -> str | None:
    """Resolve Anthropic API key from env first, then Secret Manager fallback."""

    explicit_key = os.getenv("ANTHROPIC_API_KEY")
    if explicit_key:
        return explicit_key

    secret_name = os.getenv("AGORA_ANTHROPIC_SECRET_NAME", "agora-anthropic-api-key").strip()
    if not secret_name:
        return None

    project_id = (
        os.getenv("AGORA_ANTHROPIC_SECRET_PROJECT") or os.getenv("GOOGLE_CLOUD_PROJECT") or ""
    ).strip()
    if not project_id:
        return None

    version = (os.getenv("AGORA_ANTHROPIC_SECRET_VERSION") or "latest").strip() or "latest"
    return _load_secret_manager_value(
        project_id=project_id,
        secret_name=secret_name,
        version=version,
    )


def _resolve_gemini_api_key() -> str | None:
    """Resolve Gemini API key from env first, then Secret Manager fallback."""

    explicit_key = (
        os.getenv("AGORA_GEMINI_API_KEY")
        or os.getenv("GEMINI_API_KEY")
        or os.getenv("AGORA_GOOGLE_API_KEY")
        or os.getenv("GOOGLE_API_KEY")
    )
    if explicit_key:
        return explicit_key

    secret_name = os.getenv("AGORA_GEMINI_SECRET_NAME", "agora-gemini-api-key").strip()
    if not secret_name:
        return None

    project_id = (
        os.getenv("AGORA_GEMINI_SECRET_PROJECT") or os.getenv("GOOGLE_CLOUD_PROJECT") or ""
    ).strip()
    if not project_id:
        return None

    version = (os.getenv("AGORA_GEMINI_SECRET_VERSION") or "latest").strip() or "latest"
    return _load_secret_manager_value(
        project_id=project_id,
        secret_name=secret_name,
        version=version,
    )


def _resolve_openrouter_api_key() -> str | None:
    """Resolve OpenRouter API key from env first, then Secret Manager fallback."""

    explicit_key = os.getenv("AGORA_OPENROUTER_API_KEY") or os.getenv("OPENROUTER_API_KEY")
    if explicit_key:
        cleaned = explicit_key.strip()
        # Guard against accidental duplicated prefix copy/paste corruption.
        if cleaned.startswith("sk-or-v1-") and cleaned.count("sk-or-v1-") > 1:
            half = len(cleaned) // 2
            if len(cleaned) % 2 == 0 and cleaned[:half] == cleaned[half:]:
                cleaned = cleaned[:half]
            else:
                cleaned = ""
        if cleaned:
            return cleaned

    secret_name = os.getenv("AGORA_OPENROUTER_SECRET_NAME", "agora-openrouter-api-key").strip()
    if not secret_name:
        return None

    project_id = (
        os.getenv("AGORA_OPENROUTER_SECRET_PROJECT") or os.getenv("GOOGLE_CLOUD_PROJECT") or ""
    ).strip()
    if not project_id:
        return None

    version = (os.getenv("AGORA_OPENROUTER_SECRET_VERSION") or "latest").strip() or "latest"
    return _load_secret_manager_value(
        project_id=project_id,
        secret_name=secret_name,
        version=version,
    )


class AgoraConfig(BaseModel):
    """Typed runtime configuration for model routing and thresholds."""

    model_config = ConfigDict(frozen=True)

    google_cloud_project: str | None = Field(
        default_factory=lambda: os.getenv("GOOGLE_CLOUD_PROJECT")
    )
    gemini_api_key: str | None = Field(default_factory=_resolve_gemini_api_key)
    gemini_secret_name: str = Field(
        default_factory=lambda: os.getenv("AGORA_GEMINI_SECRET_NAME", "agora-gemini-api-key")
    )
    gemini_secret_project: str | None = Field(
        default_factory=lambda: os.getenv("AGORA_GEMINI_SECRET_PROJECT")
    )
    gemini_secret_version: str = Field(
        default_factory=lambda: os.getenv("AGORA_GEMINI_SECRET_VERSION", "latest")
    )
    google_cloud_location: str = Field(
        default_factory=lambda: os.getenv("AGORA_GOOGLE_CLOUD_LOCATION", "us-central1")
    )

    flash_model: str = Field(
        default_factory=lambda: os.getenv("AGORA_FLASH_MODEL", "gemini-3.1-flash-lite-preview")
    )
    pro_model: str = Field(
        default_factory=lambda: os.getenv("AGORA_PRO_MODEL", "gemini-3-flash-preview")
    )
    claude_model: str = Field(
        default_factory=lambda: os.getenv("AGORA_CLAUDE_MODEL", "claude-sonnet-4-6")
    )
    openrouter_model: str = Field(
        default_factory=lambda: (
            _env_optional_str_alias(
                "AGORA_OPENROUTER_MODEL",
                "AGORA_KIMI_MODEL",
                default="qwen/qwen3.5-flash-02-23",
            )
            or "qwen/qwen3.5-flash-02-23"
        )
    )
    anthropic_api_key: str | None = Field(default_factory=_resolve_anthropic_api_key)
    anthropic_secret_name: str = Field(
        default_factory=lambda: os.getenv("AGORA_ANTHROPIC_SECRET_NAME", "agora-anthropic-api-key")
    )
    anthropic_secret_project: str | None = Field(
        default_factory=lambda: os.getenv("AGORA_ANTHROPIC_SECRET_PROJECT")
    )
    anthropic_secret_version: str = Field(
        default_factory=lambda: os.getenv("AGORA_ANTHROPIC_SECRET_VERSION", "latest")
    )
    anthropic_max_tokens: int = Field(
        default_factory=lambda: int(os.getenv("AGORA_ANTHROPIC_MAX_TOKENS", "1024")),
        ge=1,
    )
    anthropic_throttle_enabled: bool = Field(
        default_factory=lambda: _env_bool("AGORA_ANTHROPIC_THROTTLE_ENABLED", True)
    )
    anthropic_requests_per_minute: int = Field(
        default_factory=lambda: int(os.getenv("AGORA_ANTHROPIC_REQUESTS_PER_MINUTE", "5")),
        ge=1,
    )
    anthropic_throttle_window_seconds: float = Field(
        default_factory=lambda: float(os.getenv("AGORA_ANTHROPIC_THROTTLE_WINDOW_SECONDS", "60")),
        gt=0,
    )
    model_call_timeout_seconds: float = Field(
        default_factory=lambda: float(os.getenv("AGORA_MODEL_CALL_TIMEOUT_SECONDS", "180")),
        gt=0,
    )
    openrouter_api_key: str | None = Field(default_factory=_resolve_openrouter_api_key)
    openrouter_secret_name: str = Field(
        default_factory=lambda: os.getenv(
            "AGORA_OPENROUTER_SECRET_NAME",
            "agora-openrouter-api-key",
        )
    )
    openrouter_secret_project: str | None = Field(
        default_factory=lambda: os.getenv("AGORA_OPENROUTER_SECRET_PROJECT")
    )
    openrouter_secret_version: str = Field(
        default_factory=lambda: os.getenv("AGORA_OPENROUTER_SECRET_VERSION", "latest")
    )
    openrouter_base_url: str = Field(
        default_factory=lambda: os.getenv(
            "AGORA_OPENROUTER_BASE_URL",
            "https://openrouter.ai/api/v1",
        )
    )
    openrouter_http_referer: str | None = Field(
        default_factory=lambda: _env_optional_str("AGORA_OPENROUTER_HTTP_REFERER")
    )
    openrouter_app_title: str | None = Field(
        default_factory=lambda: _env_optional_str("AGORA_OPENROUTER_APP_TITLE", "Agora Protocol")
    )
    openrouter_legacy_x_title_enabled: bool = Field(
        default_factory=lambda: _env_bool("AGORA_OPENROUTER_LEGACY_X_TITLE_ENABLED", True)
    )
    openrouter_reasoning_effort: str | None = Field(
        default_factory=lambda: _env_optional_str_alias(
            "AGORA_OPENROUTER_REASONING_EFFORT",
            "AGORA_KIMI_REASONING_EFFORT",
            default="low",
        )
    )
    openrouter_reasoning_exclude: bool = Field(
        default_factory=lambda: _env_bool_alias(
            "AGORA_OPENROUTER_REASONING_EXCLUDE",
            "AGORA_KIMI_REASONING_EXCLUDE",
            default=True,
        )
    )
    openrouter_max_tokens: int = Field(
        default_factory=lambda: _env_int_alias(
            "AGORA_OPENROUTER_MAX_TOKENS",
            "AGORA_KIMI_MAX_TOKENS",
            default=512,
        ),
        ge=1,
    )
    claude_effort: str = Field(
        default_factory=lambda: _env_optional_str("AGORA_CLAUDE_EFFORT", "medium") or "medium"
    )

    # Gemini runtime feature controls.
    gemini_enable_streaming: bool = True
    gemini_enable_thinking: bool = True
    gemini_thinking_budget: int = Field(default=1024, ge=0)
    gemini_pro_thinking_level: str = Field(
        default_factory=lambda: (
            _env_optional_str("AGORA_GEMINI_PRO_THINKING_LEVEL", "high") or "high"
        )
    )
    gemini_flash_thinking_level: str | None = Field(
        default_factory=lambda: _env_optional_str(
            "AGORA_GEMINI_FLASH_THINKING_LEVEL",
            "medium",
        )
    )
    anthropic_concurrent_requests_per_run: int = Field(
        default_factory=lambda: int(os.getenv("AGORA_ANTHROPIC_CONCURRENT_REQUESTS_PER_RUN", "1")),
        ge=1,
    )

    max_rounds: int = 4
    quorum_threshold: float = 0.6
    plateau_threshold: float = 0.05
    plateau_rounds: int = 2

    @property
    def kimi_model(self) -> str:
        """Backward-compatible alias for historical runtime code paths."""

        return self.openrouter_model

    @property
    def kimi_reasoning_effort(self) -> str | None:
        """Backward-compatible alias for historical runtime code paths."""

        return self.openrouter_reasoning_effort

    @property
    def kimi_reasoning_exclude(self) -> bool:
        """Backward-compatible alias for historical runtime code paths."""

        return self.openrouter_reasoning_exclude

    @property
    def kimi_max_tokens(self) -> int:
        """Backward-compatible alias for historical runtime code paths."""

        return self.openrouter_max_tokens


@lru_cache(maxsize=1)
def get_config() -> AgoraConfig:
    """Return a cached configuration instance.

    Returns:
        AgoraConfig: Shared immutable config for the current process.
    """

    _load_dotenv_if_present()
    return AgoraConfig()
