"""Unified broker that dispatches normalized tool requests to concrete backends."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path

from agora.config import AgoraConfig, get_config
from agora.tools.brave import BraveSearchClient
from agora.tools.openrouter_multimodal import OpenRouterMultimodalClient
from agora.tools.sandbox_runner import SandboxRunnerClient
from agora.tools.source_resolver import SourceResolver
from agora.tools.types import CitationItem, SourceRef, ToolResult, ToolUsageSummary

_BINARY_TABULAR_EXTENSIONS = {".xlsx", ".xls", ".xlsb", ".parquet"}


class ToolBroker:
    """Owns normalized tool dispatch, source resolution, and usage aggregation."""

    def __init__(
        self,
        *,
        config: AgoraConfig | None = None,
        brave_client: BraveSearchClient | None = None,
        multimodal_client: OpenRouterMultimodalClient | None = None,
        sandbox_client: SandboxRunnerClient | None = None,
        source_resolver: SourceResolver | None = None,
    ) -> None:
        self._config = config or get_config()
        self._brave = brave_client or BraveSearchClient(config=self._config)
        self._multimodal = multimodal_client or OpenRouterMultimodalClient(config=self._config)
        self._sandbox = sandbox_client
        self._source_resolver = source_resolver or SourceResolver()

    async def aclose(self) -> None:
        await self._brave.aclose()
        await self._multimodal.aclose()
        if self._sandbox is not None:
            await self._sandbox.aclose()

    async def search_online(
        self,
        *,
        query: str,
        freshness: str | None = None,
        event_callback: Callable[[str, dict[str, object]], Awaitable[None]] | None = None,
    ) -> ToolResult:
        return await self._brave.search_online(
            query=query,
            freshness=freshness,
            event_callback=event_callback,
        )

    async def analyze_urls(
        self,
        *,
        question: str,
        sources: list[SourceRef] | None = None,
        event_callback: Callable[[str, dict[str, object]], Awaitable[None]] | None = None,
    ) -> ToolResult:
        result = await self._brave.analyze_query_context(
            query=question,
            urls=[source.source_url for source in sources or [] if source.source_url],
            event_callback=event_callback,
        )
        if sources:
            result = result.model_copy(update={"sources": list(sources)})
        return result

    async def analyze_file(self, *, question: str, source: SourceRef) -> ToolResult:
        if source.kind in {"text_file", "code_file"}:
            suffix = Path(source.display_name).suffix.lower()
            if suffix in _BINARY_TABULAR_EXTENSIONS:
                citation = CitationItem(
                    title=source.display_name,
                    source_kind=source.kind,
                    source_id=source.source_id,
                    note="Binary tabular source; use execute_python for structured inspection",
                )
                return ToolResult(
                    tool_name="analyze_file",
                    status="success",
                    request={"question": question, "source_id": source.source_id},
                    summary=(
                        f"Attached structured data file {source.display_name} is available for sandbox analysis. "
                        "Prefer execute_python with pandas, polars, duckdb, pyarrow, or openpyxl/xlrd/pyxlsb depending on the format."
                    ),
                    citations=[citation],
                    sources=[source],
                    raw_text=(
                        f"{source.display_name} is a binary tabular file. csv/json loaders will not work directly. "
                        "Use execute_python with pandas/openpyxl/xlrd/pyxlsb for spreadsheets or "
                        "pandas/polars/duckdb/pyarrow for parquet."
                    ),
                    raw_metadata={"binary_tabular": True, "extension": suffix},
                )
            payload = await self._source_resolver.read_bytes(source)
            text = payload.decode("utf-8", errors="replace")
            preview = text[:4000]
            citation = CitationItem(
                title=source.display_name,
                source_kind=source.kind,
                source_id=source.source_id,
                note="Local text extraction preview",
            )
            return ToolResult(
                tool_name="analyze_file",
                status="success",
                request={"question": question, "source_id": source.source_id},
                summary=f"Loaded local {source.kind.replace('_', ' ')} source {source.display_name}",
                citations=[citation],
                sources=[source],
                raw_text=preview,
                raw_metadata={"truncated": len(text) > len(preview), "char_count": len(text)},
            )

        payload = None if source.source_url else await self._source_resolver.read_bytes(source)
        return await self._multimodal.analyze_file(
            question=question,
            source=source,
            source_bytes=payload,
        )

    async def execute_python(
        self,
        *,
        code: str,
        sources: list[SourceRef],
        timeout_seconds: int | None = None,
    ) -> ToolResult:
        if self._sandbox is None:
            self._sandbox = SandboxRunnerClient()
        return await self._sandbox.execute_python(
            code=code,
            sources=sources,
            timeout_seconds=timeout_seconds or 20,
        )

    @staticmethod
    def summarize_usage(results: list[ToolResult]) -> ToolUsageSummary:
        tool_counts: dict[str, int] = {}
        successes = 0
        failures = 0
        for result in results:
            tool_counts[result.tool_name] = tool_counts.get(result.tool_name, 0) + 1
            if result.status == "success":
                successes += 1
            else:
                failures += 1
        return ToolUsageSummary(
            total_tool_calls=len(results),
            successful_tool_calls=successes,
            failed_tool_calls=failures,
            tool_counts=tool_counts,
        )
