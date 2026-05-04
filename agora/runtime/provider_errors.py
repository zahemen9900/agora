"""Helpers for classifying provider failures for live fallback decisions."""

from __future__ import annotations

from typing import Any

from agora.agent import AgentCallError

_RETRYABLE_STATUS_CODES = {408, 409, 429}
_RETRYABLE_MESSAGE_SNIPPETS = (
    "high demand",
    "retry later",
    "retry after",
    "temporarily unavailable",
    "resource exhausted",
    "service unavailable",
    "server overloaded",
    "model is overloaded",
)


def extract_provider_status_code(error: BaseException | None) -> int | None:
    """Extract an HTTP-like provider status code from a chained exception."""

    current: BaseException | None = error
    while current is not None:
        status_code = getattr(current, "status_code", None)
        if isinstance(status_code, int):
            return status_code
        current = getattr(current, "__cause__", None)
    return None


def is_retryable_provider_status(status_code: int | None) -> bool:
    """Return whether a provider status should stay on the same model retry lane."""

    return isinstance(status_code, int) and (
        status_code in _RETRYABLE_STATUS_CODES or status_code >= 500
    )


def extract_provider_message(error: BaseException | None) -> str:
    """Flatten one chained provider error into lowercase text for classification."""

    parts: list[str] = []
    current: BaseException | None = error
    while current is not None:
        text = str(current).strip()
        if text:
            parts.append(text.lower())
        current = getattr(current, "__cause__", None)
    return " | ".join(parts)


def is_retryable_provider_message(message: str) -> bool:
    """Return whether provider error text indicates retry-on-same-model behavior."""

    normalized = message.lower()
    return any(snippet in normalized for snippet in _RETRYABLE_MESSAGE_SNIPPETS)


def is_retryable_provider_failure(error: AgentCallError) -> bool:
    """Return whether a provider failure should remain on its original retry lane."""

    status_code = extract_provider_status_code(error)
    if is_retryable_provider_status(status_code):
        return True
    return is_retryable_provider_message(extract_provider_message(error))


def should_try_alternate_live_model(error: AgentCallError) -> bool:
    """Return whether live cross-provider failover is appropriate for this failure."""

    return not is_retryable_provider_failure(error)


def provider_error_details(error: AgentCallError) -> dict[str, Any]:
    """Build structured error details for fallback logging."""

    status_code = extract_provider_status_code(error)
    provider_message = extract_provider_message(error)
    return {
        "status_code": status_code,
        "provider_message": provider_message,
        "alternate_live_model_eligible": not is_retryable_provider_failure(error),
    }
