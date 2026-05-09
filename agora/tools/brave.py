"""Brave Search tool backend with pooled key rotation and retry."""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass
from time import monotonic
from typing import Awaitable, Callable
from urllib.parse import urlparse

import httpx

from agora.config import AgoraConfig, get_config
from agora.tools.types import CitationItem, ToolResult

_RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}


@dataclass(slots=True)
class _BraveKeyState:
    api_key: str
    next_available_at: float = 0.0
    recent_failures: int = 0


class BraveSearchError(RuntimeError):
    """Raised when the Brave tool backend cannot satisfy a request."""


class BraveSearchClient:
    """Thin async client over Brave Search with rate-limited key pooling."""

    def __init__(
        self,
        *,
        config: AgoraConfig | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._config = config or get_config()
        self._keys = [_BraveKeyState(api_key=value) for value in self._config.brave_api_keys if value]
        self._lock = asyncio.Lock()
        self._rotation_index = 0
        self._http = http_client or httpx.AsyncClient(
            base_url=self._config.brave_base_url.rstrip("/"),
            timeout=20.0,
        )
        self._owns_http_client = http_client is None
        self._request_interval = 1.0 / self._config.brave_requests_per_second_per_key
        if not self._keys:
            raise BraveSearchError("Brave Search is not configured: no API keys available")

    async def aclose(self) -> None:
        if self._owns_http_client:
            await self._http.aclose()

    async def search_online(
        self,
        *,
        query: str,
        freshness: str | None = None,
        country: str = "US",
        search_lang: str = "en",
        count: int = 5,
        event_callback: Callable[[str, dict[str, object]], Awaitable[None]] | None = None,
    ) -> ToolResult:
        """Run Brave web search and normalize top citations."""

        response_json = await self._request(
            path="/web/search",
            params={
                "q": query,
                "country": country,
                "search_lang": search_lang,
                "count": min(max(count, 1), 20),
                "summary": False,
                "spellcheck": True,
                **({"freshness": freshness} if freshness else {}),
            },
            event_callback=event_callback,
        )
        results = self._extract_web_results(response_json)
        citations = [self._citation_from_result(item, index + 1) for index, item in enumerate(results)]
        summary = (
            f"Retrieved {len(citations)} Brave search result(s) for query: {query}"
            if citations
            else f"No Brave search results returned for query: {query}"
        )
        ephemeral_lines = [
            f"{index + 1}. {item.get('title') or item.get('url') or 'Untitled'}"
            + (f" — {item.get('description')}" if item.get("description") else "")
            for index, item in enumerate(results[:5])
        ]
        return ToolResult(
            tool_name="search_online",
            status="success",
            request={"query": query, "freshness": freshness, "country": country},
            summary=summary,
            citations=citations,
            raw_text="\n".join(ephemeral_lines) or None,
            raw_metadata={
                "query": response_json.get("query"),
                "result_count": len(results),
            },
        )

    async def analyze_query_context(
        self,
        *,
        query: str,
        urls: list[str] | None = None,
        country: str = "US",
        search_lang: str = "en",
        maximum_number_of_urls: int | None = None,
        maximum_number_of_tokens: int = 4096,
        event_callback: Callable[[str, dict[str, object]], Awaitable[None]] | None = None,
    ) -> ToolResult:
        """Run Brave LLM Context for a search query.

        Brave's endpoint grounds a query over Brave-ranked results; it is not a direct
        arbitrary-URL ingestion API.
        """

        url_focus = "\n".join(f"- {url}" for url in urls or [] if url)
        enriched_query = query if not url_focus else f"{query}\n\nFocus URLs:\n{url_focus}"

        response_json = await self._request(
            path="/llm/context",
            params={
                "q": enriched_query,
                "country": country,
                "search_lang": search_lang,
                "maximum_number_of_urls": min(
                    max(maximum_number_of_urls or self._config.brave_llm_context_max_urls, 1),
                    20,
                ),
                "maximum_number_of_tokens": min(max(maximum_number_of_tokens, 1024), 32768),
                "enable_source_metadata": True,
            },
            event_callback=event_callback,
        )
        sources = response_json.get("sources") if isinstance(response_json.get("sources"), list) else []
        citations = [self._citation_from_source(item, index + 1) for index, item in enumerate(sources)]
        context_text = response_json.get("context")
        if not isinstance(context_text, str):
            context_text = response_json.get("text") if isinstance(response_json.get("text"), str) else None
        summary = (
            f"Retrieved Brave LLM context from {len(citations)} source(s) for query: {query}"
            if citations
            else f"Brave LLM context returned no source metadata for query: {query}"
        )
        return ToolResult(
            tool_name="analyze_urls",
            status="success",
            request={"query": query, "country": country},
            summary=summary,
            citations=citations,
            raw_text=context_text,
            raw_metadata={"source_count": len(sources), "focused_urls": list(urls or [])},
        )

    async def _request(
        self,
        *,
        path: str,
        params: dict[str, object],
        event_callback: Callable[[str, dict[str, object]], Awaitable[None]] | None = None,
    ) -> dict[str, object]:
        last_error: Exception | None = None
        for attempt in range(self._config.brave_max_retries + 1):
            key_state = await self._acquire_key()
            if event_callback is not None and attempt > 0:
                await event_callback(
                    "search_key_rotated",
                    {
                        "attempt": attempt + 1,
                        "key_index": self._key_index(key_state),
                        "message": f"Retrying Brave request with pooled key #{self._key_index(key_state) + 1}.",
                    },
                )
            try:
                response = await self._http.get(
                    path,
                    params=params,
                    headers={
                        "Accept": "application/json",
                        "Cache-Control": "no-cache",
                        "X-Subscription-Token": key_state.api_key,
                    },
                )
            except httpx.HTTPError as exc:
                last_error = exc
                delay = self._retry_delay(attempt)
                await self._mark_key_failure(key_state, cooloff_seconds=delay)
                if event_callback is not None:
                    await event_callback(
                        "search_retrying",
                        {
                            "attempt": attempt + 1,
                            "key_index": self._key_index(key_state),
                            "delay_seconds": delay,
                            "message": f"Brave request failed ({type(exc).__name__}); retrying in {delay:.2f}s.",
                        },
                    )
                if attempt >= self._config.brave_max_retries:
                    break
                await asyncio.sleep(delay)
                continue

            await self._mark_key_success(key_state)
            if response.status_code in _RETRYABLE_STATUS_CODES:
                last_error = BraveSearchError(
                    f"Brave request failed with status {response.status_code}: {response.text[:200]}"
                )
                delay = self._retry_delay(attempt)
                await self._mark_key_failure(key_state, cooloff_seconds=delay)
                if event_callback is not None:
                    await event_callback(
                        "search_retrying",
                        {
                            "attempt": attempt + 1,
                            "key_index": self._key_index(key_state),
                            "delay_seconds": delay,
                            "status_code": response.status_code,
                            "message": f"Brave returned {response.status_code}; retrying in {delay:.2f}s.",
                        },
                    )
                if attempt >= self._config.brave_max_retries:
                    break
                await asyncio.sleep(delay)
                continue
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise BraveSearchError("Brave response payload was not a JSON object")
            return payload
        raise BraveSearchError(f"Brave request failed after retries: {last_error}") from last_error

    async def _acquire_key(self) -> _BraveKeyState:
        while True:
            async with self._lock:
                ordered = self._ordered_keys()
                now = monotonic()
                for key_state in ordered:
                    if key_state.next_available_at <= now:
                        key_state.next_available_at = now + self._request_interval
                        return key_state
                wait_for = min(key.next_available_at for key in ordered) - now
            await asyncio.sleep(max(wait_for, 0.01))

    async def _mark_key_success(self, key_state: _BraveKeyState) -> None:
        async with self._lock:
            key_state.recent_failures = 0

    async def _mark_key_failure(self, key_state: _BraveKeyState, *, cooloff_seconds: float) -> None:
        async with self._lock:
            key_state.recent_failures += 1
            key_state.next_available_at = max(
                key_state.next_available_at,
                monotonic() + cooloff_seconds,
            )

    def _ordered_keys(self) -> list[_BraveKeyState]:
        if not self._keys:
            return []
        start = self._rotation_index % len(self._keys)
        ordered = self._keys[start:] + self._keys[:start]
        self._rotation_index = (self._rotation_index + 1) % len(self._keys)
        return ordered

    def _key_index(self, key_state: _BraveKeyState) -> int:
        for index, candidate in enumerate(self._keys):
            if candidate is key_state:
                return index
        return -1

    @staticmethod
    def _retry_delay(attempt: int) -> float:
        base = min(2 ** attempt, 8)
        return base + random.uniform(0.0, 0.25)

    @staticmethod
    def _extract_web_results(payload: dict[str, object]) -> list[dict[str, object]]:
        web = payload.get("web")
        if isinstance(web, dict) and isinstance(web.get("results"), list):
            return [item for item in web["results"] if isinstance(item, dict)]
        mixed = payload.get("mixed")
        if isinstance(mixed, dict) and isinstance(mixed.get("main"), list):
            candidates: list[dict[str, object]] = []
            for item in mixed["main"]:
                if isinstance(item, dict):
                    candidate = item.get("item")
                    if isinstance(candidate, dict):
                        candidates.append(candidate)
            return candidates
        return []

    @staticmethod
    def _citation_from_result(item: dict[str, object], rank: int) -> CitationItem:
        profile = item.get("profile")
        profile_url = profile.get("url") if isinstance(profile, dict) else None
        url = str(item.get("url") or profile_url or "").strip() or None
        parsed = urlparse(url) if url else None
        title = str(item.get("title") or url or "Untitled result")
        return CitationItem(
            title=title,
            url=url,
            domain=(parsed.netloc if parsed else None),
            rank=rank,
            source_kind="url",
        )

    @staticmethod
    def _citation_from_source(item: dict[str, object], rank: int) -> CitationItem:
        url = str(item.get("url") or "").strip() or None
        parsed = urlparse(url) if url else None
        title = str(item.get("title") or item.get("site_name") or url or "Context source")
        return CitationItem(
            title=title,
            url=url,
            domain=(parsed.netloc if parsed else None),
            rank=rank,
            source_kind="url",
        )
