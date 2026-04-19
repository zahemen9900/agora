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
    monkeypatch.setenv("AGORA_ANTHROPIC_SECRET_NAME", "")
    monkeypatch.setenv("AGORA_OPENROUTER_SECRET_NAME", "")
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


class _AnalysisListResponse(BaseModel):
    analyses: list[dict[str, str]]


class _FakeGeminiGenerateContentConfig:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


class _FakeGeminiThinkingConfig:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


class _FakeGeminiResponse:
    def __init__(self, text: str, input_tokens: int = 0, output_tokens: int = 0) -> None:
        self.text = text
        self.usage_metadata = SimpleNamespace(
            prompt_token_count=input_tokens,
            candidates_token_count=output_tokens,
        )
        self.candidates: list[Any] = []


class _FakeGeminiChunk:
    def __init__(self, text: str, input_tokens: int = 0, output_tokens: int = 0) -> None:
        self.text = text
        self.usage_metadata = SimpleNamespace(
            prompt_token_count=input_tokens,
            candidates_token_count=output_tokens,
        )


class _FakeGeminiModels:
    def __init__(self, response: _FakeGeminiResponse, chunks: list[_FakeGeminiChunk] | None = None):
        self._response = response
        self._chunks = chunks or []
        self.last_generate_kwargs: dict[str, Any] | None = None
        self.last_stream_kwargs: dict[str, Any] | None = None

    async def generate_content(self, **kwargs: Any) -> _FakeGeminiResponse:
        self.last_generate_kwargs = kwargs
        return self._response

    async def generate_content_stream(self, **kwargs: Any):
        self.last_stream_kwargs = kwargs
        for chunk in self._chunks:
            yield chunk


class _FakeGeminiClient:
    def __init__(
        self,
        api_key: str,
        response: _FakeGeminiResponse,
        chunks: list[_FakeGeminiChunk] | None = None,
    ):
        self.api_key = api_key
        self.models = _FakeGeminiModels(response=response, chunks=chunks)
        self.aio = SimpleNamespace(models=self.models)


class _FakeOpenRouterResponse:
    def __init__(
        self,
        text: str,
        *,
        input_tokens: int = 0,
        output_tokens: int = 0,
        reasoning_tokens: int = 0,
    ) -> None:
        self.choices = [SimpleNamespace(message=SimpleNamespace(content=text))]
        completion_details = SimpleNamespace(reasoning_tokens=reasoning_tokens)
        self.usage = SimpleNamespace(
            prompt_tokens=input_tokens,
            completion_tokens=output_tokens,
            completion_tokens_details=completion_details,
        )


class _FakeOpenRouterCompletionsAPI:
    def __init__(self, response: _FakeOpenRouterResponse) -> None:
        self._response = response
        self.last_kwargs: dict[str, Any] | None = None

    async def create(self, **kwargs: Any) -> _FakeOpenRouterResponse:
        self.last_kwargs = kwargs
        return self._response


class _FakeOpenRouterClient:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        max_retries: int,
        default_headers: dict[str, str] | None,
        response: _FakeOpenRouterResponse,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.max_retries = max_retries
        self.default_headers = default_headers
        self.chat = SimpleNamespace(completions=_FakeOpenRouterCompletionsAPI(response))


def _patch_gemini_sdk(
    monkeypatch: pytest.MonkeyPatch,
    response: _FakeGeminiResponse,
    chunks: list[_FakeGeminiChunk] | None = None,
) -> _FakeGeminiClient:
    created: dict[str, _FakeGeminiClient] = {}

    def _fake_client_ctor(*, api_key: str) -> _FakeGeminiClient:
        client = _FakeGeminiClient(api_key=api_key, response=response, chunks=chunks)
        created["client"] = client
        return client

    monkeypatch.setattr(agent_module, "genai", SimpleNamespace(Client=_fake_client_ctor))
    monkeypatch.setattr(
        agent_module,
        "genai_types",
        SimpleNamespace(
            GenerateContentConfig=_FakeGeminiGenerateContentConfig,
            ThinkingConfig=_FakeGeminiThinkingConfig,
        ),
    )

    return created.setdefault("client", _fake_client_ctor(api_key="bootstrap"))


