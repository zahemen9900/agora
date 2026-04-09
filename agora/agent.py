"""Unified LLM caller abstraction for Vertex-hosted Gemini and Claude models."""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any

import structlog
from pydantic import BaseModel

from agora.config import get_config

try:
    from google.api_core.exceptions import ResourceExhausted, ServiceUnavailable, TooManyRequests
except ImportError:  # pragma: no cover
    ResourceExhausted = ServiceUnavailable = TooManyRequests = RuntimeError  # type: ignore[assignment]

try:
    from langchain_google_vertexai import ChatVertexAI
except ImportError:  # pragma: no cover
    ChatVertexAI = None  # type: ignore[assignment]

try:
    from langchain_google_vertexai.model_garden import ChatAnthropicVertex
except ImportError:  # pragma: no cover
    ChatAnthropicVertex = None  # type: ignore[assignment]

logger = structlog.get_logger(__name__)


class AgentCallError(RuntimeError):
    """Raised when an LLM call fails after retries."""


class AgentCaller:
    """Async abstraction over Vertex-hosted chat models.

    This wrapper normalizes model routing, retries, and token usage metadata across
    Gemini and Claude providers exposed through Vertex AI.
    """

    def __init__(
        self,
        model: str = "gemini-2.0-flash",
        temperature: float = 0.7,
        project: str | None = None,
        location: str = "us-central1",
    ) -> None:
        """Initialize caller and underlying LangChain model.

        Args:
            model: Model identifier.
            temperature: Default sampling temperature for calls.
            project: Google Cloud project id; defaults to environment value.
            location: Vertex AI location.

        Raises:
            ValueError: If the model prefix is unsupported.
            AgentCallError: If required SDK classes are unavailable.
        """

        config = get_config()
        self.model = model
        self.temperature = temperature
        self.project = project or os.getenv("GOOGLE_CLOUD_PROJECT") or config.google_cloud_project
        self.location = location

        if not self.project:
            raise AgentCallError(
                "GOOGLE_CLOUD_PROJECT is not set. Configure Vertex AI project or use "
                "fallback-capable runtime paths."
            )

        if model.startswith("gemini"):
            self.provider = "gemini"
            if ChatVertexAI is None:
                raise AgentCallError(
                    "langchain-google-vertexai is not installed; ChatVertexAI unavailable"
                )
            try:
                self._chat_model = ChatVertexAI(
                    model_name=model,
                    project=self.project,
                    location=self.location,
                    temperature=temperature,
                )
            except Exception as exc:
                raise AgentCallError(
                    "Failed to initialize ChatVertexAI. Ensure GOOGLE_CLOUD_PROJECT and "
                    "application default credentials are configured."
                ) from exc
        elif model.startswith("claude"):
            self.provider = "claude"
            if ChatAnthropicVertex is None:
                raise AgentCallError(
                    "langchain-google-vertexai model_garden support is unavailable; "
                    "ChatAnthropicVertex unavailable"
                )
            try:
                self._chat_model = ChatAnthropicVertex(
                    model_name=model,
                    project=self.project,
                    location=self.location,
                    temperature=temperature,
                )
            except Exception as exc:
                raise AgentCallError(
                    "Failed to initialize ChatAnthropicVertex. Ensure project, credentials, "
                    "and Model Garden access are configured."
                ) from exc
        else:
            raise ValueError(
                "Unsupported model name. Expected a model beginning with 'gemini' or 'claude'."
            )

    async def call(
        self,
        system_prompt: str,
        user_prompt: str,
        response_format: type[BaseModel] | None = None,
        temperature: float | None = None,
    ) -> tuple[str | BaseModel, dict[str, Any]]:
        """Execute one model call with normalized metadata.

        Args:
            system_prompt: System instructions.
            user_prompt: User/task prompt.
            response_format: Pydantic schema for structured output.
            temperature: Optional per-call temperature override.

        Returns:
            A tuple of parsed response content and normalized usage metadata.

        Raises:
            AgentCallError: If all retry attempts fail.
        """

        messages: list[tuple[str, str]] = [("system", system_prompt), ("human", user_prompt)]
        model = (
            self._chat_model.bind(temperature=temperature)
            if temperature is not None
            else self._chat_model
        )

        backoff_seconds = 0.5
        max_retries = 3
        retryable_errors: tuple[type[BaseException], ...] = (
            ResourceExhausted,
            ServiceUnavailable,
            TooManyRequests,
            TimeoutError,
        )

        for attempt in range(1, max_retries + 1):
            start = time.perf_counter()
            try:
                raw_message: Any | None = None
                if response_format is not None:
                    runnable, include_raw = self._get_structured_runnable(model, response_format)
                    result = await runnable.ainvoke(messages)
                    if include_raw and isinstance(result, dict) and "parsed" in result:
                        response = result["parsed"]
                        raw_message = result.get("raw")
                    else:
                        response = result

                    if not isinstance(response, response_format):
                        raise AgentCallError(
                            "Structured response did not match expected format "
                            f"{response_format.__name__}."
                        )
                    response_content: str | BaseModel = response
                else:
                    raw_message = await model.ainvoke(messages)
                    content = getattr(raw_message, "content", "")
                    response_content = content if isinstance(content, str) else str(content)

                elapsed_ms = (time.perf_counter() - start) * 1000.0
                usage = self._normalize_usage(raw_message, elapsed_ms)

                logger.info(
                    "agent_call_success",
                    model=self.model,
                    provider=self.provider,
                    input_tokens=usage["input_tokens"],
                    output_tokens=usage["output_tokens"],
                    latency_ms=usage["latency_ms"],
                )
                return response_content, usage
            except retryable_errors as exc:
                if attempt >= max_retries:
                    logger.error(
                        "agent_call_retry_exhausted",
                        model=self.model,
                        provider=self.provider,
                        attempt=attempt,
                        error=str(exc),
                    )
                    raise AgentCallError(
                        f"Model call failed after retries for model {self.model}."
                    ) from exc
                logger.warning(
                    "agent_call_retrying",
                    model=self.model,
                    provider=self.provider,
                    attempt=attempt,
                    backoff_seconds=backoff_seconds,
                    error=str(exc),
                )
                await asyncio.sleep(backoff_seconds)
                backoff_seconds *= 2.0
            except AgentCallError:
                raise
            except Exception as exc:
                logger.error(
                    "agent_call_non_retryable_failure",
                    model=self.model,
                    provider=self.provider,
                    attempt=attempt,
                    error=str(exc),
                )
                raise AgentCallError(f"Non-retryable failure for model {self.model}.") from exc

        raise AgentCallError(f"Unexpected retry loop termination for model {self.model}.")

    def _get_structured_runnable(
        self,
        model: Any,
        response_format: type[BaseModel],
    ) -> tuple[Any, bool]:
        """Create a structured-output runnable and indicate raw payload availability."""

        try:
            runnable = model.with_structured_output(response_format, include_raw=True)
            return runnable, True
        except TypeError:
            runnable = model.with_structured_output(response_format)
            return runnable, False

    def _normalize_usage(self, raw_message: Any | None, latency_ms: float) -> dict[str, Any]:
        """Normalize token usage metadata across provider response formats."""

        input_tokens = 0
        output_tokens = 0

        if raw_message is not None:
            usage_metadata = getattr(raw_message, "usage_metadata", None)
            if isinstance(usage_metadata, dict):
                input_tokens = int(
                    usage_metadata.get("input_tokens")
                    or usage_metadata.get("prompt_token_count")
                    or usage_metadata.get("prompt_tokens")
                    or 0
                )
                output_tokens = int(
                    usage_metadata.get("output_tokens")
                    or usage_metadata.get("candidates_token_count")
                    or usage_metadata.get("completion_tokens")
                    or 0
                )

            response_metadata = getattr(raw_message, "response_metadata", None)
            if isinstance(response_metadata, dict):
                usage = (
                    response_metadata.get("usage")
                    if isinstance(response_metadata.get("usage"), dict)
                    else {}
                )
                input_tokens = input_tokens or int(
                    usage.get("input_tokens")
                    or usage.get("prompt_tokens")
                    or usage.get("prompt_token_count")
                    or 0
                )
                output_tokens = output_tokens or int(
                    usage.get("output_tokens")
                    or usage.get("completion_tokens")
                    or usage.get("candidates_token_count")
                    or 0
                )

        return {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "model": self.model,
            "latency_ms": latency_ms,
            "provider": self.provider,
        }


def flash_caller() -> AgentCaller:
    """Return cost-efficient generation caller for openings, voting, and rebuttals."""

    config = get_config()
    return AgentCaller(model=config.flash_model, temperature=0.7)


def pro_caller() -> AgentCaller:
    """Return higher-quality reasoning caller for selection and synthesis."""

    config = get_config()
    return AgentCaller(model=config.pro_model, temperature=0.5)


def claude_caller() -> AgentCaller:
    """Return Vertex-hosted Claude caller for diversity or fallback routing."""

    config = get_config()
    return AgentCaller(model=config.claude_model, temperature=0.5)
