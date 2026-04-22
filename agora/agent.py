"""Unified LLM caller abstraction for Gemini, Claude, and OpenRouter backends."""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import random
import time
from collections import deque
from collections.abc import Awaitable, Callable
from threading import Lock
from typing import Any, cast

import structlog
from pydantic import BaseModel, ValidationError

from agora.config import get_config

try:
    from anthropic import APIConnectionError as AnthropicAPIConnectionError
    from anthropic import APIStatusError as AnthropicAPIStatusError
    from anthropic import APITimeoutError as AnthropicAPITimeoutError
    from anthropic import AsyncAnthropic
    from anthropic import RateLimitError as AnthropicRateLimitError
except ImportError:  # pragma: no cover
    AnthropicAPIConnectionError = RuntimeError  # type: ignore[assignment]
    AnthropicAPIStatusError = RuntimeError  # type: ignore[assignment]
    AnthropicAPITimeoutError = TimeoutError  # type: ignore[assignment]
    AsyncAnthropic = None  # type: ignore[assignment]
    AnthropicRateLimitError = RuntimeError  # type: ignore[assignment]

try:
    from google import genai
    from google.genai import types as genai_types
    from google.genai.errors import APIError as GeminiAPIError
except ImportError:  # pragma: no cover
    genai = None  # type: ignore[assignment]
    genai_types = None  # type: ignore[assignment]
    GeminiAPIError = RuntimeError  # type: ignore[assignment]

try:
    from openai import APIConnectionError as OpenAIAPIConnectionError
    from openai import APIStatusError as OpenAIAPIStatusError
    from openai import APITimeoutError as OpenAIAPITimeoutError
    from openai import AsyncOpenAI
    from openai import RateLimitError as OpenAIRateLimitError
except ImportError:  # pragma: no cover
    OpenAIAPIConnectionError = RuntimeError  # type: ignore[assignment]
    OpenAIAPIStatusError = RuntimeError  # type: ignore[assignment]
    OpenAIAPITimeoutError = TimeoutError  # type: ignore[assignment]
    AsyncOpenAI = None  # type: ignore[assignment]
    OpenAIRateLimitError = RuntimeError  # type: ignore[assignment]

logger = structlog.get_logger(__name__)

_STREAM_EVENT_PREFIX = "\u001eAGORA_STREAM_EVENT\u001e"
_STREAM_EVENT_SEPARATOR = "\u001f"