def test_gemini_requires_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gemini caller should fail fast when no API key is configured."""

    monkeypatch.setenv("AGORA_GEMINI_API_KEY", "")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("AGORA_GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    with pytest.raises(AgentCallError, match="Gemini API key is not set"):
        AgentCaller(model="gemini-2.5-flash")


def test_gemini_uses_google_genai_client(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gemini caller should initialize direct google-genai client with API key."""

    monkeypatch.setenv("AGORA_GEMINI_API_KEY", "gemini-test-key")
    fake_response = _FakeGeminiResponse("ok")
    created: dict[str, _FakeGeminiClient] = {}

    def _fake_client_ctor(*, api_key: str) -> _FakeGeminiClient:
        client = _FakeGeminiClient(api_key=api_key, response=fake_response)
        created["client"] = client
        return client

    monkeypatch.setattr(agent_module, "genai", SimpleNamespace(Client=_fake_client_ctor))

    caller = AgentCaller(model="gemini-2.5-flash", temperature=0.2)

    assert caller.provider == "gemini"
    assert created["client"].api_key == "gemini-test-key"


def test_gemini_uses_late_bound_env_key_after_config_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Gemini caller should not miss keys exported after config was first cached."""

    monkeypatch.setenv("AGORA_GEMINI_API_KEY", "")
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("AGORA_GOOGLE_API_KEY", "")
    monkeypatch.setenv("GOOGLE_API_KEY", "")
    monkeypatch.setenv("AGORA_GEMINI_SECRET_NAME", "")
    get_config.cache_clear()
    assert get_config().gemini_api_key is None

    monkeypatch.setenv("AGORA_GEMINI_API_KEY", "late-bound-gemini-key")
    fake_response = _FakeGeminiResponse("ok")
    created: dict[str, _FakeGeminiClient] = {}

    def _fake_client_ctor(*, api_key: str) -> _FakeGeminiClient:
        client = _FakeGeminiClient(api_key=api_key, response=fake_response)
        created["client"] = client
        return client

    monkeypatch.setattr(agent_module, "genai", SimpleNamespace(Client=_fake_client_ctor))

    caller = AgentCaller(model="gemini-2.5-flash", temperature=0.2)

    assert caller.provider == "gemini"
    assert created["client"].api_key == "late-bound-gemini-key"


def test_openrouter_uses_async_openai_client(monkeypatch: pytest.MonkeyPatch) -> None:
    """OpenRouter caller should initialize AsyncOpenAI client with base URL."""

    monkeypatch.setenv("OPENROUTER_API_KEY", "or-test-key")
    fake_response = _FakeOpenRouterResponse("ok")
    created: dict[str, _FakeOpenRouterClient] = {}

    def _fake_async_openai_ctor(
        *,
        api_key: str,
        base_url: str,
        max_retries: int = 0,
        default_headers: dict[str, str] | None = None,
    ) -> _FakeOpenRouterClient:
        client = _FakeOpenRouterClient(
            api_key=api_key,
            base_url=base_url,
            max_retries=max_retries,
            default_headers=default_headers,
            response=fake_response,
        )
        created["client"] = client
        return client

    monkeypatch.setattr(agent_module, "AsyncOpenAI", _fake_async_openai_ctor)

    caller = AgentCaller(model="moonshotai/kimi-k2-thinking", temperature=0.2)

    assert caller.provider == "openrouter"
    assert created["client"].api_key == "or-test-key"
    assert created["client"].base_url == get_config().openrouter_base_url
    assert created["client"].max_retries == 0


@pytest.mark.asyncio
async def test_openrouter_structured_output_parses_pydantic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Structured OpenRouter calls should parse model JSON into requested schema."""

    monkeypatch.setenv("OPENROUTER_API_KEY", "or-test-key")
    fake_response = _FakeOpenRouterResponse(
        '{"answer":"Paris","confidence":0.87}',
        input_tokens=9,
        output_tokens=5,
        reasoning_tokens=3,
    )
    created: dict[str, _FakeOpenRouterClient] = {}

    def _fake_async_openai_ctor(
        *,
        api_key: str,
        base_url: str,
        max_retries: int = 0,
        default_headers: dict[str, str] | None = None,
    ) -> _FakeOpenRouterClient:
        client = _FakeOpenRouterClient(
            api_key=api_key,
            base_url=base_url,
            max_retries=max_retries,
            default_headers=default_headers,
            response=fake_response,
        )
        created["client"] = client
        return client

    monkeypatch.setattr(agent_module, "AsyncOpenAI", _fake_async_openai_ctor)

    caller = AgentCaller(model="moonshotai/kimi-k2-thinking", temperature=0.2)
    parsed, usage = await caller.call(
        system_prompt="Return structured JSON.",
        user_prompt="Capital of France",
        response_format=_StructuredResponse,
    )

    assert isinstance(parsed, _StructuredResponse)
    assert parsed.answer == "Paris"
    assert parsed.confidence == pytest.approx(0.87)
    assert usage["provider"] == "openrouter"
    assert usage["input_tokens"] == 9
    assert usage["output_tokens"] == 5
    assert usage["reasoning_tokens"] == 3

    kwargs = created["client"].chat.completions.last_kwargs
    assert kwargs is not None
    assert kwargs["model"] == "moonshotai/kimi-k2-thinking"
    assert kwargs["response_format"] == {"type": "json_object"}
    assert kwargs["max_tokens"] == get_config().kimi_max_tokens
    assert kwargs["extra_body"] == {"reasoning": {"exclude": True, "effort": "low"}}


