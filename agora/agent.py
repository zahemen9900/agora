"""Unified LLM caller abstraction for Gemini and Claude model backends."""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections import deque
from collections.abc import Callable
from threading import Lock
from typing import Any

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
    from google.api_core.exceptions import ResourceExhausted, ServiceUnavailable, TooManyRequests
except ImportError:  # pragma: no cover
    ResourceExhausted = ServiceUnavailable = TooManyRequests = RuntimeError  # type: ignore[assignment]

try:
    from langchain_google_genai import ChatGoogleGenerativeAI
except ImportError:  # pragma: no cover
    ChatGoogleGenerativeAI = None  # type: ignore[assignment]

logger = structlog.get_logger(__name__)


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
    Gemini and Claude providers.
    """

    def __init__(
        self,
        model: str = "gemini-3-flash-preview",
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
        self.anthropic_api_key = os.getenv("ANTHROPIC_API_KEY") or config.anthropic_api_key
        self._anthropic_max_tokens = config.anthropic_max_tokens
        self._anthropic_throttle_enabled = config.anthropic_throttle_enabled
        self._anthropic_requests_per_minute = config.anthropic_requests_per_minute
        self._anthropic_throttle_window_seconds = config.anthropic_throttle_window_seconds
        self._anthropic_throttle: _AsyncSlidingWindowRateLimiter | None = None
        self._chat_model: Any | None = None
        self._anthropic_client: Any | None = None

        if model.startswith("gemini"):
            self.provider = "gemini"
            if not self.project:
                raise AgentCallError(
                    "GOOGLE_CLOUD_PROJECT is not set. Configure Vertex AI project or use "
                    "fallback-capable runtime paths."
                )
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
            if AsyncAnthropic is None:
                raise AgentCallError(
                    "anthropic SDK is not installed; AsyncAnthropic unavailable"
                )
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

        if self.provider == "claude":
            return await self._call_claude(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_format=response_format,
                temperature=temperature,
                stream=stream,
                stream_callback=stream_callback,
            )

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
        backoff_seconds = 0.5
        max_retries = 3

        for attempt in range(1, max_retries + 1):
            start = time.perf_counter()
            try:
                raw_message: Any | None = None
                if response_format is not None:
                    parsed_via_sdk = False
                    messages_api = getattr(self._anthropic_client, "messages", None)
                    parse_api = getattr(messages_api, "parse", None)
                    if callable(parse_api):
                        try:
                            await self._acquire_anthropic_slot(request_kind="messages.parse")
                            raw_message = await parse_api(
                                model=self.model,
                                max_tokens=self._anthropic_max_tokens,
                                temperature=effective_temperature,
                                system=system_prompt,
                                messages=[{"role": "user", "content": user_prompt}],
                                output_format=response_format,
                            )
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
                    response_content, raw_message = await self._stream_anthropic_text(
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        temperature=effective_temperature,
                        stream_callback=stream_callback,
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

        return await self._anthropic_client.messages.create(
            model=self.model,
            max_tokens=self._anthropic_max_tokens,
            temperature=temperature,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )

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

        await self._acquire_anthropic_slot(request_kind="messages.stream")

        chunks: list[str] = []
        async with self._anthropic_client.messages.stream(
            model=self.model,
            max_tokens=self._anthropic_max_tokens,
            temperature=temperature,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        ) as stream_response:
            async for text_chunk in stream_response.text_stream:
                chunks.append(text_chunk)
                if stream_callback is not None:
                    try:
                        stream_callback(text_chunk)
                    except Exception as exc:  # pragma: no cover
                        logger.warning("stream_callback_error", error=str(exc))
            final_message = await stream_response.get_final_message()

        return "".join(chunks), final_message

    @staticmethod
    def _with_structured_json_instructions(
        user_prompt: str,
        response_format: type[BaseModel],
    ) -> str:
        """Add strict JSON instructions for Claude structured responses."""

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
        json_payload = self._extract_json_payload(raw_text)
        try:
            parsed = json.loads(json_payload)
        except json.JSONDecodeError as exc:
            raise AgentCallError("Claude structured response was not valid JSON.") from exc

        try:
            return response_format.model_validate(parsed)
        except ValidationError as exc:
            raise AgentCallError(
                "Claude structured response did not match expected format "
                f"{response_format.__name__}."
            ) from exc

    @staticmethod
    def _extract_json_payload(text: str) -> str:
        """Extract a JSON object payload from model text, tolerating wrapped output."""

        cleaned = text.strip()
        if cleaned.startswith("```"):
            lines = cleaned.splitlines()
            if len(lines) >= 3 and lines[0].startswith("```") and lines[-1].strip() == "```":
                cleaned = "\n".join(lines[1:-1]).strip()

        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1 and start < end:
            return cleaned[start : end + 1]
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

            usage = getattr(raw_message, "usage", None)
            if isinstance(usage, dict):
                input_tokens = input_tokens or int(
                    usage.get("input_tokens") or usage.get("prompt_tokens") or 0
                )
                output_tokens = output_tokens or int(
                    usage.get("output_tokens") or usage.get("completion_tokens") or 0
                )
            elif usage is not None:
                input_tokens = input_tokens or int(
                    getattr(usage, "input_tokens", None)
                    or getattr(usage, "prompt_tokens", None)
                    or 0
                )
                output_tokens = output_tokens or int(
                    getattr(usage, "output_tokens", None)
                    or getattr(usage, "completion_tokens", None)
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
    """Return direct Anthropic Claude caller for diversity or fallback routing."""

    config = get_config()
    return AgentCaller(model=config.claude_model, temperature=0.5)