def _emit_stream_event(
    stream_callback: Callable[[str], None] | None,
    *,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    """Forward a structured live-stream event through the chunk callback."""

    if stream_callback is None:
        return

    try:
        stream_callback(
            f"{_STREAM_EVENT_PREFIX}{event_type}"
            f"{_STREAM_EVENT_SEPARATOR}{json.dumps(payload, default=str)}"
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("stream_callback_error", error=str(exc))


class AgentCallError(RuntimeError):
    """Raised when an LLM call fails after retries."""


class _AsyncSlidingWindowRateLimiter:
    """Enforce a max number of requests per sliding time window."""

    def __init__(self, max_requests: int, window_seconds: float) -> None:
        if max_requests < 1:
            raise ValueError("max_requests must be at least 1")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be positive")

        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._timestamps: deque[float] = deque()
        self._lock = asyncio.Lock()

    async def acquire(self) -> float:
        """Reserve one request slot; returns total waited seconds."""

        waited_seconds = 0.0

        while True:
            sleep_for = 0.0
            async with self._lock:
                now = time.monotonic()
                cutoff = now - self.window_seconds

                while self._timestamps and self._timestamps[0] <= cutoff:
                    self._timestamps.popleft()

                if len(self._timestamps) < self.max_requests:
                    self._timestamps.append(now)
                    return waited_seconds

                sleep_for = max(0.0, self.window_seconds - (now - self._timestamps[0]))

            if sleep_for > 0:
                waited_seconds += sleep_for
                await asyncio.sleep(sleep_for)


_ANTHROPIC_THROTTLES: dict[tuple[str, int, float], _AsyncSlidingWindowRateLimiter] = {}
_ANTHROPIC_THROTTLES_LOCK = Lock()


def _get_shared_anthropic_throttle(
    model: str,
    requests_per_minute: int,
    window_seconds: float,
) -> _AsyncSlidingWindowRateLimiter:
    """Return a process-shared Anthropic limiter keyed by model and policy."""

    key = (model, requests_per_minute, window_seconds)
    with _ANTHROPIC_THROTTLES_LOCK:
        throttle = _ANTHROPIC_THROTTLES.get(key)
        if throttle is None:
            throttle = _AsyncSlidingWindowRateLimiter(
                max_requests=requests_per_minute,
                window_seconds=window_seconds,
            )
            _ANTHROPIC_THROTTLES[key] = throttle
        return throttle


class AgentCaller:
    """Async abstraction over chat models.

    This wrapper normalizes model routing, retries, and token usage metadata across
    Gemini, Claude, and OpenRouter providers.
    """

    def __init__(
        self,
        model: str = "gemini-3.1-flash-lite-preview",
        temperature: float = 0.7,
        project: str | None = None,
        location: str | None = None,
        gemini_api_key: str | None = None,
        anthropic_api_key: str | None = None,
        openrouter_api_key: str | None = None,
        enable_streaming: bool | None = None,
        enable_thinking: bool | None = None,
        thinking_budget: int | None = None,
        thinking_level: str | None = None,
        kimi_reasoning_effort: str | None = None,
        kimi_reasoning_exclude: bool | None = None,
        claude_effort: str | None = None,
        claude_thinking_display: str | None = None,
    ) -> None:
        """Initialize caller and underlying model SDK client.

        Args:
            model: Model identifier.
            temperature: Default sampling temperature for calls.
            project: Reserved for backward compatibility.
            location: Reserved for backward compatibility.

        Raises:
            ValueError: If the model prefix is unsupported.
            AgentCallError: If required SDK classes are unavailable.
        """

        config = get_config()
        self.model = model
        self.temperature = temperature
        self.project = project or os.getenv("GOOGLE_CLOUD_PROJECT") or config.google_cloud_project
        self.location = location or config.google_cloud_location
        self.gemini_api_key = (
            gemini_api_key
            or os.getenv("AGORA_GEMINI_API_KEY")
            or os.getenv("GEMINI_API_KEY")
            or os.getenv("AGORA_GOOGLE_API_KEY")
            or os.getenv("GOOGLE_API_KEY")
            or config.gemini_api_key
        )
        self.enable_streaming = (
            config.gemini_enable_streaming if enable_streaming is None else enable_streaming
        )
        self.enable_thinking = (
            config.gemini_enable_thinking if enable_thinking is None else enable_thinking
        )
        self.thinking_budget = (
            config.gemini_thinking_budget if thinking_budget is None else thinking_budget
        )
        self.thinking_level = thinking_level
        self.anthropic_api_key = (
            anthropic_api_key or os.getenv("ANTHROPIC_API_KEY") or config.anthropic_api_key
        )
        self.openrouter_api_key = (
            openrouter_api_key
            or os.getenv("AGORA_OPENROUTER_API_KEY")
            or os.getenv("OPENROUTER_API_KEY")
            or config.openrouter_api_key
        )
        self.openrouter_base_url = config.openrouter_base_url
        self._openrouter_default_headers = self._build_openrouter_headers(config)
        self._kimi_reasoning_effort = (
            config.kimi_reasoning_effort if kimi_reasoning_effort is None else kimi_reasoning_effort
        )
        self._kimi_reasoning_exclude = (
            config.kimi_reasoning_exclude
            if kimi_reasoning_exclude is None
            else kimi_reasoning_exclude
        )
        self._kimi_max_tokens = config.kimi_max_tokens
        self._anthropic_max_tokens = config.anthropic_max_tokens
        self._anthropic_throttle_enabled = config.anthropic_throttle_enabled
        self._anthropic_requests_per_minute = config.anthropic_requests_per_minute
        self._anthropic_throttle_window_seconds = config.anthropic_throttle_window_seconds
        self.model_call_timeout_seconds = max(1.0, float(config.model_call_timeout_seconds))
        self._claude_effort = config.claude_effort if claude_effort is None else claude_effort
        self._claude_thinking_display = (
            "summarized" if claude_thinking_display is None else claude_thinking_display
        )
        self._anthropic_throttle: _AsyncSlidingWindowRateLimiter | None = None
        self._gemini_client: Any | None = None
        self._anthropic_client: Any | None = None
        self._openrouter_client: Any | None = None

        if model.startswith("gemini"):
            self.provider = "gemini"
            if not self.gemini_api_key:
                raise AgentCallError(
                    "Gemini API key is not set. Configure AGORA_GEMINI_API_KEY "
                    "(or GEMINI_API_KEY/GOOGLE_API_KEY) or use "
                    "fallback-capable runtime paths."
                )
            if genai is None:
                raise AgentCallError(
                    "google-genai SDK is not installed; direct Gemini API client unavailable"
                )
            try:
                self._gemini_client = genai.Client(api_key=self.gemini_api_key)
            except Exception as exc:
                raise AgentCallError(
                    "Failed to initialize google-genai Gemini client. Ensure the configured "
                    "Gemini API key is valid for ai.google.dev Gemini API access."
                ) from exc
        elif model.startswith("claude"):
            self.provider = "claude"
            if AsyncAnthropic is None:
                raise AgentCallError("anthropic SDK is not installed; AsyncAnthropic unavailable")
            if not self.anthropic_api_key:
                raise AgentCallError(
                    "ANTHROPIC_API_KEY is not set. Configure Anthropic API credentials "
                    "for direct Claude access."
                )
            try:
                # Keep SDK retries disabled because AGORA applies its own retry policy.
                self._anthropic_client = AsyncAnthropic(
                    api_key=self.anthropic_api_key,
                    max_retries=0,
                )
                if self._anthropic_throttle_enabled:
                    self._anthropic_throttle = _get_shared_anthropic_throttle(
                        model=self.model,
                        requests_per_minute=self._anthropic_requests_per_minute,
                        window_seconds=self._anthropic_throttle_window_seconds,
                    )
            except Exception as exc:
                raise AgentCallError(
                    "Failed to initialize AsyncAnthropic. Ensure ANTHROPIC_API_KEY is valid."
                ) from exc
        elif model.startswith("moonshotai/") or model.startswith("openrouter/"):
            self.provider = "openrouter"
            if AsyncOpenAI is None:
                raise AgentCallError("openai SDK is not installed; AsyncOpenAI unavailable")
            if not self.openrouter_api_key:
                raise AgentCallError(
                    "OPENROUTER_API_KEY is not set. Configure AGORA_OPENROUTER_API_KEY "
                    "or OPENROUTER_API_KEY for Kimi access."
                )
            try:
                # Keep SDK retries disabled because AGORA applies its own retry policy.
                self._openrouter_client = AsyncOpenAI(
                    api_key=self.openrouter_api_key,
                    base_url=self.openrouter_base_url,
                    max_retries=0,
                    default_headers=self._openrouter_default_headers or None,
                )
            except Exception as exc:
                raise AgentCallError(
                    "Failed to initialize AsyncOpenAI for OpenRouter. "
                    "Ensure OPENROUTER_API_KEY is valid."
                ) from exc
        else:
            raise ValueError(
                "Unsupported model name. Expected a model beginning with "
                "'gemini', 'claude', or an OpenRouter-compatible prefix."
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
        try:
            if self.provider == "claude":
                return await asyncio.wait_for(
                    self._call_claude(
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        response_format=response_format,
                        temperature=temperature,
                        stream=stream,
                        stream_callback=stream_callback,
                    ),
                    timeout=self.model_call_timeout_seconds,
                )

            if self.provider == "openrouter":
                return await asyncio.wait_for(
                    self._call_openrouter(
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        response_format=response_format,
                        temperature=temperature,
                        stream=stream,
                        stream_callback=stream_callback,
                    ),
                    timeout=self.model_call_timeout_seconds,
                )

            return await asyncio.wait_for(
                self._call_gemini(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    response_format=response_format,
                    temperature=temperature,
                    stream=stream,
                    stream_callback=stream_callback,
                ),
                timeout=self.model_call_timeout_seconds,
            )
        except TimeoutError as exc:
            logger.warning(
                "agent_call_timeout",
                model=self.model,
                provider=self.provider,
                timeout_seconds=self.model_call_timeout_seconds,
            )
            raise AgentCallError(
                f"Model call timed out after {self.model_call_timeout_seconds}s for model {self.model}."
            ) from exc

    async def _call_gemini(
        self,
        system_prompt: str,
        user_prompt: str,
        response_format: type[BaseModel] | None,
        temperature: float | None,
        stream: bool,
        stream_callback: Callable[[str], None] | None,
    ) -> tuple[str | BaseModel, dict[str, Any]]:
        """Execute one Gemini call via the direct google-genai SDK."""

        if self._gemini_client is None:
            raise AgentCallError("Gemini client was not initialized.")
        if genai_types is None:
            raise AgentCallError("google-genai types are unavailable.")

        effective_temperature = self.temperature if temperature is None else temperature
        backoff_seconds = random.uniform(3.0, 5.0)
        max_retries = 3

        for attempt in range(1, max_retries + 1):
            start = time.perf_counter()
            try:
                config_kwargs: dict[str, Any] = {
                    "temperature": effective_temperature,
                    "systemInstruction": system_prompt,
                }
                thinking_config = self._build_gemini_thinking_config()
                if thinking_config is not None:
                    config_kwargs["thinkingConfig"] = thinking_config

                raw_message: Any | None = None
                if response_format is not None:
                    config_kwargs["responseMimeType"] = "application/json"
                    config_kwargs["responseSchema"] = response_format
                if response_format is not None and not stream:
                    response_config = genai_types.GenerateContentConfig(**config_kwargs)
                    raw_message = await self._gemini_client.aio.models.generate_content(
                        model=self.model,
                        contents=user_prompt,
                        config=response_config,
                    )
                    response_content = self._parse_gemini_structured_response(
                        raw_message=raw_message,
                        response_format=response_format,
                    )
                elif stream:
                    stream_config = genai_types.GenerateContentConfig(**config_kwargs)
                    response_content, raw_message = await self._stream_gemini_text(
                        user_prompt=user_prompt,
                        stream_config=stream_config,
                        stream_callback=stream_callback,
                    )
                    if response_format is not None:
                        response_content = self._parse_structured_text_payload(
                            text=response_content,
                            response_format=response_format,
                            provider_label="Gemini",
                        )
                else:
                    response_config = genai_types.GenerateContentConfig(**config_kwargs)
                    raw_message = await self._gemini_client.aio.models.generate_content(
                        model=self.model,
                        contents=user_prompt,
                        config=response_config,
                    )
                    content = getattr(raw_message, "text", "")
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
            except (TimeoutError, ConnectionError) as exc:
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
                _emit_stream_event(
                    stream_callback,
                    event_type="provider_retrying",
                    payload={
                        "provider": self.provider,
                        "model": self.model,
                        "attempt": attempt,
                        "max_retries": max_retries,
                        "backoff_seconds": round(backoff_seconds, 3),
                        "error": str(exc),
                    },
                )
                await asyncio.sleep(backoff_seconds)
                backoff_seconds = min(10.0, backoff_seconds * 2.0)
            except GeminiAPIError as exc:
                status_code = self._extract_status_code(exc)
                retryable_status = isinstance(status_code, int) and (
                    status_code in {408, 409, 429} or status_code >= 500
                )

                if retryable_status and attempt < max_retries:
                    logger.warning(
                        "agent_call_retrying",
                        model=self.model,
                        provider=self.provider,
                        attempt=attempt,
                        backoff_seconds=backoff_seconds,
                        status_code=status_code,
                        error=str(exc),
                    )
                    _emit_stream_event(
                        stream_callback,
                        event_type="provider_retrying",
                        payload={
                            "provider": self.provider,
                            "model": self.model,
                            "attempt": attempt,
                            "max_retries": max_retries,
                            "status_code": status_code,
                            "backoff_seconds": round(backoff_seconds, 3),
                            "error": str(exc),
                        },
                    )
                    await asyncio.sleep(backoff_seconds)
                    backoff_seconds = min(10.0, backoff_seconds * 2.0)
                    continue

                if retryable_status:
                    logger.error(
                        "agent_call_retry_exhausted",
                        model=self.model,
                        provider=self.provider,
                        attempt=attempt,
                        status_code=status_code,
                        error=str(exc),
                    )
                    raise AgentCallError(
                        f"Model call failed after retries for model {self.model}."
                    ) from exc

                logger.error(
                    "agent_call_non_retryable_failure",
                    model=self.model,
                    provider=self.provider,
                    attempt=attempt,
                    status_code=status_code,
                    error=str(exc),
                )
                raise AgentCallError(
                    f"Gemini API returned status {status_code} for model {self.model}."
                ) from exc
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

    @staticmethod
    def _extract_status_code(error: Exception) -> int | None:
        """Extract HTTP-like status code from provider exceptions when available."""

        status_code = getattr(error, "status_code", None)
        if isinstance(status_code, int):
            return status_code

        code = getattr(error, "code", None)
        if isinstance(code, int):
            return code

        response = getattr(error, "response", None)
        if response is not None:
            nested_code = getattr(response, "status_code", None)
            if isinstance(nested_code, int):
                return nested_code

        return None

    async def _stream_gemini_text(
        self,
        user_prompt: str,
        stream_config: Any,
        stream_callback: Callable[[str], None] | None,
    ) -> tuple[str, Any | None]:
        """Stream Gemini text chunks and return full text plus last chunk metadata."""

        if self._gemini_client is None:
            raise AgentCallError("Gemini client was not initialized.")

        chunks: list[str] = []
        last_chunk: Any | None = None

        stream_response = await self._gemini_client.aio.models.generate_content_stream(
            model=self.model,
            contents=user_prompt,
            config=stream_config,
        )
        async for chunk in stream_response:
            last_chunk = chunk

            saw_explicit_parts = False
            candidates = getattr(chunk, "candidates", None)
            if isinstance(candidates, list):
                for candidate in candidates:
                    content = getattr(candidate, "content", None)
                    parts = getattr(content, "parts", None)
                    if not isinstance(parts, list) or not parts:
                        continue
                    saw_explicit_parts = True
                    for part in parts:
                        part_text = getattr(part, "text", None)
                        if not isinstance(part_text, str) or not part_text:
                            continue

                        if bool(getattr(part, "thought", False)):
                            if stream_callback is not None:
                                try:
                                    stream_callback(
                                        f"{_STREAM_EVENT_PREFIX}thinking_delta"
                                        f"{_STREAM_EVENT_SEPARATOR}{part_text}"
                                    )
                                except Exception as exc:  # pragma: no cover
                                    logger.warning("stream_callback_error", error=str(exc))
                            continue

                        chunks.append(part_text)
                        if stream_callback is not None:
                            try:
                                stream_callback(part_text)
                            except Exception as exc:  # pragma: no cover
                                logger.warning("stream_callback_error", error=str(exc))

            if saw_explicit_parts:
                continue

            chunk_text = getattr(chunk, "text", None)
            if isinstance(chunk_text, str) and chunk_text:
                chunks.append(chunk_text)
                if stream_callback is not None:
                    try:
                        stream_callback(chunk_text)
                    except Exception as exc:  # pragma: no cover
                        logger.warning("stream_callback_error", error=str(exc))

        return "".join(chunks), last_chunk

    def _parse_gemini_structured_response(
        self,
        raw_message: Any,
        response_format: type[BaseModel],
    ) -> BaseModel:
        """Parse and validate Gemini JSON output into a Pydantic model."""

        raw_text = getattr(raw_message, "text", "")
        return self._parse_structured_text_payload(
            text=raw_text,
            response_format=response_format,
            provider_label="Gemini",
        )

    async def _call_openrouter(
        self,
        system_prompt: str,
        user_prompt: str,
        response_format: type[BaseModel] | None,
        temperature: float | None,
        stream: bool,
        stream_callback: Callable[[str], None] | None,
    ) -> tuple[str | BaseModel, dict[str, Any]]:
        """Execute one OpenRouter call via OpenAI-compatible chat completions."""

        if self._openrouter_client is None:
            raise AgentCallError("OpenRouter client was not initialized.")

        effective_temperature = self.temperature if temperature is None else temperature
        backoff_seconds = 0.5
        max_retries = 3

        for attempt in range(1, max_retries + 1):
            start = time.perf_counter()
            try:
                messages = [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ]

                request_kwargs: dict[str, Any] = {
                    "model": self.model,
                    "messages": messages,
                    "temperature": effective_temperature,
                    "max_tokens": self._kimi_max_tokens,
                    "extra_body": {"reasoning": self._build_openrouter_reasoning_payload()},
                }

                if response_format is not None:
                    messages[1] = {
                        "role": "user",
                        "content": self._with_structured_json_instructions(
                            user_prompt=user_prompt,
                            response_format=response_format,
                        ),
                    }
                    request_kwargs["response_format"] = {"type": "json_object"}

                raw_message: Any | None = None
                response_content: str | BaseModel = ""
                if stream:
                    request_kwargs["stream"] = True
                    stream_response = await self._openrouter_client.chat.completions.create(
                        **request_kwargs
                    )
                    response_content, raw_message = await self._stream_openrouter_text(
                        stream_response=stream_response,
                        stream_callback=stream_callback,
                    )
                else:
                    raw_message = await self._openrouter_client.chat.completions.create(
                        **request_kwargs
                    )
                    if response_format is not None:
                        response_content = self._parse_openrouter_structured_response(
                            raw_message=raw_message,
                            response_format=response_format,
                        )
                    else:
                        response_content = self._extract_openrouter_text(raw_message)

                elapsed_ms = (time.perf_counter() - start) * 1000.0
                usage = self._normalize_usage(raw_message, elapsed_ms)

                logger.info(
                    "agent_call_success",
                    model=self.model,
                    provider=self.provider,
                    input_tokens=usage["input_tokens"],
                    output_tokens=usage["output_tokens"],
                    reasoning_tokens=usage.get("reasoning_tokens", 0),
                    latency_ms=usage["latency_ms"],
                    streamed=stream,
                    thinking_trace_present=usage.get("thinking_trace_present", False),
                )
                return response_content, usage
            except OpenAIRateLimitError as exc:
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
                _emit_stream_event(
                    stream_callback,
                    event_type="provider_retrying",
                    payload={
                        "provider": self.provider,
                        "model": self.model,
                        "attempt": attempt,
                        "max_retries": max_retries,
                        "backoff_seconds": round(backoff_seconds, 3),
                        "error": str(exc),
                    },
                )
                await asyncio.sleep(backoff_seconds)
                backoff_seconds *= 2.0
            except (OpenAIAPIConnectionError, OpenAIAPITimeoutError, TimeoutError) as exc:
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
                _emit_stream_event(
                    stream_callback,
                    event_type="provider_retrying",
                    payload={
                        "provider": self.provider,
                        "model": self.model,
                        "attempt": attempt,
                        "max_retries": max_retries,
                        "backoff_seconds": round(backoff_seconds, 3),
                        "error": str(exc),
                    },
                )
                await asyncio.sleep(backoff_seconds)
                backoff_seconds *= 2.0
            except OpenAIAPIStatusError as exc:
                status_code = getattr(exc, "status_code", None)
                retryable_status = isinstance(status_code, int) and (
                    status_code in {408, 409, 429} or status_code >= 500
                )

                if retryable_status and attempt < max_retries:
                    logger.warning(
                        "agent_call_retrying",
                        model=self.model,
                        provider=self.provider,
                        attempt=attempt,
                        backoff_seconds=backoff_seconds,
                        status_code=status_code,
                        error=str(exc),
                    )
                    _emit_stream_event(
                        stream_callback,
                        event_type="provider_retrying",
                        payload={
                            "provider": self.provider,
                            "model": self.model,
                            "attempt": attempt,
                            "max_retries": max_retries,
                            "status_code": status_code,
                            "backoff_seconds": round(backoff_seconds, 3),
                            "error": str(exc),
                        },
                    )
                    await asyncio.sleep(backoff_seconds)
                    backoff_seconds *= 2.0
                    continue

                if retryable_status:
                    logger.error(
                        "agent_call_retry_exhausted",
                        model=self.model,
                        provider=self.provider,
                        attempt=attempt,
                        status_code=status_code,
                        error=str(exc),
                    )
                    raise AgentCallError(
                        f"Model call failed after retries for model {self.model}."
                    ) from exc

                logger.error(
                    "agent_call_non_retryable_failure",
                    model=self.model,
                    provider=self.provider,
                    attempt=attempt,
                    status_code=status_code,
                    error=str(exc),
                )
                raise AgentCallError(
                    f"OpenRouter API returned status {status_code} for model {self.model}."
                ) from exc
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

    async def _call_claude(
        self,
        system_prompt: str,
        user_prompt: str,
        response_format: type[BaseModel] | None,
        temperature: float | None,
        stream: bool,
        stream_callback: Callable[[str], None] | None,
    ) -> tuple[str | BaseModel, dict[str, Any]]:
        """Execute one Claude call using the direct Anthropic SDK."""

        if self._anthropic_client is None:
            raise AgentCallError("Anthropic client was not initialized.")

        effective_temperature = self.temperature if temperature is None else temperature
        thinking_config = self._build_claude_thinking_config()
        if thinking_config is not None and effective_temperature != 1.0:
            logger.debug(
                "claude_temperature_adjusted_for_thinking",
                model=self.model,
                requested_temperature=effective_temperature,
                adjusted_temperature=1.0,
            )
            effective_temperature = 1.0
        backoff_seconds = 0.5
        max_retries = 3

        for attempt in range(1, max_retries + 1):
            start = time.perf_counter()
            try:
                raw_message: Any | None = None
                response_content: str | BaseModel = ""
                if response_format is not None and not stream:
                    parsed_via_sdk = False
                    messages_api = getattr(self._anthropic_client, "messages", None)
                    parse_api = getattr(messages_api, "parse", None)
                    if callable(parse_api):
                        try:
                            await self._acquire_anthropic_slot(request_kind="messages.parse")
                            parse_kwargs = self._anthropic_kwargs_with_optional_output_config(
                                parse_api,
                                {
                                    "model": self.model,
                                    "max_tokens": self._anthropic_max_tokens,
                                    "temperature": effective_temperature,
                                    "system": system_prompt,
                                    "messages": [{"role": "user", "content": user_prompt}],
                                    "output_format": response_format,
                                    "thinking": thinking_config,
                                },
                            )
                            parse_result = parse_api(**parse_kwargs)
                            if inspect.isawaitable(parse_result):
                                raw_message = await cast(Awaitable[Any], parse_result)
                            else:
                                raw_message = parse_result
                            parsed_output = getattr(raw_message, "parsed_output", None)
                            if parsed_output is None:
                                parsed_output = getattr(raw_message, "parsed", None)
                            if isinstance(parsed_output, response_format):
                                response_content = parsed_output
                                parsed_via_sdk = True
                            else:
                                logger.warning(
                                    "anthropic_parse_unexpected_payload",
                                    model=self.model,
                                    payload_type=type(parsed_output).__name__,
                                )
                        except (TypeError, AttributeError) as exc:
                            logger.warning(
                                "anthropic_parse_unavailable",
                                model=self.model,
                                error=str(exc),
                            )

                    if not parsed_via_sdk:
                        structured_user_prompt = self._with_structured_json_instructions(
                            user_prompt=user_prompt,
                            response_format=response_format,
                        )
                        raw_message = await self._anthropic_messages_create(
                            system_prompt=system_prompt,
                            user_prompt=structured_user_prompt,
                            temperature=effective_temperature,
                        )
                        response_content = self._parse_anthropic_structured_response(
                            raw_message=raw_message,
                            response_format=response_format,
                        )
                elif stream:
                    structured_user_prompt = (
                        self._with_structured_json_instructions(
                            user_prompt=user_prompt,
                            response_format=response_format,
                        )
                        if response_format is not None
                        else user_prompt
                    )
                    response_content, raw_message = await self._stream_anthropic_text(
                        system_prompt=system_prompt,
                        user_prompt=structured_user_prompt,
                        temperature=effective_temperature,
                        stream_callback=stream_callback,
                    )
                    if response_format is not None:
                        response_content = self._parse_structured_text_payload(
                            text=response_content,
                            response_format=response_format,
                            provider_label="Claude",
                        )
                else:
                    raw_message = await self._anthropic_messages_create(
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        temperature=effective_temperature,
                    )
                    response_content = self._extract_anthropic_text(raw_message)

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
            except AnthropicRateLimitError as exc:
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
                _emit_stream_event(
                    stream_callback,
                    event_type="provider_retrying",
                    payload={
                        "provider": self.provider,
                        "model": self.model,
                        "attempt": attempt,
                        "max_retries": max_retries,
                        "backoff_seconds": round(backoff_seconds, 3),
                        "error": str(exc),
                    },
                )
                await asyncio.sleep(backoff_seconds)
                backoff_seconds *= 2.0
            except (AnthropicAPIConnectionError, AnthropicAPITimeoutError, TimeoutError) as exc:
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
                _emit_stream_event(
                    stream_callback,
                    event_type="provider_retrying",
                    payload={
                        "provider": self.provider,
                        "model": self.model,
                        "attempt": attempt,
                        "max_retries": max_retries,
                        "backoff_seconds": round(backoff_seconds, 3),
                        "error": str(exc),
                    },
                )
                await asyncio.sleep(backoff_seconds)
                backoff_seconds *= 2.0
            except AgentCallError:
                raise
            except AnthropicAPIStatusError as exc:
                status_code = getattr(exc, "status_code", None)
                retryable_status = isinstance(status_code, int) and (
                    status_code in {408, 409, 429} or status_code >= 500
                )

                if retryable_status:
                    if attempt >= max_retries:
                        logger.error(
                            "agent_call_retry_exhausted",
                            model=self.model,
                            provider=self.provider,
                            attempt=attempt,
                            status_code=status_code,
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
                        status_code=status_code,
                        error=str(exc),
                    )
                    _emit_stream_event(
                        stream_callback,
                        event_type="provider_retrying",
                        payload={
                            "provider": self.provider,
                            "model": self.model,
                            "attempt": attempt,
                            "max_retries": max_retries,
                            "status_code": status_code,
                            "backoff_seconds": round(backoff_seconds, 3),
                            "error": str(exc),
                        },
                    )
                    await asyncio.sleep(backoff_seconds)
                    backoff_seconds *= 2.0
                    continue

                logger.error(
                    "agent_call_non_retryable_failure",
                    model=self.model,
                    provider=self.provider,
                    attempt=attempt,
                    status_code=status_code,
                    error=str(exc),
                )
                raise AgentCallError(
                    f"Anthropic API returned status {status_code} for model {self.model}."
                ) from exc
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

    async def _call_openrouter(
        self,
        system_prompt: str,
        user_prompt: str,
        response_format: type[BaseModel] | None,
        temperature: float | None,
        stream: bool,
        stream_callback: Callable[[str], None] | None,
    ) -> tuple[str | BaseModel, dict[str, Any]]:
        """Execute one OpenRouter call via OpenAI-compatible chat completions."""

        if self._openrouter_client is None:
            raise AgentCallError("OpenRouter client was not initialized.")

        effective_temperature = self.temperature if temperature is None else temperature
        backoff_seconds = 0.5
        max_retries = 3

        for attempt in range(1, max_retries + 1):
            start = time.perf_counter()
            try:
                messages = [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ]

                request_kwargs: dict[str, Any] = {
                    "model": self.model,
                    "messages": messages,
                    "temperature": effective_temperature,
                    "max_tokens": self._kimi_max_tokens,
                    "extra_body": {"reasoning": self._build_openrouter_reasoning_payload()},
                }

                if response_format is not None and not stream:
                    messages[1] = {
                        "role": "user",
                        "content": self._with_structured_json_instructions(
                            user_prompt=user_prompt,
                            response_format=response_format,
                        ),
                    }
                    request_kwargs["response_format"] = {"type": "json_object"}
                elif response_format is not None:
                    messages[1] = {
                        "role": "user",
                        "content": self._with_structured_json_instructions(
                            user_prompt=user_prompt,
                            response_format=response_format,
                        ),
                    }

                raw_message: Any | None = None
                if stream:
                    request_kwargs["stream"] = True
                    stream_response = await self._openrouter_client.chat.completions.create(
                        **request_kwargs
                    )
                    response_content, raw_message = await self._stream_openrouter_text(
                        stream_response=stream_response,
                        stream_callback=stream_callback,
                    )
                    if response_format is not None:
                        response_content = self._parse_structured_text_payload(
                            text=response_content,
                            response_format=response_format,
                            provider_label="OpenRouter",
                        )
                else:
                    raw_message = await self._openrouter_client.chat.completions.create(
                        **request_kwargs
                    )
                    if response_format is not None:
                        response_content = self._parse_openrouter_structured_response(
                            raw_message=raw_message,
                            response_format=response_format,
                        )
                    else:
                        response_content = self._extract_openrouter_text(raw_message)

                elapsed_ms = (time.perf_counter() - start) * 1000.0
                usage = self._normalize_usage(raw_message, elapsed_ms)

                logger.info(
                    "agent_call_success",
                    model=self.model,
                    provider=self.provider,
                    input_tokens=usage["input_tokens"],
                    output_tokens=usage["output_tokens"],
                    reasoning_tokens=usage.get("reasoning_tokens", 0),
                    latency_ms=usage["latency_ms"],
                    streamed=stream,
                    thinking_trace_present=usage.get("thinking_trace_present", False),
                )
                return response_content, usage
            except OpenAIRateLimitError as exc:
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
                _emit_stream_event(
                    stream_callback,
                    event_type="provider_retrying",
                    payload={
                        "provider": self.provider,
                        "model": self.model,
                        "attempt": attempt,
                        "max_retries": max_retries,
                        "backoff_seconds": round(backoff_seconds, 3),
                        "error": str(exc),
                    },
                )
                await asyncio.sleep(backoff_seconds)
                backoff_seconds *= 2.0
            except (OpenAIAPIConnectionError, OpenAIAPITimeoutError, TimeoutError) as exc:
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
            except OpenAIAPIStatusError as exc:
                status_code = getattr(exc, "status_code", None)
                retryable_status = isinstance(status_code, int) and (
                    status_code in {408, 409, 429} or status_code >= 500
                )

                if retryable_status and attempt < max_retries:
                    logger.warning(
                        "agent_call_retrying",
                        model=self.model,
                        provider=self.provider,
                        attempt=attempt,
                        backoff_seconds=backoff_seconds,
                        status_code=status_code,
                        error=str(exc),
                    )
                    _emit_stream_event(
                        stream_callback,
                        event_type="provider_retrying",
                        payload={
                            "provider": self.provider,
                            "model": self.model,
                            "attempt": attempt,
                            "max_retries": max_retries,
                            "status_code": status_code,
                            "backoff_seconds": round(backoff_seconds, 3),
                            "error": str(exc),
                        },
                    )
                    await asyncio.sleep(backoff_seconds)
                    backoff_seconds *= 2.0
                    continue

                if retryable_status:
                    logger.error(
                        "agent_call_retry_exhausted",
                        model=self.model,
                        provider=self.provider,
                        attempt=attempt,
                        status_code=status_code,
                        error=str(exc),
                    )
                    raise AgentCallError(
                        f"Model call failed after retries for model {self.model}."
                    ) from exc

                logger.error(
                    "agent_call_non_retryable_failure",
                    model=self.model,
                    provider=self.provider,
                    attempt=attempt,
                    status_code=status_code,
                    error=str(exc),
                )
                raise AgentCallError(
                    f"OpenRouter API returned status {status_code} for model {self.model}."
                ) from exc
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

    async def _stream_openrouter_text(
        self,
        stream_response: Any,
        stream_callback: Callable[[str], None] | None,
    ) -> tuple[str, Any | None]:
        """Stream OpenRouter text chunks and return full text plus last chunk metadata."""

        chunks: list[str] = []
        last_chunk: Any | None = None

        async for chunk in stream_response:
            last_chunk = chunk
            chunk_text: str | None = None
            choices = getattr(chunk, "choices", None)
            if isinstance(choices, list) and choices:
                first_choice = choices[0]
                delta = getattr(first_choice, "delta", None)
                if delta is not None:
                    chunk_text = getattr(delta, "content", None)
                elif isinstance(first_choice, dict):
                    delta_dict = first_choice.get("delta")
                    if isinstance(delta_dict, dict):
                        chunk_text = delta_dict.get("content")

            if isinstance(chunk_text, str) and chunk_text:
                chunks.append(chunk_text)
                if stream_callback is not None:
                    try:
                        stream_callback(chunk_text)
                    except Exception as exc:  # pragma: no cover
                        logger.warning("stream_callback_error", error=str(exc))

        return "".join(chunks), last_chunk

    @staticmethod
    def _build_openrouter_headers(config: Any) -> dict[str, str]:
        """Build optional OpenRouter app attribution headers."""

        headers: dict[str, str] = {}
        if config.openrouter_http_referer:
            headers["HTTP-Referer"] = config.openrouter_http_referer
        if config.openrouter_app_title:
            headers["X-OpenRouter-Title"] = config.openrouter_app_title
            if config.openrouter_legacy_x_title_enabled:
                headers["X-Title"] = config.openrouter_app_title
        return headers

    def _build_openrouter_reasoning_payload(self) -> dict[str, Any]:
        """Return explicit Kimi reasoning controls to avoid provider defaults."""

        reasoning: dict[str, Any] = {"exclude": self._kimi_reasoning_exclude}
        if self._kimi_reasoning_effort:
            reasoning["effort"] = self._kimi_reasoning_effort
        return reasoning

    def _build_gemini_thinking_config(self) -> Any | None:
        """Build Gemini thinking config without hard-failing on SDK schema drift."""

        if genai_types is None:
            return None

        normalized_level = (self.thinking_level or "").strip().upper()
        if normalized_level:
            thinking_level_enum = getattr(genai_types, "ThinkingLevel", None)
            if thinking_level_enum is not None:
                thinking_level = getattr(thinking_level_enum, normalized_level, None)
                if thinking_level is not None:
                    try:
                        return genai_types.ThinkingConfig(
                            includeThoughts=True,
                            thinkingLevel=thinking_level,
                        )
                    except Exception as exc:
                        logger.warning(
                            "gemini_thinking_config_unavailable",
                            model=self.model,
                            thinking_level=self.thinking_level,
                            thinking_budget=self.thinking_budget,
                            error=str(exc),
                        )
            else:
                logger.warning(
                    "gemini_thinking_level_enum_missing",
                    model=self.model,
                    thinking_level=self.thinking_level,
                )

        if self.enable_thinking and self.thinking_budget is not None:
            try:
                return genai_types.ThinkingConfig(
                    includeThoughts=True,
                    thinkingBudget=self.thinking_budget,
                )
            except Exception as exc:
                logger.warning(
                    "gemini_thinking_config_unavailable",
                    model=self.model,
                    thinking_level=self.thinking_level,
                    thinking_budget=self.thinking_budget,
                    error=str(exc),
                )
        return None

    def _build_claude_thinking_config(self) -> dict[str, str]:
        """Return adaptive thinking settings for Claude 4.6 models."""

        return {
            "type": "adaptive",
            "display": self._claude_thinking_display,
        }

    def _build_claude_output_config(self) -> dict[str, str]:
        """Return Claude effort settings."""

        return {"effort": self._claude_effort}

    @staticmethod
    def _supports_callable_argument(callable_obj: Any, argument: str) -> bool:
        """Return whether one SDK callable appears to support a given argument."""

        try:
            signature = inspect.signature(callable_obj)
            if argument in signature.parameters:
                return True
            return any(
                parameter.kind == inspect.Parameter.VAR_KEYWORD
                for parameter in signature.parameters.values()
            )
        except (TypeError, ValueError):
            return False

    def _anthropic_kwargs_with_optional_output_config(
        self,
        callable_obj: Any,
        kwargs: dict[str, Any],
    ) -> dict[str, Any]:
        """Add Claude output config only when supported by the installed SDK method."""

        if self._supports_callable_argument(callable_obj, "output_config"):
            kwargs["output_config"] = self._build_claude_output_config()
        return kwargs

    async def _acquire_anthropic_slot(self, request_kind: str) -> None:
        """Throttle Anthropic requests to reduce server-side rate-limit failures."""

        if self._anthropic_throttle is None:
            return

        waited_seconds = await self._anthropic_throttle.acquire()
        if waited_seconds > 0:
            logger.info(
                "anthropic_request_throttled",
                model=self.model,
                request_kind=request_kind,
                wait_ms=round(waited_seconds * 1000.0, 2),
                limit_rpm=self._anthropic_requests_per_minute,
                window_seconds=self._anthropic_throttle_window_seconds,
            )

    async def _anthropic_messages_create(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
    ) -> Any:
        """Create one Anthropic message response."""

        if self._anthropic_client is None:
            raise AgentCallError("Anthropic client was not initialized.")

        await self._acquire_anthropic_slot(request_kind="messages.create")

        create_api = self._anthropic_client.messages.create
        create_kwargs = self._anthropic_kwargs_with_optional_output_config(
            create_api,
            {
                "model": self.model,
                "max_tokens": self._anthropic_max_tokens,
                "temperature": temperature,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_prompt}],
                "thinking": self._build_claude_thinking_config(),
            },
        )
        return await create_api(**create_kwargs)

    async def _stream_anthropic_text(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
        stream_callback: Callable[[str], None] | None,
    ) -> tuple[str, Any]:
        """Stream Anthropic text chunks and return final concatenated content."""

        if self._anthropic_client is None:
            raise AgentCallError("Anthropic client was not initialized.")

        chunks: list[str] = []
        stream_api = self._anthropic_client.messages.stream
        stream_kwargs = self._anthropic_kwargs_with_optional_output_config(
            stream_api,
            {
                "model": self.model,
                "max_tokens": self._anthropic_max_tokens,
                "temperature": temperature,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_prompt}],
                "thinking": self._build_claude_thinking_config(),
            },
        )
        async with stream_api(**stream_kwargs) as stream_response:
            await self._acquire_anthropic_slot(request_kind="messages.stream")
            async for event in stream_response:
                event_type = getattr(event, "type", None)
                if event_type != "content_block_delta":
                    continue

                delta = getattr(event, "delta", None)
                delta_type = getattr(delta, "type", None)
                if delta_type == "text_delta":
                    text_chunk = getattr(delta, "text", None)
                    if isinstance(text_chunk, str) and text_chunk:
                        chunks.append(text_chunk)
                        if stream_callback is not None:
                            try:
                                stream_callback(text_chunk)
                            except Exception as exc:  # pragma: no cover
                                logger.warning("stream_callback_error", error=str(exc))
                elif delta_type == "thinking_delta":
                    thinking_chunk = getattr(delta, "thinking", None)
                    if (
                        isinstance(thinking_chunk, str)
                        and thinking_chunk
                        and stream_callback is not None
                    ):
                        try:
                            stream_callback(
                                f"{_STREAM_EVENT_PREFIX}thinking_delta"
                                f"{_STREAM_EVENT_SEPARATOR}{thinking_chunk}"
                            )
                        except Exception as exc:  # pragma: no cover
                            logger.warning("stream_callback_error", error=str(exc))
            final_message = await stream_response.get_final_message()

        return "".join(chunks), final_message

    async def _stream_openrouter_text(
        self,
        stream_response: Any,
        stream_callback: Callable[[str], None] | None,
    ) -> tuple[str, Any | None]:
        """Stream OpenRouter text chunks and return full text plus last chunk metadata."""

        chunks: list[str] = []
        last_chunk: Any | None = None

        async for chunk in stream_response:
            last_chunk = chunk
            chunk_text: str | None = None
            choices = getattr(chunk, "choices", None)
            if isinstance(choices, list) and choices:
                first_choice = choices[0]
                delta = getattr(first_choice, "delta", None)
                if delta is not None:
                    chunk_text = getattr(delta, "content", None)
                elif isinstance(first_choice, dict):
                    delta_dict = first_choice.get("delta")
                    if isinstance(delta_dict, dict):
                        chunk_text = delta_dict.get("content")

            if isinstance(chunk_text, str) and chunk_text:
                chunks.append(chunk_text)
                if stream_callback is not None:
                    try:
                        stream_callback(chunk_text)
                    except Exception as exc:  # pragma: no cover
                        logger.warning("stream_callback_error", error=str(exc))

        return "".join(chunks), last_chunk

    @staticmethod
    def _build_openrouter_headers(config: Any) -> dict[str, str]:
        """Build optional OpenRouter app attribution headers."""

        headers: dict[str, str] = {}
        if config.openrouter_http_referer:
            headers["HTTP-Referer"] = config.openrouter_http_referer
        if config.openrouter_app_title:
            headers["X-OpenRouter-Title"] = config.openrouter_app_title
            if config.openrouter_legacy_x_title_enabled:
                headers["X-Title"] = config.openrouter_app_title
        return headers

    def _build_openrouter_reasoning_payload(self) -> dict[str, Any]:
        """Return explicit Kimi reasoning controls to avoid provider defaults."""

        reasoning: dict[str, Any] = {"exclude": self._kimi_reasoning_exclude}
        if self._kimi_reasoning_effort:
            reasoning["effort"] = self._kimi_reasoning_effort
        return reasoning

    @staticmethod
    def _with_structured_json_instructions(
        user_prompt: str,
        response_format: type[BaseModel],
    ) -> str:
        """Add strict JSON instructions for structured provider responses."""

        schema = json.dumps(response_format.model_json_schema(), ensure_ascii=True)
        return (
            f"{user_prompt}\n\n"
            "Return only valid JSON matching the following JSON Schema. "
            "Do not include markdown fences or explanatory text.\n"
            f"{schema}"
        )

    def _parse_anthropic_structured_response(
        self,
        raw_message: Any,
        response_format: type[BaseModel],
    ) -> BaseModel:
        """Parse and validate structured Claude JSON output into a Pydantic model."""

        raw_text = self._extract_anthropic_text(raw_message)
        return self._parse_structured_text_payload(
            text=raw_text,
            response_format=response_format,
            provider_label="Claude",
        )

    def _parse_openrouter_structured_response(
        self,
        raw_message: Any,
        response_format: type[BaseModel],
    ) -> BaseModel:
        """Parse and validate structured OpenRouter JSON output into a Pydantic model."""

        raw_text = self._extract_openrouter_text(raw_message)
        return self._parse_structured_text_payload(
            text=raw_text,
            response_format=response_format,
            provider_label="OpenRouter",
        )

    def _parse_structured_text_payload(
        self,
        *,
        text: str,
        response_format: type[BaseModel],
        provider_label: str,
    ) -> BaseModel:
        """Parse a structured JSON payload from plain text."""

        if not isinstance(text, str) or not text.strip():
            raise AgentCallError(f"{provider_label} structured response was empty.")

        json_payload = self._extract_json_payload(text)
        try:
            parsed = json.loads(json_payload)
        except json.JSONDecodeError as exc:
            raise AgentCallError(
                f"{provider_label} structured response was not valid JSON."
            ) from exc

        if isinstance(parsed, list) and "analyses" in response_format.model_fields:
            parsed = {"analyses": parsed}

        try:
            return response_format.model_validate(parsed)
        except ValidationError as exc:
            raise AgentCallError(
                f"{provider_label} structured response did not match expected format "
                f"{response_format.__name__}."
            ) from exc

    @staticmethod
    def _extract_json_payload(text: str) -> str:
        """Return JSON payload only when the whole response is JSON."""

        cleaned = text.strip()
        if cleaned.startswith("```"):
            lines = cleaned.splitlines()
            if len(lines) >= 3 and lines[0].startswith("```") and lines[-1].strip() == "```":
                cleaned = "\n".join(lines[1:-1]).strip()

        decoder = json.JSONDecoder()
        try:
            _parsed, end = decoder.raw_decode(cleaned)
        except json.JSONDecodeError:
            return cleaned
        if cleaned[end:].strip():
            return cleaned
        return cleaned

    @staticmethod
    def _extract_anthropic_text(raw_message: Any) -> str:
        """Extract plain text from Anthropic message content blocks."""

        content = getattr(raw_message, "content", None)
        if isinstance(content, str):
            return content

        if not isinstance(content, list):
            return str(content) if content is not None else ""

        text_parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                block_type = block.get("type")
                text = block.get("text")
            else:
                block_type = getattr(block, "type", None)
                text = getattr(block, "text", None)

            if block_type == "text" and isinstance(text, str):
                text_parts.append(text)

        return "".join(text_parts)

    @staticmethod
    def _extract_openrouter_text(raw_message: Any) -> str:
        """Extract plain text from OpenRouter chat completion payloads."""

        choices = getattr(raw_message, "choices", None)
        if not isinstance(choices, list) or not choices:
            return ""

        first_choice = choices[0]
        if isinstance(first_choice, dict):
            message = first_choice.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    return content
                if content is None:
                    return ""
                return str(content)
            return ""

        message = getattr(first_choice, "message", None)
        if message is None:
            return ""
        content = getattr(message, "content", None)
        if isinstance(content, str):
            return content
        if content is None:
            return ""
        return str(content)

    def _normalize_usage(self, raw_message: Any | None, latency_ms: float) -> dict[str, Any]:
        """Normalize token usage metadata across provider response formats."""

        def _field_present(source: Any, name: str) -> bool:
            if isinstance(source, dict):
                return name in source

            fields_set = getattr(source, "model_fields_set", None)
            if not isinstance(fields_set, (set, frozenset)):
                fields_set = getattr(source, "__fields_set__", None)
            if isinstance(fields_set, (set, frozenset)):
                return name in fields_set

            return hasattr(source, name)

        def _pick_int(source: Any, *names: str) -> int | None:
            for name in names:
                if isinstance(source, dict):
                    if name not in source:
                        continue
                    value = source.get(name)
                else:
                    if not _field_present(source, name):
                        continue
                    value = getattr(source, name, None)
                if value is None:
                    continue
                try:
                    return max(0, int(value))
                except (TypeError, ValueError):
                    continue
            return None

        def _coalesce_int(*values: int | None) -> int | None:
            for value in values:
                if value is not None:
                    return value
            return None

        def _sum_ints(*values: int | None) -> int | None:
            total = 0
            found = False
            for value in values:
                if value is None:
                    continue
                total += max(0, int(value))
                found = True
            return total if found else None

        def _extract_prompt_tokens(source: Any) -> int | None:
            base_input = _pick_int(source, "input_tokens", "prompt_tokens", "prompt_token_count")
            cache_creation_tokens = _pick_int(source, "cache_creation_input_tokens")
            if cache_creation_tokens is None:
                cache_creation = None
                if isinstance(source, dict):
                    cache_creation = source.get("cache_creation")
                else:
                    cache_creation = getattr(source, "cache_creation", None)
                cache_creation_tokens = _pick_int(
                    cache_creation,
                    "ephemeral_1h_input_tokens",
                    "ephemeral_5m_input_tokens",
                )
            cache_read_tokens = _pick_int(
                source,
                "cache_read_input_tokens",
            )
            return _sum_ints(base_input, cache_creation_tokens, cache_read_tokens)

        input_tokens: int | None = None
        output_tokens: int | None = None
        thinking_tokens: int | None = None
        reasoning_tokens: int | None = None
        total_tokens: int | None = None

        if raw_message is not None:
            usage_metadata = getattr(raw_message, "usage_metadata", None)
            if usage_metadata is not None:
                input_tokens = _coalesce_int(input_tokens, _extract_prompt_tokens(usage_metadata))
                output_tokens = _coalesce_int(
                    output_tokens,
                    _pick_int(
                        usage_metadata,
                        "output_tokens",
                        "response_token_count",
                        "responseTokenCount",
                        "candidates_token_count",
                        "candidatesTokenCount",
                        "completion_tokens",
                        "completionTokens",
                    ),
                )
                thinking_tokens = _coalesce_int(
                    thinking_tokens,
                    _pick_int(
                        usage_metadata,
                        "thinking_tokens",
                        "thoughts_token_count",
                        "thoughtsTokenCount",
                        "reasoning_tokens",
                        "reasoningTokens",
                    ),
                )
                total_tokens = _coalesce_int(
                    total_tokens,
                    _pick_int(
                        usage_metadata,
                        "total_tokens",
                        "total_token_count",
                        "totalTokenCount",
                    ),
                )

            response_metadata = getattr(raw_message, "response_metadata", None)
            if isinstance(response_metadata, dict):
                response_usage = response_metadata.get("usage")
                input_tokens = _coalesce_int(input_tokens, _extract_prompt_tokens(response_usage))
                output_tokens = _coalesce_int(
                    output_tokens,
                    _pick_int(
                        response_usage,
                        "output_tokens",
                        "response_token_count",
                        "responseTokenCount",
                        "completion_tokens",
                        "candidates_token_count",
                    ),
                )
                thinking_tokens = _coalesce_int(
                    thinking_tokens,
                    _pick_int(
                        response_usage,
                        "thinking_tokens",
                        "thoughts_token_count",
                        "reasoning_tokens",
                    ),
                )
                total_tokens = _coalesce_int(
                    total_tokens,
                    _pick_int(response_usage, "total_tokens", "total_token_count"),
                )

            usage = getattr(raw_message, "usage", None)
            if usage is not None:
                input_tokens = _coalesce_int(input_tokens, _extract_prompt_tokens(usage))
                output_tokens = _coalesce_int(
                    output_tokens,
                    _pick_int(
                        usage,
                        "output_tokens",
                        "response_token_count",
                        "responseTokenCount",
                        "completion_tokens",
                        "candidates_token_count",
                        "candidatesTokenCount",
                    ),
                )
                thinking_tokens = _coalesce_int(
                    thinking_tokens,
                    _pick_int(usage, "thinking_tokens", "reasoning_tokens"),
                )
                total_tokens = _coalesce_int(total_tokens, _pick_int(usage, "total_tokens"))
                completion_details = getattr(usage, "completion_tokens_details", None)
                if completion_details is None and isinstance(usage, dict):
                    completion_details = usage.get("completion_tokens_details")
                if completion_details is not None:
                    reasoning_tokens = _coalesce_int(
                        reasoning_tokens,
                        _pick_int(completion_details, "reasoning_tokens"),
                    )

        if thinking_tokens is None and reasoning_tokens is not None:
            thinking_tokens = reasoning_tokens
        if reasoning_tokens is None and thinking_tokens is not None:
            reasoning_tokens = thinking_tokens
        if total_tokens is not None:
            if input_tokens is None and output_tokens is not None and thinking_tokens is not None:
                derived_input = total_tokens - output_tokens - thinking_tokens
                if derived_input >= 0:
                    input_tokens = derived_input
            if output_tokens is None and input_tokens is not None and thinking_tokens is not None:
                derived_output = total_tokens - input_tokens - thinking_tokens
                if derived_output >= 0:
                    output_tokens = derived_output
            if thinking_tokens is None and input_tokens is not None and output_tokens is not None:
                derived_thinking = total_tokens - input_tokens - output_tokens
                if derived_thinking >= 0:
                    thinking_tokens = derived_thinking
        if total_tokens is None:
            total_tokens = sum(
                value
                for value in (input_tokens, output_tokens, thinking_tokens)
                if value is not None
            )
        if total_tokens is not None:
            if input_tokens is None and output_tokens is not None and thinking_tokens is not None:
                derived_input = total_tokens - output_tokens - thinking_tokens
                if derived_input >= 0:
                    input_tokens = derived_input
            if output_tokens is None and input_tokens is not None and thinking_tokens is not None:
                derived_output = total_tokens - input_tokens - thinking_tokens
                if derived_output >= 0:
                    output_tokens = derived_output
            if thinking_tokens is None and input_tokens is not None and output_tokens is not None:
                derived_thinking = total_tokens - input_tokens - output_tokens
                if derived_thinking >= 0:
                    thinking_tokens = derived_thinking

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

            content = getattr(raw_message, "content", None)
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict):
                        block_type = item.get("type")
                        payload = item.get("thinking")
                    else:
                        block_type = getattr(item, "type", None)
                        payload = getattr(item, "thinking", None)

                    if block_type in {"thinking", "redacted_thinking"} and payload is not None:
                        thinking_trace_present = True
                        if isinstance(payload, str):
                            thinking_trace_chars += len(payload)
                        else:
                            thinking_trace_chars += len(json.dumps(payload, default=str))

            candidates = getattr(raw_message, "candidates", None)
            if isinstance(candidates, list):
                for candidate in candidates:
                    candidate_content = getattr(candidate, "content", None)
                    parts = getattr(candidate_content, "parts", None)
                    if not isinstance(parts, list):
                        continue
                    for part in parts:
                        if getattr(part, "thought", False):
                            thinking_trace_present = True
                            text = getattr(part, "text", None)
                            if isinstance(text, str):
                                thinking_trace_chars += len(text)

            choices = getattr(raw_message, "choices", None)
            if isinstance(choices, list):
                for choice in choices:
                    message = getattr(choice, "message", None)
                    if message is None and isinstance(choice, dict):
                        message = choice.get("message")

                    if isinstance(message, dict):
                        reasoning_details = message.get("reasoning_details")
                    else:
                        reasoning_details = getattr(message, "reasoning_details", None)

                    if reasoning_details:
                        thinking_trace_present = True
                        thinking_trace_chars += len(json.dumps(reasoning_details, default=str))

        return {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "thinking_tokens": thinking_tokens,
            "reasoning_tokens": reasoning_tokens,
            "total_tokens": total_tokens,
            "tokens": total_tokens,
            "model": self.model,
            "latency_ms": latency_ms,
            "provider": self.provider,
            "thinking_trace_present": thinking_trace_present,
            "thinking_trace_chars": thinking_trace_chars,
        }


