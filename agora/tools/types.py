"""Normalized types shared by tool backends and deliberation runtime."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ToolName = Literal["search_online", "analyze_urls", "analyze_file", "execute_python"]
ToolCallStatus = Literal["success", "failed", "rate_limited"]
SourceKindName = Literal["text_file", "code_file", "pdf", "image", "url"]


class SourceRef(BaseModel):
    """Normalized task source passed into broker tools."""

    model_config = ConfigDict(frozen=True)

    source_id: str
    kind: SourceKindName
    display_name: str
    mime_type: str
    storage_uri: str | None = None
    source_url: str | None = None
    size_bytes: int = Field(default=0, ge=0)
    sha256: str | None = None


class CitationItem(BaseModel):
    """Replay-safe citation metadata persisted with results."""

    model_config = ConfigDict(frozen=True)

    title: str
    url: str | None = None
    domain: str | None = None
    rank: int | None = Field(default=None, ge=1)
    source_kind: SourceKindName | None = None
    source_id: str | None = None
    note: str | None = None


class EvidenceItem(BaseModel):
    """Compact evidence record attributed to one agent and one round."""

    model_config = ConfigDict(frozen=True)

    evidence_id: str
    tool_name: ToolName
    agent_id: str
    summary: str
    round_index: int = Field(default=0, ge=0)
    source_ids: list[str] = Field(default_factory=list)
    citations: list[CitationItem] = Field(default_factory=list)


class ToolUsageSummary(BaseModel):
    """Aggregate tool telemetry persisted alongside one completed result."""

    model_config = ConfigDict(frozen=True)

    total_tool_calls: int = Field(default=0, ge=0)
    successful_tool_calls: int = Field(default=0, ge=0)
    failed_tool_calls: int = Field(default=0, ge=0)
    tool_counts: dict[str, int] = Field(default_factory=dict)


class ToolResult(BaseModel):
    """Normalized broker result returned from any tool backend."""

    model_config = ConfigDict(frozen=True)

    tool_name: ToolName
    status: ToolCallStatus
    request: dict[str, Any] = Field(default_factory=dict)
    summary: str
    citations: list[CitationItem] = Field(default_factory=list)
    sources: list[SourceRef] = Field(default_factory=list)
    evidence_items: list[EvidenceItem] = Field(default_factory=list)
    raw_text: str | None = None
    raw_metadata: dict[str, Any] = Field(default_factory=dict)
    stdout: str | None = None
    stderr: str | None = None
    exit_code: int | None = None
    artifacts: list[str] = Field(default_factory=list)
    attempted_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