@pytest.mark.asyncio
async def test_gemini_structured_output_parses_pydantic(monkeypatch: pytest.MonkeyPatch) -> None:
    """Structured Gemini calls should parse model JSON into requested Pydantic schema."""

    monkeypatch.setenv("AGORA_GEMINI_API_KEY", "gemini-test-key")
    response = _FakeGeminiResponse(
        '{"answer":"Paris","confidence":0.91}',
        input_tokens=11,
        output_tokens=7,
    )

    created: dict[str, _FakeGeminiClient] = {}

    def _fake_client_ctor(*, api_key: str) -> _FakeGeminiClient:
        client = _FakeGeminiClient(api_key=api_key, response=response)
        created["client"] = client
        return client

    monkeypatch.setattr(agent_module, "genai", SimpleNamespace(Client=_fake_client_ctor))
    monkeypatch.setattr(
        agent_module,
        "genai_types",
        SimpleNamespace(
            GenerateContentConfig=_FakeGeminiGenerateContentConfig,
            ThinkingConfig=_FakeGeminiThinkingConfig,
        ),
    )

    caller = AgentCaller(model="gemini-2.5-pro", temperature=0.3)
    parsed, usage = await caller.call(
        system_prompt="Return structured JSON.",
        user_prompt="Capital of France",
        response_format=_StructuredResponse,
    )

    assert isinstance(parsed, _StructuredResponse)
    assert parsed.answer == "Paris"
    assert usage["provider"] == "gemini"
    assert usage["input_tokens"] == 11
    assert usage["output_tokens"] == 7

    kwargs = created["client"].models.last_generate_kwargs
    assert kwargs is not None
    assert kwargs["model"] == "gemini-2.5-pro"
    config = kwargs["config"]
    assert config.kwargs["response_mime_type"] == "application/json"