def flash_caller(*, thinking_level: str | None = None) -> AgentCaller:
    """Return cost-efficient generation caller for openings, voting, and rebuttals."""

    config = get_config()
    return AgentCaller(
        model=config.flash_model,
        temperature=0.7,
        enable_streaming=config.gemini_enable_streaming,
        enable_thinking=True,
        thinking_budget=None,
        thinking_level=thinking_level or config.gemini_flash_thinking_level,
    )


def pro_caller(*, thinking_level: str | None = None) -> AgentCaller:
    """Return higher-quality reasoning caller for selection and synthesis."""

    config = get_config()
    return AgentCaller(
        model=config.pro_model,
        temperature=0.5,
        enable_streaming=config.gemini_enable_streaming,
        enable_thinking=config.gemini_enable_thinking,
        thinking_budget=None,
        thinking_level=thinking_level or config.gemini_pro_thinking_level,
    )


def claude_caller(*, effort: str | None = None) -> AgentCaller:
    """Return direct Anthropic Claude caller for diversity or fallback routing."""

    config = get_config()
    return AgentCaller(
        model=config.claude_model,
        temperature=1.0,
        claude_effort=effort or config.claude_effort,
    )


def kimi_caller(
    *,
    effort: str | None = None,
    exclude: bool | None = None,
) -> AgentCaller:
    """Return OpenRouter Kimi caller for challenger or fallback routing."""

    config = get_config()
    return AgentCaller(
        model=config.kimi_model,
        temperature=0.5,
        kimi_reasoning_effort=effort or config.kimi_reasoning_effort,
        kimi_reasoning_exclude=config.kimi_reasoning_exclude if exclude is None else exclude,
    )
