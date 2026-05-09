from __future__ import annotations

from collections.abc import Awaitable, Callable

import httpx
import pytest

from agora.config import AgoraConfig
from agora.tools.brave import BraveSearchClient


@pytest.mark.asyncio
async def test_brave_search_emits_retry_and_rotation_events() -> None:
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        if calls["count"] == 1:
            return httpx.Response(429, json={"error": "rate limited"})
        return httpx.Response(
            200,
            json={
                "web": {
                    "results": [
                        {
                            "title": "Federal Reserve",
                            "url": "https://www.federalreserve.gov/monetarypolicy.htm",
                            "description": "Official monetary policy page.",
                        }
                    ]
                }
            },
        )

    events: list[tuple[str, dict[str, object]]] = []

    async def event_callback(event_type: str, payload: dict[str, object]) -> None:
        events.append((event_type, payload))

    client = BraveSearchClient(
        config=AgoraConfig(
            brave_api_keys=("key-1", "key-2"),
            brave_base_url="https://example.com",
            brave_requests_per_second_per_key=100.0,
            brave_max_retries=1,
        ),
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://example.com"),
    )
    try:
        result = await client.search_online(
            query="current federal reserve rate",
            event_callback=event_callback,
        )
    finally:
        await client.aclose()

    assert result.status == "success"
    assert any(event_type == "search_retrying" for event_type, _payload in events)
    assert any(event_type == "search_key_rotated" for event_type, _payload in events)


@pytest.mark.asyncio
async def test_brave_llm_context_carries_focused_urls_metadata() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "Focus URLs" in request.url.params["q"]
        return httpx.Response(
            200,
            json={
                "context": "Compared the attached URLs and extracted the main differences.",
                "sources": [
                    {
                        "title": "Doc A",
                        "url": "https://example.com/doc-a",
                    },
                    {
                        "title": "Doc B",
                        "url": "https://example.com/doc-b",
                    },
                ],
            },
        )

    client = BraveSearchClient(
        config=AgoraConfig(
            brave_api_keys=("key-1",),
            brave_base_url="https://example.com",
            brave_requests_per_second_per_key=100.0,
            brave_max_retries=0,
        ),
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://example.com"),
    )
    try:
        result = await client.analyze_query_context(
            query="Compare the implementation notes.",
            urls=["https://example.com/doc-a", "https://example.com/doc-b"],
        )
    finally:
        await client.aclose()

    assert result.status == "success"
    assert result.raw_metadata["focused_urls"] == [
        "https://example.com/doc-a",
        "https://example.com/doc-b",
    ]
    assert len(result.citations) == 2