@pytest.mark.asyncio
async def test_gemini_streaming_returns_full_text_and_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Streaming Gemini calls should concatenate chunks and preserve usage metadata."""

    monkeypatch.setenv("AGORA_GEMINI_API_KEY", "gemini-test-key")
    chunks = [
        _FakeGeminiChunk("Hel", input_tokens=3, output_tokens=0),
        _FakeGeminiChunk("lo", input_tokens=3, output_tokens=4),
    ]
    response = _FakeGeminiResponse("ignored")

    created: dict[str, _FakeGeminiClient] = {}

    def _fake_client_ctor(*, api_key: str) -> _FakeGeminiClient:
        client = _FakeGeminiClient(api_key=api_key, response=response, chunks=chunks)
        created["client"] = client
        return client

    monkeypatch.setattr(agent_module, "genai", SimpleNamespace(Client=_fake_client_ctor))
    monkeypatch.setattr(
        agent_module,
        "genai_types",
        SimpleNamespace(
            GenerateContentConfig=_FakeGeminiGenerateContentConfig,
            ThinkingConfig=_FakeGeminiThinkingConfig,
        ),
    )

    caller = AgentCaller(model="gemini-2.5-flash", temperature=0.4)
    streamed_chunks: list[str] = []
    text, usage = await caller.call(
        system_prompt="You are concise.",
        user_prompt="Say hello",
        stream=True,
        stream_callback=streamed_chunks.append,
    )

    assert text == "Hello"
    assert streamed_chunks == ["Hel", "lo"]
    assert usage["provider"] == "gemini"
    assert usage["input_tokens"] == 3
    assert usage["output_tokens"] == 4


def test_openrouter_requires_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """OpenRouter caller should fail fast when API key is missing."""

    monkeypatch.setenv("AGORA_OPENROUTER_API_KEY", "")
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    monkeypatch.setenv("AGORA_OPENROUTER_SECRET_NAME", "")
    monkeypatch.setattr(agent_module, "AsyncOpenAI", lambda **kwargs: object())

    with pytest.raises(AgentCallError, match="OPENROUTER_API_KEY is not set"):
        AgentCaller(model="moonshotai/kimi-k2-thinking", temperature=0.2)


@pytest.mark.asyncio
async def test_openrouter_uses_agora_key_alias_and_optional_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """OpenRouter should honor AGORA_* key alias and attribution headers."""

    monkeypatch.setenv("AGORA_OPENROUTER_API_KEY", "agora-or-key")
    monkeypatch.setenv("OPENROUTER_API_KEY", "plain-or-key")
    monkeypatch.setenv("AGORA_OPENROUTER_HTTP_REFERER", "https://example.test/agora")
    monkeypatch.setenv("AGORA_OPENROUTER_APP_TITLE", "Agora Test")
    monkeypatch.setenv("AGORA_OPENROUTER_LEGACY_X_TITLE_ENABLED", "true")
    fake_response = _FakeOpenRouterResponse(
        "ok",
        input_tokens=9,
        output_tokens=5,
        reasoning_tokens=3,
    )
    created: dict[str, _FakeOpenRouterClient] = {}

    def _fake_async_openai_ctor(
        *,
        api_key: str,
        base_url: str,
        max_retries: int = 0,
        default_headers: dict[str, str] | None = None,
    ) -> _FakeOpenRouterClient:
        client = _FakeOpenRouterClient(
            api_key=api_key,
            base_url=base_url,
            max_retries=max_retries,
            default_headers=default_headers,
            response=fake_response,
        )
        created["client"] = client
        return client

    monkeypatch.setattr(agent_module, "AsyncOpenAI", _fake_async_openai_ctor)

    caller = AgentCaller(model="moonshotai/kimi-k2-thinking", temperature=0.2)
    response, usage = await caller.call(system_prompt="Be brief.", user_prompt="Say OK")

    assert response == "ok"
    assert usage["provider"] == "openrouter"
    assert usage["input_tokens"] == 9
    assert usage["output_tokens"] == 5
    assert usage["reasoning_tokens"] == 3
    assert created["client"].api_key == "agora-or-key"
    assert created["client"].default_headers == {
        "HTTP-Referer": "https://example.test/agora",
        "X-OpenRouter-Title": "Agora Test",
        "X-Title": "Agora Test",
    }

    kwargs = created["client"].chat.completions.last_kwargs
    assert kwargs is not None
    assert kwargs["max_tokens"] == get_config().kimi_max_tokens
    assert kwargs["extra_body"] == {"reasoning": {"exclude": True, "effort": "low"}}


@pytest.mark.asyncio
async def test_openrouter_disables_legacy_x_title_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Legacy X-Title header should be disabled by config toggle."""

    monkeypatch.setenv("AGORA_OPENROUTER_API_KEY", "agora-or-key")
    monkeypatch.setenv("AGORA_OPENROUTER_APP_TITLE", "Agora Test")
    monkeypatch.setenv("AGORA_OPENROUTER_LEGACY_X_TITLE_ENABLED", "false")
    fake_response = _FakeOpenRouterResponse("ok")
    created: dict[str, _FakeOpenRouterClient] = {}

    def _fake_async_openai_ctor(
        *,
        api_key: str,
        base_url: str,
        max_retries: int = 0,
        default_headers: dict[str, str] | None = None,
    ) -> _FakeOpenRouterClient:
        client = _FakeOpenRouterClient(
            api_key=api_key,
            base_url=base_url,
            max_retries=max_retries,
            default_headers=default_headers,
            response=fake_response,
        )
        created["client"] = client
        return client

    monkeypatch.setattr(agent_module, "AsyncOpenAI", _fake_async_openai_ctor)

    caller = AgentCaller(model="moonshotai/kimi-k2-thinking", temperature=0.2)
    await caller.call(system_prompt="Be brief.", user_prompt="Say OK")

    assert created["client"].default_headers == {"X-OpenRouter-Title": "Agora Test"}


