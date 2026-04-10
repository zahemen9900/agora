"""Tests for direct Anthropic Claude integration in AgentCaller."""

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import BaseModel

import agora.agent as agent_module
from agora.agent import AgentCaller, AgentCallError, _AsyncSlidingWindowRateLimiter
from agora.config import get_config


@pytest.fixture(autouse=True)
def _clear_config_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure env overrides are reloaded for each test."""

    monkeypatch.setenv("AGORA_ANTHROPIC_THROTTLE_ENABLED", "0")
    get_config.cache_clear()
    yield
    get_config.cache_clear()


@pytest.mark.asyncio
async def test_sliding_window_rate_limiter_waits_after_limit() -> None:
    """Limiter should delay when max requests are already used in the window."""

    limiter = _AsyncSlidingWindowRateLimiter(max_requests=1, window_seconds=0.05)
    await limiter.acquire()

    start = time.perf_counter()
    waited_seconds = await limiter.acquire()
    elapsed = time.perf_counter() - start

    assert waited_seconds >= 0.04
    assert elapsed >= 0.04


class _StructuredResponse(BaseModel):
    answer: str
    confidence: float


class _FakeMessage:
    def __init__(self, text: str, input_tokens: int = 0, output_tokens: int = 0) -> None:
        self.content = [{"type": "text", "text": text}]
        self.usage = SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens)


class _FakeMessagesAPI:
    def __init__(
        self,
        response: _FakeMessage,
        parse_response: _FakeMessage | None = None,
    ) -> None:
        self._response = response
        self._parse_response = parse_response
        self.last_create_kwargs: dict[str, Any] | None = None
        self.last_parse_kwargs: dict[str, Any] | None = None

    async def create(self, **kwargs: Any) -> _FakeMessage:
        self.last_create_kwargs = kwargs
        return self._response

    async def parse(self, **kwargs: Any) -> _FakeMessage:
        self.last_parse_kwargs = kwargs
        if self._parse_response is None:
            raise TypeError("parse unavailable")
        return self._parse_response


class _FakeStreamResponse:
    def __init__(self, chunks: list[str], final_message: _FakeMessage) -> None:
        self._chunks = chunks
        self._final_message = final_message

    @property
    def text_stream(self):
        async def _iter_chunks():
            for chunk in self._chunks:
                yield chunk

        return _iter_chunks()

    async def get_final_message(self) -> _FakeMessage:
        return self._final_message


class _FakeStreamContext:
    def __init__(self, chunks: list[str], final_message: _FakeMessage) -> None:
        self._chunks = chunks
        self._final_message = final_message

    async def __aenter__(self) -> _FakeStreamResponse:
        return _FakeStreamResponse(self._chunks, self._final_message)

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        del exc_type, exc, tb
        return False


class _FakeAnthropicClient:
    def __init__(
        self,
        response: _FakeMessage,
        stream_chunks: list[str] | None = None,
        parse_response: _FakeMessage | None = None,
    ) -> None:
        self.messages = _FakeMessagesAPI(response, parse_response=parse_response)
        self._stream_chunks = stream_chunks or []
        self._stream_final_message = response

        def _stream(**kwargs: Any) -> _FakeStreamContext:
            self.messages.last_create_kwargs = kwargs
            return _FakeStreamContext(self._stream_chunks, self._stream_final_message)

        self.messages.stream = _stream  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_claude_requires_anthropic_api_key(monkeypatch) -> None:
    """Claude caller should fail fast when API key is missing."""

    # Use an empty value so dotenv autoload cannot repopulate this key.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(agent_module, "AsyncAnthropic", lambda api_key, max_retries=0: object())
    with pytest.raises(AgentCallError, match="ANTHROPIC_API_KEY is not set"):
        AgentCaller(model="claude-sonnet-4-6", temperature=0.2)


@pytest.mark.asyncio
async def test_claude_uses_async_anthropic_client(monkeypatch) -> None:
    """Claude caller should initialize direct AsyncAnthropic client."""

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    fake_client = _FakeAnthropicClient(response=_FakeMessage('{"answer":"ok","confidence":0.8}'))

    def _fake_async_anthropic(api_key: str, max_retries: int = 0) -> _FakeAnthropicClient:
        assert api_key == "test-key"
        assert max_retries == 0
        return fake_client

    monkeypatch.setattr(agent_module, "AsyncAnthropic", _fake_async_anthropic)

    caller = AgentCaller(model="claude-sonnet-4-6", temperature=0.4)
    response, usage = await caller.call(
        system_prompt="You are concise.",
        user_prompt="Return JSON",
        response_format=_StructuredResponse,
    )

    assert isinstance(response, _StructuredResponse)
    assert response.answer == "ok"
    assert usage["provider"] == "claude"
    assert usage["input_tokens"] == 0
    assert usage["output_tokens"] == 0

    kwargs = fake_client.messages.last_create_kwargs
    assert kwargs is not None
    assert kwargs["model"] == "claude-sonnet-4-6"
    assert kwargs["max_tokens"] == get_config().anthropic_max_tokens
    assert kwargs["messages"][0]["role"] == "user"


@pytest.mark.asyncio
async def test_claude_structured_prefers_sdk_parse_when_available(monkeypatch) -> None:
    """Structured calls should use Anthropic parse when available."""

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    parsed = _StructuredResponse(answer="Lima", confidence=0.88)
    parse_message = _FakeMessage("ignored", input_tokens=13, output_tokens=7)
    parse_message.parsed_output = parsed  # type: ignore[attr-defined]

    fake_client = _FakeAnthropicClient(
        response=_FakeMessage('{"answer":"fallback","confidence":0.2}'),
        parse_response=parse_message,
    )
    monkeypatch.setattr(
        agent_module,
        "AsyncAnthropic",
        lambda api_key, max_retries=0: fake_client,
    )

    caller = AgentCaller(model="claude-sonnet-4-6", temperature=0.4)
    response, usage = await caller.call(
        system_prompt="You are concise.",
        user_prompt="Return JSON",
        response_format=_StructuredResponse,
    )

    assert isinstance(response, _StructuredResponse)
    assert response.answer == "Lima"
    assert response.confidence == pytest.approx(0.88)
    assert usage["input_tokens"] == 13
    assert usage["output_tokens"] == 7
    assert fake_client.messages.last_parse_kwargs is not None
    assert fake_client.messages.last_parse_kwargs["output_format"] is _StructuredResponse


@pytest.mark.asyncio
async def test_claude_structured_parsing_tolerates_markdown_fence(monkeypatch) -> None:
    """Structured parser should extract JSON from fenced Claude output."""

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    fake_message = _FakeMessage(
        "```json\n{\"answer\":\"Paris\",\"confidence\":0.93}\n```",
        input_tokens=12,
        output_tokens=9,
    )
    fake_client = _FakeAnthropicClient(response=fake_message)
    monkeypatch.setattr(agent_module, "AsyncAnthropic", lambda api_key, max_retries=0: fake_client)

    caller = AgentCaller(model="claude-sonnet-4-6", temperature=0.3)
    response, usage = await caller.call(
        system_prompt="Return structured.",
        user_prompt="Capital of France",
        response_format=_StructuredResponse,
    )

    assert isinstance(response, _StructuredResponse)
    assert response.answer == "Paris"
    assert response.confidence == pytest.approx(0.93)
    assert usage["input_tokens"] == 12
    assert usage["output_tokens"] == 9


@pytest.mark.asyncio
async def test_claude_streaming_returns_full_text_and_usage(monkeypatch) -> None:
    """Streaming mode should concatenate chunks and preserve final usage stats."""

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    fake_final = _FakeMessage("final", input_tokens=5, output_tokens=7)
    fake_client = _FakeAnthropicClient(response=fake_final, stream_chunks=["Hel", "lo"])
    monkeypatch.setattr(agent_module, "AsyncAnthropic", lambda api_key, max_retries=0: fake_client)

    caller = AgentCaller(model="claude-sonnet-4-6", temperature=0.7)
    streamed_chunks: list[str] = []
    response, usage = await caller.call(
        system_prompt="You are concise.",
        user_prompt="Say hello",
        stream=True,
        stream_callback=streamed_chunks.append,
    )

    assert response == "Hello"
    assert streamed_chunks == ["Hel", "lo"]
    assert usage["input_tokens"] == 5
    assert usage["output_tokens"] == 7
