"""Tests for the unified agent caller abstraction."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import BaseModel

from agora.agent import AgentCaller
from agora.config import get_config


class _StructuredResponse(BaseModel):
    """Structured response model used for Anthropic parse tests."""

    answer: str
    confidence: float


class _FakeAnthropicTextBlock:
    """Minimal text block matching Anthropic SDK response shape."""

    def __init__(self, text: str) -> None:
        self.type = "text"
        self.text = text


class _FakeAnthropicMessage:
    """Minimal Anthropic message object for tests."""

    def __init__(self, text: str, input_tokens: int = 11, output_tokens: int = 5) -> None:
        self.content = [_FakeAnthropicTextBlock(text)]
        self.usage = SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens)


class _FakeAnthropicParsedMessage(_FakeAnthropicMessage):
    """Anthropic parsed message with parsed output attached."""

    def __init__(self, parsed_output: BaseModel) -> None:
        super().__init__(parsed_output.model_dump_json(), input_tokens=13, output_tokens=7)
        self.parsed_output = parsed_output


class _FakeAnthropicMessages:
    """Fake messages API used by the test client."""

    def __init__(self) -> None:
        self.last_create_kwargs: dict | None = None
        self.last_parse_kwargs: dict | None = None

    async def create(self, **kwargs):
        self.last_create_kwargs = kwargs
        return _FakeAnthropicMessage("hello from claude")

    async def parse(self, **kwargs):
        self.last_parse_kwargs = kwargs
        return _FakeAnthropicParsedMessage(
            _StructuredResponse(answer="Paris", confidence=0.91)
        )


class _FakeAsyncAnthropic:
    """Fake AsyncAnthropic client used to avoid live network calls in unit tests."""

    def __init__(self, api_key: str, max_retries: int) -> None:
        self.api_key = api_key
        self.max_retries = max_retries
        self.messages = _FakeAnthropicMessages()


@pytest.fixture(autouse=True)
def clear_config_cache():
    """Reset cached config so env changes do not leak between tests."""

    get_config.cache_clear()
    yield
    get_config.cache_clear()


def test_claude_initializes_without_google_project(monkeypatch) -> None:
    """Claude direct SDK should not require a Vertex project id."""

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    monkeypatch.setattr("agora.agent.AsyncAnthropic", _FakeAsyncAnthropic)

    caller = AgentCaller(model="claude-sonnet-4-6")

    assert caller.provider == "anthropic"
    assert caller.project is None
    assert caller.anthropic_api_key == "test-key"


async def test_claude_text_call_uses_direct_anthropic_client(monkeypatch) -> None:
    """Unstructured Claude calls should flow through the Anthropic SDK."""

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    monkeypatch.setattr("agora.agent.AsyncAnthropic", _FakeAsyncAnthropic)

    caller = AgentCaller(model="claude-sonnet-4-6", temperature=0.3)

    response, usage = await caller.call(
        system_prompt="You are helpful.",
        user_prompt="Say hello.",
    )

    assert response == "hello from claude"
    assert usage["input_tokens"] == 11
    assert usage["output_tokens"] == 5
    assert usage["provider"] == "anthropic"


async def test_claude_structured_call_uses_parse(monkeypatch) -> None:
    """Structured Claude calls should use Anthropic parse with the Pydantic schema."""

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    monkeypatch.setattr("agora.agent.AsyncAnthropic", _FakeAsyncAnthropic)

    caller = AgentCaller(model="claude-sonnet-4-6", temperature=0.2)

    response, usage = await caller.call(
        system_prompt="Return a structured answer.",
        user_prompt="What is the capital of France?",
        response_format=_StructuredResponse,
        temperature=0.1,
    )

    assert isinstance(response, _StructuredResponse)
    assert response.answer == "Paris"
    assert response.confidence == 0.91
    assert usage["input_tokens"] == 13
    assert usage["output_tokens"] == 7