@pytest.mark.asyncio
async def test_openrouter_structured_output_wraps_analysis_arrays(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Kimi may return a top-level JSON array for cross-exam analyses."""

    monkeypatch.setenv("OPENROUTER_API_KEY", "or-test-key")
    fake_response = _FakeOpenRouterResponse(
        '[{"faction":"pro","flaw":"thin evidence"}]',
        input_tokens=9,
        output_tokens=5,
        reasoning_tokens=3,
    )
    created: dict[str, _FakeOpenRouterClient] = {}

    def _fake_async_openai_ctor(
        *,
        api_key: str,
        base_url: str,
        max_retries: int = 0,
        default_headers: dict[str, str] | None = None,
    ) -> _FakeOpenRouterClient:
        client = _FakeOpenRouterClient(
            api_key=api_key,
            base_url=base_url,
            max_retries=max_retries,
            default_headers=default_headers,
            response=fake_response,
        )
        created["client"] = client
        return client

    monkeypatch.setattr(agent_module, "AsyncOpenAI", _fake_async_openai_ctor)

    caller = AgentCaller(model="moonshotai/kimi-k2-thinking", temperature=0.2)
    parsed, usage = await caller.call(
        system_prompt="Return structured JSON.",
        user_prompt="Critique both sides.",
        response_format=_AnalysisListResponse,
    )

    assert parsed == _AnalysisListResponse(
        analyses=[{"faction": "pro", "flaw": "thin evidence"}]
    )
    assert usage["provider"] == "openrouter"
    kwargs = created["client"].chat.completions.last_kwargs
    assert kwargs is not None
    assert kwargs["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_openrouter_structured_output_rejects_trailing_decoy_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Structured parsing must fail unless the whole completion is JSON."""

    monkeypatch.setenv("OPENROUTER_API_KEY", "or-test-key")
    fake_response = _FakeOpenRouterResponse(
        '{"answer":"Paris","confidence":0.91}\n{"answer":"Lyon","confidence":1.0}',
        input_tokens=9,
        output_tokens=5,
    )

    monkeypatch.setattr(
        agent_module,
        "AsyncOpenAI",
        lambda **kwargs: _FakeOpenRouterClient(
            **kwargs,
            response=fake_response,
        ),
    )

    caller = AgentCaller(model="moonshotai/kimi-k2-thinking", temperature=0.2)
    with pytest.raises(AgentCallError, match="was not valid JSON"):
        await caller.call(
            system_prompt="Return structured JSON.",
            user_prompt="Capital of France",
            response_format=_StructuredResponse,
        )


@pytest.mark.asyncio
async def test_flash_caller_uses_minimal_gemini_thinking_level(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Flash caller should override Gemini 3 dynamic thinking with minimal thinking."""

    monkeypatch.setenv("AGORA_GEMINI_API_KEY", "gemini-test-key")
    monkeypatch.setenv("AGORA_GEMINI_FLASH_THINKING_LEVEL", "minimal")
    response = _FakeGeminiResponse("ok", input_tokens=2, output_tokens=1)
    created: dict[str, _FakeGeminiClient] = {}

    def _fake_client_ctor(*, api_key: str) -> _FakeGeminiClient:
        client = _FakeGeminiClient(api_key=api_key, response=response)
        created["client"] = client
        return client

    monkeypatch.setattr(agent_module, "genai", SimpleNamespace(Client=_fake_client_ctor))
    monkeypatch.setattr(
        agent_module,
        "genai_types",
        SimpleNamespace(
            GenerateContentConfig=_FakeGeminiGenerateContentConfig,
            ThinkingConfig=_FakeGeminiThinkingConfig,
        ),
    )

    caller = agent_module.flash_caller()
    await caller.call(system_prompt="Be brief.", user_prompt="Say OK")

    kwargs = created["client"].models.last_generate_kwargs
    assert kwargs is not None
    config = kwargs["config"]
    thinking_config = config.kwargs["thinking_config"]
    assert thinking_config.kwargs == {"thinking_level": "minimal"}


@pytest.mark.asyncio
async def test_pro_caller_uses_configured_gemini_thinking_level(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pro caller should use Gemini 3 thinking_level controls rather than token budgets."""

    monkeypatch.setenv("AGORA_GEMINI_API_KEY", "gemini-test-key")
    monkeypatch.setenv("AGORA_GEMINI_PRO_THINKING_LEVEL", "low")
    response = _FakeGeminiResponse("ok", input_tokens=2, output_tokens=1)
    created: dict[str, _FakeGeminiClient] = {}

    def _fake_client_ctor(*, api_key: str) -> _FakeGeminiClient:
        client = _FakeGeminiClient(api_key=api_key, response=response)
        created["client"] = client
        return client

    monkeypatch.setattr(agent_module, "genai", SimpleNamespace(Client=_fake_client_ctor))
    monkeypatch.setattr(
        agent_module,
        "genai_types",
        SimpleNamespace(
            GenerateContentConfig=_FakeGeminiGenerateContentConfig,
            ThinkingConfig=_FakeGeminiThinkingConfig,
        ),
    )

    caller = agent_module.pro_caller()
    await caller.call(system_prompt="Be careful.", user_prompt="Say OK")

    kwargs = created["client"].models.last_generate_kwargs
    assert kwargs is not None
    config = kwargs["config"]
    thinking_config = config.kwargs["thinking_config"]
    assert thinking_config.kwargs == {"thinking_level": "low"}


@pytest.mark.asyncio
async def test_gemini_thinking_config_falls_back_to_compatible_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Gemini calls should keep working if the SDK rejects the first thinking-config shape."""

    monkeypatch.setenv("AGORA_GEMINI_API_KEY", "gemini-test-key")
    monkeypatch.setenv("AGORA_GEMINI_PRO_THINKING_LEVEL", "high")
    response = _FakeGeminiResponse("ok", input_tokens=2, output_tokens=1)
    created: dict[str, _FakeGeminiClient] = {}

    def _fake_client_ctor(*, api_key: str) -> _FakeGeminiClient:
        client = _FakeGeminiClient(api_key=api_key, response=response)
        created["client"] = client
        return client

    class _AliasOnlyThinkingConfig:
        def __init__(self, **kwargs: Any) -> None:
            if "thinking_level" in kwargs:
                raise TypeError("thinking_level unsupported")
            self.kwargs = kwargs

    monkeypatch.setattr(agent_module, "genai", SimpleNamespace(Client=_fake_client_ctor))
    monkeypatch.setattr(
        agent_module,
        "genai_types",
        SimpleNamespace(
            GenerateContentConfig=_FakeGeminiGenerateContentConfig,
            ThinkingConfig=_AliasOnlyThinkingConfig,
        ),
    )

    caller = agent_module.pro_caller()
    await caller.call(system_prompt="Be careful.", user_prompt="Say OK")

    kwargs = created["client"].models.last_generate_kwargs
    assert kwargs is not None
    config = kwargs["config"]
    thinking_config = config.kwargs["thinking_config"]
    assert thinking_config.kwargs == {"thinkingLevel": "high"}


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
    assert kwargs["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert kwargs["output_config"] == {"effort": "medium"}


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


@pytest.mark.asyncio
async def test_claude_falls_back_when_create_signature_lacks_output_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Claude text calls should omit output_config when the installed SDK does not support it."""

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    class _NoOutputConfigMessagesAPI:
        def __init__(self) -> None:
            self.last_create_kwargs: dict[str, Any] | None = None

        async def create(
            self,
            *,
            model: str,
            max_tokens: int,
            temperature: float,
            system: str,
            messages: list[dict[str, str]],
            thinking: dict[str, str],
        ) -> _FakeMessage:
            self.last_create_kwargs = {
                "model": model,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "system": system,
                "messages": messages,
                "thinking": thinking,
            }
            return _FakeMessage("plain text", input_tokens=3, output_tokens=4)

    messages_api = _NoOutputConfigMessagesAPI()
    fake_client = SimpleNamespace(messages=messages_api)
    monkeypatch.setattr(agent_module, "AsyncAnthropic", lambda api_key, max_retries=0: fake_client)

    caller = AgentCaller(model="claude-sonnet-4-6", temperature=0.3)
    response, usage = await caller.call(
        system_prompt="Be concise.",
        user_prompt="Say hello",
    )

    assert response == "plain text"
    assert usage["input_tokens"] == 3
    assert usage["output_tokens"] == 4
    assert messages_api.last_create_kwargs is not None
    assert "output_config" not in messages_api.last_create_kwargs
