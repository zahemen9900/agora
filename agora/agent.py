"""Unified LLM caller abstraction for Gemini and Claude model backends."""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import Callable
from typing import Any

import structlog
from pydantic import BaseModel

from agora.config import get_config

try:
    from google.api_core.exceptions import ResourceExhausted, ServiceUnavailable, TooManyRequests
except ImportError:  # pragma: no cover
    ResourceExhausted = ServiceUnavailable = TooManyRequests = RuntimeError  # type: ignore[assignment]

try:
    from langchain_google_genai import ChatGoogleGenerativeAI
except ImportError:  # pragma: no cover
    ChatGoogleGenerativeAI = None  # type: ignore[assignment]

try:
    from langchain_google_vertexai.model_garden import ChatAnthropicVertex
except ImportError:  # pragma: no cover
    ChatAnthropicVertex = None  # type: ignore[assignment]

logger = structlog.get_logger(__name__)


class AgentCallError(RuntimeError):
    """Raised when an LLM call fails after retries."""


class AgentCaller:
    """Async abstraction over chat models.

    This wrapper normalizes model routing, retries, and token usage metadata across
    Gemini and Claude providers.
    """

    def __init__(
        self,
        model: str = "gemini-2.5-flash",
        temperature: float = 0.7,
        project: str | None = None,
        location: str | None = None,
        enable_streaming: bool | None = None,
        enable_thinking: bool | None = None,
        thinking_budget: int | None = None,
    ) -> None:
        """Initialize caller and underlying LangChain model.

        Args:
            model: Model identifier.
            temperature: Default sampling temperature for calls.
            project: Google Cloud project id; defaults to environment value.
            location: Vertex AI location; defaults to configured runtime location.

        Raises:
            ValueError: If the model prefix is unsupported.
            AgentCallError: If required SDK classes are unavailable.
        """

        config = get_config()
        self.model = model
        self.temperature = temperature
        self.project = project or os.getenv("GOOGLE_CLOUD_PROJECT") or config.google_cloud_project
        self.location = location or config.google_cloud_location
        self.enable_streaming = (
            config.gemini_enable_streaming if enable_streaming is None else enable_streaming
        )
        self.enable_thinking = (
            config.gemini_enable_thinking if enable_thinking is None else enable_thinking
        )
        self.thinking_budget = (
            config.gemini_thinking_budget if thinking_budget is None else thinking_budget
        )

        if not self.project:
            raise AgentCallError(
                "GOOGLE_CLOUD_PROJECT is not set. Configure Vertex AI project or use "
                "fallback-capable runtime paths."
            )

        if model.startswith("gemini"):
            self.provider = "gemini"
            if ChatGoogleGenerativeAI is None:
                raise AgentCallError(
                    "langchain-google-genai is not installed; ChatGoogleGenerativeAI "
                    "unavailable"
                )
            base_kwargs = {
                "model": model,
                "vertexai": True,
                "project": self.project,
                "location": self.location,
                "temperature": temperature,
            }
            optional_kwargs: dict[str, Any] = {
                "streaming": self.enable_streaming,
            }
            if self.enable_thinking:
                optional_kwargs["include_thoughts"] = True
                if self.thinking_budget is not None:
                    optional_kwargs["thinking_budget"] = self.thinking_budget
            try:
                self._chat_model = ChatGoogleGenerativeAI(**base_kwargs, **optional_kwargs)
            except TypeError as exc:
                logger.warning(
                    "gemini_optional_features_unsupported",
                    model=model,
                    unsupported=list(optional_kwargs.keys()),
                    error=str(exc),
                )
                try:
                    self._chat_model = ChatGoogleGenerativeAI(**base_kwargs)
                except TypeError as init_exc:
                    raise AgentCallError(
                        "Installed langchain-google-genai is too old for Vertex mode. "
                        "Upgrade langchain-google-genai to a recent version."
                    ) from init_exc
            except Exception as exc:
                raise AgentCallError(
                    "Failed to initialize ChatGoogleGenerativeAI in Vertex mode. Ensure "
                    "GOOGLE_CLOUD_PROJECT and application default credentials are configured."
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
        stream: bool = False,
        stream_callback: Callable[[str], None] | None = None,
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

        if stream and response_format is not None:
            raise ValueError("Streaming is currently supported for unstructured text calls only.")

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
                elif stream:
                    response_content, raw_message = await self._stream_text(
                        model=model,
                        messages=messages,
                        stream_callback=stream_callback,
                    )
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
                    streamed=stream,
                    thinking_trace_present=usage.get("thinking_trace_present", False),
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

    async def _stream_text(
        self,
        model: Any,
        messages: list[tuple[str, str]],
        stream_callback: Callable[[str], None] | None,
    ) -> tuple[str, Any | None]:
        """Stream text chunks and return final concatenated content."""

        chunks: list[str] = []
        raw_message: Any | None = None

        async for chunk in model.astream(messages):
            raw_message = chunk
            content = self._extract_chunk_text(chunk)
            if not content:
                continue
            chunks.append(content)
            if stream_callback is not None:
                try:
                    stream_callback(content)
                except Exception as exc:  # pragma: no cover
                    logger.warning("stream_callback_error", error=str(exc))

        return "".join(chunks), raw_message

    @staticmethod
    def _extract_chunk_text(chunk: Any) -> str:
        """Extract plain text from a streamed LangChain chunk payload."""

        content = getattr(chunk, "content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict):
                    text = item.get("text")
                    if isinstance(text, str):
                        parts.append(text)
                else:
                    text = getattr(item, "text", None)
                    if isinstance(text, str):
                        parts.append(text)
            return "".join(parts)
        return str(content) if content else ""

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

        thinking_trace_present = False
        thinking_trace_chars = 0
        if raw_message is not None:
            additional_kwargs = getattr(raw_message, "additional_kwargs", None)
            if isinstance(additional_kwargs, dict):
                thought_payload = (
                    additional_kwargs.get("thought")
                    or additional_kwargs.get("thoughts")
                    or additional_kwargs.get("reasoning_content")
                )
                if thought_payload is not None:
                    thinking_trace_present = True
                    if isinstance(thought_payload, str):
                        thinking_trace_chars = len(thought_payload)
                    else:
                        thinking_trace_chars = len(json.dumps(thought_payload, default=str))

            # Gemini can surface thinking blocks directly in message content.
            content = getattr(raw_message, "content", None)
            if isinstance(content, list):
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    if item.get("type") == "thinking" and item.get("thinking") is not None:
                        thinking_trace_present = True
                        payload = item.get("thinking")
                        if isinstance(payload, str):
                            thinking_trace_chars += len(payload)
                        else:
                            thinking_trace_chars += len(json.dumps(payload, default=str))

        return {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "model": self.model,
            "latency_ms": latency_ms,
            "provider": self.provider,
            "thinking_trace_present": thinking_trace_present,
            "thinking_trace_chars": thinking_trace_chars,
        }


def flash_caller() -> AgentCaller:
    """Return cost-efficient generation caller for openings, voting, and rebuttals."""

    config = get_config()
    return AgentCaller(
        model=config.flash_model,
        temperature=0.7,
        enable_streaming=config.gemini_enable_streaming,
        enable_thinking=False,
    )


def pro_caller() -> AgentCaller:
    """Return higher-quality reasoning caller for selection and synthesis."""

    config = get_config()
    return AgentCaller(
        model=config.pro_model,
        temperature=0.5,
        enable_streaming=config.gemini_enable_streaming,
        enable_thinking=config.gemini_enable_thinking,
        thinking_budget=config.gemini_thinking_budget,
    )


def claude_caller() -> AgentCaller:
    """Return Vertex-hosted Claude caller for diversity or fallback routing."""

    config = get_config()
    return AgentCaller(model=config.claude_model, temperature=0.5)
