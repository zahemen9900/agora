"""Runtime helpers for tool-enabled deliberation calls."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from agora.runtime.model_catalog import is_openrouter_model_id
from agora.tools.broker import ToolBroker
from agora.tools.types import CitationItem, EvidenceItem, SourceRef, ToolResult

EventSink = Callable[[str, dict[str, Any]], Awaitable[None]]
ToolDecisionName = Literal["search_online", "analyze_urls", "analyze_file", "execute_python"]


class _SupportsStructuredCall(Protocol):
    """Protocol for model callers used by the tool-decision helper."""

    model: str

    async def call(
        self,
        system_prompt: str,
        user_prompt: str,
        response_format: type[BaseModel] | None = None,
        temperature: float | None = None,
        stream: bool = False,
        stream_callback: Callable[[str], None] | None = None,
    ) -> tuple[str | BaseModel, dict[str, Any]]: ...


class ToolPolicyConfig(BaseModel):
    """Runtime policy for broker-owned tool calls."""

    model_config = ConfigDict(frozen=True)

    enabled: bool = True
    allow_search: bool = True
    allow_url_analysis: bool = True
    allow_file_analysis: bool = True
    allow_code_execution: bool = True
    max_tool_calls_per_agent: int = Field(default=12, ge=0, le=20)
    max_urls_per_call: int = Field(default=5, ge=0, le=20)
    max_files_per_call: int = Field(default=3, ge=0, le=10)
    execution_timeout_seconds: int = Field(default=20, ge=1, le=30)


class ToolDecision(BaseModel):
    """One model-chosen tool request."""

    model_config = ConfigDict(frozen=True)

    should_call: bool = False
    tool_name: ToolDecisionName | None = None
    rationale: str = ""
    query: str = ""
    question: str = ""
    source_ids: list[str] = Field(default_factory=list)
    python_code: str = ""

    @field_validator("rationale", "query", "question", "python_code", mode="before")
    @classmethod
    def _coerce_text(cls, value: Any) -> str:
        return "" if value is None else str(value)


@dataclass(slots=True)
class ToolInvocationContext:
    """Context for one tool-eligible agent/model call."""

    task: str
    agent_id: str
    round_index: int
    stage: str
    sources: list[SourceRef]
    tool_policy: ToolPolicyConfig
    event_sink: EventSink | None = None
    broker: ToolBroker | None = None


@dataclass(slots=True)
class ToolAugmentationResult:
    """Augmented prompt plus the transient tool results and planning usage."""

    user_prompt: str
    tool_results: list[ToolResult]
    planning_usage: dict[str, Any]


_TOOL_DECISION_SYSTEM_PROMPT = """You are deciding whether to use broker-owned tools before answering.

Rules:
- In each planning step, you may request at most one tool call.
- You may get multiple planning steps, but stop once further tool use would not materially improve answer quality.
- You have a finite tool budget for this pass. Spend it deliberately on the highest-information checks first.
- Prefer tool use when the task depends on current information, external URLs, uploaded files, or executable checks.
- Use a tool whenever the task requires exact computation, digest/hash generation, code execution, parsing attached files, or verification against external sources.
- Do not request a tool if the answer is directly derivable from the prompt alone.
- Never fabricate source_ids; choose only from the provided source catalog.
- For execute_python, provide runnable Python code, keep it compact, and use the best available library for the file format instead of forcing everything through the standard library.
- Sandbox constraints: no network, no pip installs, and attached files are mounted read-only under /workspace/input.
- If attached files exist, prefer analyze_file or execute_python over guessing from memory.
- Return strictly the requested JSON schema.
"""


def should_offer_tools(*, task: str, sources: list[SourceRef], policy: ToolPolicyConfig) -> bool:
    """Cheap heuristic gate to avoid doubling every model call unnecessarily."""

    if not policy.enabled or policy.max_tool_calls_per_agent <= 0:
        return False
    if sources:
        return True
    normalized = task.lower()
    triggers = (
        "current ",
        "latest",
        "today",
        "yesterday",
        "news",
        "search",
        "web",
        "interest rate",
        "price",
        "compare docs",
    )
    return any(token in normalized for token in triggers)


async def maybe_augment_prompt_with_tool(
    *,
    caller: _SupportsStructuredCall,
    system_prompt: str,
    user_prompt: str,
    context: ToolInvocationContext,
) -> ToolAugmentationResult:
    """Let the model optionally choose one tool call, then append the result inline."""

    if not should_offer_tools(task=context.task, sources=context.sources, policy=context.tool_policy):
        return ToolAugmentationResult(user_prompt=user_prompt, tool_results=[], planning_usage={})
    planning_usages: list[dict[str, Any]] = []
    tool_results: list[ToolResult] = []
    retry_context = ""
    max_steps = max(1, context.tool_policy.max_tool_calls_per_agent)

    for step_index in range(max_steps):
        decision_prompt = _build_decision_prompt(
            task=context.task,
            original_prompt=user_prompt,
            context=context,
            retry_context=retry_context,
            prior_tool_results=tool_results,
        )
        decision, decision_usage = await _request_tool_decision(
            caller=caller,
            decision_prompt=decision_prompt,
        )
        if decision is None:
            break
        planning_usages.append(decision_usage)
        if not decision.should_call or decision.tool_name is None:
            break

        call_id = f"tool-{uuid.uuid4().hex[:12]}"
        try:
            tool_result = await _execute_tool_decision(
                decision=decision,
                context=context,
                call_id=call_id,
            )
        except Exception as exc:
            tool_result = _failed_tool_result(
                decision=decision,
                context=context,
                call_id=call_id,
                message=str(exc) or exc.__class__.__name__,
            )

        tool_results.append(tool_result)
        if tool_result.status != "success" and step_index < max_steps - 1:
            retry_context = _tool_retry_context_block(tool_result)
            await _emit_tool_event(
                context.event_sink,
                "tool_call_retrying",
                context=context,
                payload={
                    "tool_name": tool_result.tool_name,
                    "tool_call_id": call_id,
                    "attempt": step_index + 2,
                    "reason": tool_result.summary,
                },
            )
        else:
            retry_context = ""

    if not tool_results:
        merged_usage = merge_raw_usage([entry for entry in planning_usages if entry])
        return ToolAugmentationResult(user_prompt=user_prompt, tool_results=[], planning_usage=merged_usage)

    evidence_blocks = "\n\n".join(_tool_result_context_block(result) for result in tool_results)
    merged_usage = merge_raw_usage([entry for entry in planning_usages if entry])
    return ToolAugmentationResult(
        user_prompt=f"{user_prompt}\n\n{evidence_blocks}",
        tool_results=tool_results,
        planning_usage=merged_usage,
    )


async def _request_tool_decision(
    *,
    caller: _SupportsStructuredCall,
    decision_prompt: str,
) -> tuple[ToolDecision | None, dict[str, Any]]:
    """Request one tool decision with a raw-text fallback for weaker tool planners."""

    planning_usage: dict[str, Any] = {}
    try:
        raw_decision, planning_usage = await caller.call(
            system_prompt=_TOOL_DECISION_SYSTEM_PROMPT,
            user_prompt=decision_prompt,
            response_format=ToolDecision,
            temperature=0.0,
            stream=False,
        )
        if isinstance(raw_decision, ToolDecision):
            return raw_decision, planning_usage
    except Exception:
        if not is_openrouter_model_id(getattr(caller, "model", "")):
            return None, planning_usage

    try:
        raw_text, fallback_usage = await caller.call(
            system_prompt=_TOOL_DECISION_SYSTEM_PROMPT,
            user_prompt=decision_prompt,
            response_format=None,
            temperature=0.0,
            stream=False,
        )
        planning_usage = merge_raw_usage([entry for entry in [planning_usage, fallback_usage] if entry])
    except Exception:
        return None, planning_usage

    if isinstance(raw_text, ToolDecision):
        return raw_text, planning_usage

    parsed = _coerce_tool_decision_text(str(raw_text or ""))
    return parsed, planning_usage


def _coerce_tool_decision_text(raw_text: str) -> ToolDecision | None:
    """Parse a raw JSON-ish model answer into a ToolDecision."""

    candidate = raw_text.strip()
    if not candidate:
        return None
    if candidate.startswith("```"):
        candidate = candidate.strip("`")
        if "\n" in candidate:
            candidate = candidate.split("\n", 1)[1]
        if candidate.endswith("```"):
            candidate = candidate[:-3]
        candidate = candidate.strip()

    decoder = json.JSONDecoder()
    payload: Any | None = None
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        for opener in ("{", "["):
            start = candidate.find(opener)
            if start < 0:
                continue
            try:
                payload, _ = decoder.raw_decode(candidate[start:])
                break
            except json.JSONDecodeError:
                continue

    if payload is None:
        return None

    try:
        return ToolDecision.model_validate(payload)
    except ValidationError:
        return None


def merge_raw_usage(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Merge raw caller usage payloads before engine normalization."""

    merged: dict[str, Any] = {
        "tokens": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "thinking_tokens": 0,
        "latency_ms": 0.0,
        "model_tokens": {},
        "model_input_tokens": {},
        "model_output_tokens": {},
        "model_thinking_tokens": {},
        "model_latency_ms": {},
        "fallback_events": [],
    }
    for usage in entries:
        merged["tokens"] += int(usage.get("tokens") or usage.get("total_tokens") or 0)
        merged["input_tokens"] += int(usage.get("input_tokens") or 0)
        merged["output_tokens"] += int(usage.get("output_tokens") or 0)
        merged["thinking_tokens"] += int(usage.get("thinking_tokens") or usage.get("reasoning_tokens") or 0)
        merged["latency_ms"] += float(usage.get("latency_ms", 0.0))
        _merge_numeric_map(merged["model_tokens"], usage.get("model_tokens", {}))
        _merge_numeric_map(merged["model_input_tokens"], usage.get("model_input_tokens", {}))
        _merge_numeric_map(merged["model_output_tokens"], usage.get("model_output_tokens", {}))
        _merge_numeric_map(merged["model_thinking_tokens"], usage.get("model_thinking_tokens", {}))
        _merge_numeric_map(merged["model_latency_ms"], usage.get("model_latency_ms", {}))
        merged["fallback_events"].extend(usage.get("fallback_events", []))
    return merged


def tool_results_to_evidence(
    *,
    tool_results: list[ToolResult],
    agent_id: str,
    round_index: int,
) -> tuple[list[EvidenceItem], list[CitationItem]]:
    """Convert transient tool results into persisted evidence/citation models."""

    evidence_items: list[EvidenceItem] = []
    citation_items: list[CitationItem] = []
    seen_citation_keys: set[str] = set()
    for result in tool_results:
        evidence_id = hashlib.sha256(
            f"{agent_id}:{round_index}:{result.tool_name}:{result.summary}".encode("utf-8")
        ).hexdigest()
        evidence_items.append(
            EvidenceItem(
                evidence_id=evidence_id,
                tool_name=result.tool_name,
                agent_id=agent_id,
                summary=result.summary,
                round_index=round_index,
                source_ids=[source.source_id for source in result.sources],
                citations=result.citations,
            )
        )
        for citation in result.citations:
            key = json.dumps(citation.model_dump(mode="json"), sort_keys=True)
            if key in seen_citation_keys:
                continue
            seen_citation_keys.add(key)
            citation_items.append(citation)
    return evidence_items, citation_items


async def _execute_tool_decision(
    *,
    decision: ToolDecision,
    context: ToolInvocationContext,
    call_id: str,
) -> ToolResult:
    broker = context.broker or ToolBroker()
    async def _broker_event(event_type: str, payload: dict[str, object]) -> None:
        await _emit_tool_event(
            context.event_sink,
            event_type,
            context=context,
            payload={
                "tool_call_id": call_id,
                "tool_name": decision.tool_name,
                **payload,
            },
        )

    await _emit_tool_event(
        context.event_sink,
        "tool_call_started",
        context=context,
        payload={
            "tool_call_id": call_id,
            "tool_name": decision.tool_name,
            "query": decision.query or decision.question,
            "source_ids": decision.source_ids,
            "rationale": decision.rationale,
        },
    )
    try:
        if decision.tool_name == "search_online" and context.tool_policy.allow_search:
            result = await broker.search_online(
                query=(decision.query or context.task).strip(),
                event_callback=_broker_event,
            )
        elif decision.tool_name == "analyze_urls" and context.tool_policy.allow_url_analysis:
            query = (decision.question or decision.query or context.task).strip()
            url_sources = _pick_url_sources(context=context, requested_ids=decision.source_ids)
            result = await broker.analyze_urls(
                question=query,
                sources=url_sources,
                event_callback=_broker_event,
            )
        elif decision.tool_name == "analyze_file" and context.tool_policy.allow_file_analysis:
            source = _pick_file_source(context=context, requested_ids=decision.source_ids)
            result = await broker.analyze_file(
                question=(decision.question or decision.query or context.task).strip(),
                source=source,
            )
        elif decision.tool_name == "execute_python" and context.tool_policy.allow_code_execution:
            selected_sources = _pick_code_sources(context=context, requested_ids=decision.source_ids)
            await _emit_tool_event(
                context.event_sink,
                "sandbox_execution_started",
                context=context,
                payload={
                    "tool_call_id": call_id,
                    "tool_name": decision.tool_name,
                    "source_ids": [source.source_id for source in selected_sources],
                    "python_code_preview": decision.python_code.strip()[:1200],
                },
            )
            result = await broker.execute_python(
                code=decision.python_code.strip(),
                sources=selected_sources,
                timeout_seconds=context.tool_policy.execution_timeout_seconds,
            )
            if result.stdout or result.stderr:
                await _emit_tool_event(
                    context.event_sink,
                    "sandbox_execution_delta",
                    context=context,
                    payload={
                        "tool_call_id": call_id,
                        "tool_name": decision.tool_name,
                        "stdout_preview": (result.stdout or "")[:4000],
                        "stderr_preview": (result.stderr or "")[:1000],
                    },
                )
            await _emit_tool_event(
                context.event_sink,
                "sandbox_execution_completed",
                context=context,
                payload={
                    "tool_call_id": call_id,
                    "tool_name": decision.tool_name,
                    "exit_code": result.exit_code,
                    "summary": result.summary,
                    "stderr_preview": (result.stderr or "")[:1000],
                },
            )
        else:
            raise RuntimeError(f"Tool {decision.tool_name} is disabled or unsupported in this context")
    except Exception as exc:
        await _emit_tool_event(
            context.event_sink,
            "tool_call_failed",
            context=context,
            payload={
                "tool_name": decision.tool_name,
                "tool_call_id": call_id,
                "error": str(exc),
                "rationale": decision.rationale,
            },
        )
        raise

    if result.raw_text:
        await _emit_tool_event(
            context.event_sink,
            "tool_call_delta",
            context=context,
            payload={
                "tool_call_id": call_id,
                "tool_name": decision.tool_name,
                "summary": result.summary,
                "result_preview": result.raw_text[:4000],
            },
        )
    await _emit_tool_event(
        context.event_sink,
        "tool_call_completed",
        context=context,
        payload={
            "tool_call_id": call_id,
            "tool_name": decision.tool_name,
            "summary": result.summary,
            "citations": [citation.model_dump(mode="json") for citation in result.citations],
            "status": result.status,
        },
    )
    return result.model_copy(
        update={
            "raw_metadata": {
                **dict(result.raw_metadata),
                "tool_call_id": call_id,
            }
        }
    )


def _build_decision_prompt(
    *,
    task: str,
    original_prompt: str,
    context: ToolInvocationContext,
    retry_context: str = "",
    prior_tool_results: list[ToolResult] | None = None,
) -> str:
    source_lines = [
        f"- {source.source_id} | {source.kind} | {source.display_name}"
        + (f" | {source.source_url}" if source.source_url else "")
        + (
            f" | sandbox_path={_sandbox_mount_path(source.source_id, source.display_name)}"
            if source.kind in {"text_file", "code_file"}
            else ""
        )
        for source in context.sources
    ]
    allowed_tools: list[str] = []
    if context.tool_policy.allow_search:
        allowed_tools.append("search_online")
    if context.tool_policy.allow_url_analysis:
        allowed_tools.append("analyze_urls")
    if context.tool_policy.allow_file_analysis:
        allowed_tools.append("analyze_file")
    if context.tool_policy.allow_code_execution:
        allowed_tools.append("execute_python")
    prior_tool_context = _tool_planning_context(prior_tool_results or [])
    return (
        f"Task:\n{task}\n\n"
        f"Stage: {context.stage}\n"
        f"Agent: {context.agent_id}\n"
        f"Round: {context.round_index}\n\n"
        f"Current prompt to answer:\n{original_prompt}\n\n"
        + (f"Previous tool attempt feedback:\n{retry_context}\n\n" if retry_context else "")
        + (f"Tool context so far:\n{prior_tool_context}\n\n" if prior_tool_context else "")
        + (
        f"Allowed tools: {', '.join(allowed_tools) if allowed_tools else 'none'}\n"
        f"Tool budget for this pass: up to {context.tool_policy.max_tool_calls_per_agent} calls total.\n"
        f"Available sources:\n{chr(10).join(source_lines) if source_lines else '- none'}\n\n"
        "Decide whether exactly one tool call would materially improve answer quality.\n"
        "Optimize your tool budget: front-load the most decisive checks, avoid redundant calls, and stop once confidence gains flatten.\n"
        "Use a tool whenever the task requires exact computation, fresh web evidence, URL comparison, or file inspection.\n"
        "If attached files exist, prefer analyze_file or execute_python before answering from memory.\n"
        "For execute_python, use the listed sandbox_path values exactly. Attached files are read-only under /workspace/input and outputs belong under /workspace/output.\n"
        "Sandbox libraries available without pip install: pandas, numpy, polars, duckdb, pyarrow, scipy, matplotlib, seaborn, openpyxl, xlrd, pyxlsb, pyyaml, python-dateutil, tabulate, plus the Python standard library.\n"
        "Use pandas/openpyxl/xlrd/pyxlsb for spreadsheet formats like .xlsx/.xls/.xlsb. Use pyarrow/polars/duckdb/pandas for parquet or structured tabular data. Use csv only for plain-text CSV/TSV, not for binary spreadsheets.\n"
        "Supported uploaded inputs for tool use are: code/text (.py .ts .tsx .js .jsx .json .md .txt .csv .tsv .yaml .yml), tabular binaries (.xlsx .xls .xlsb .parquet), PDFs, and images.\n"
        "PDFs and images should usually go through analyze_file first. Spreadsheets and tabular binaries should usually go through execute_python.\n"
        "Do not write pip install commands, do not assume network access, and if a needed library or file format is unavailable then say so explicitly.\n"
        "If a prior tool attempt failed, either correct it once or stop using tools and answer from available evidence.\n"
        "Example search_online: 'What is the latest US interest rate decision?'\n"
        "Example analyze_urls: 'Compare these two public API docs and find the breaking change.'\n"
        "Example analyze_file: 'Read the attached PDF/image and extract the key claim.'\n"
        "Example execute_python: 'Compute a SHA256 digest, parse an attached CSV/TSV/XLSX/Parquet file, or verify exact arithmetic.'"
        )
    )


def _pick_file_source(
    *,
    context: ToolInvocationContext,
    requested_ids: list[str],
) -> SourceRef:
    allowed = [source for source in context.sources if source.kind in {"text_file", "code_file", "pdf", "image"}]
    if requested_ids:
        requested = [source for source in allowed if source.source_id in requested_ids]
        if requested:
            return requested[0]
    if not allowed:
        raise RuntimeError("No file sources are attached to this task")
    return allowed[0]


def _pick_url_sources(
    *,
    context: ToolInvocationContext,
    requested_ids: list[str],
) -> list[SourceRef]:
    allowed = [source for source in context.sources if source.kind == "url" and source.source_url]
    if requested_ids:
        requested = [source for source in allowed if source.source_id in requested_ids]
        if requested:
            return requested
    return allowed[: context.tool_policy.max_urls_per_call]


def _pick_code_sources(
    *,
    context: ToolInvocationContext,
    requested_ids: list[str],
) -> list[SourceRef]:
    allowed = [source for source in context.sources if source.kind in {"text_file", "code_file"}]
    if requested_ids:
        selected = [source for source in allowed if source.source_id in requested_ids]
        if selected:
            return selected[: context.tool_policy.max_files_per_call]
    if not allowed:
        raise RuntimeError("No code/text sources are attached for sandbox execution")
    return allowed[: context.tool_policy.max_files_per_call]


def _sandbox_mount_path(source_id: str, display_name: str) -> str:
    source_slug = _sanitize_for_sandbox_path(source_id) or "source"
    display_slug = _sanitize_for_sandbox_path(display_name)
    return f"/workspace/input/{source_slug}__{display_slug}"


def _sanitize_for_sandbox_path(value: str) -> str:
    candidate = value.strip().split("/")[-1].split("\\")[-1] or "source"
    return "".join(char if char.isalnum() or char in {"-", "_", "."} else "_" for char in candidate)


def _tool_result_context_block(result: ToolResult) -> str:
    citation_lines = [
        f"- [{index + 1}] {citation.title}"
        + (f" ({citation.domain})" if citation.domain else "")
        + (f" {citation.url}" if citation.url else "")
        for index, citation in enumerate(result.citations[:5])
    ]
    detail = result.raw_text or result.stdout or result.stderr or ""
    return (
        "Tool evidence:\n"
        f"Tool: {result.tool_name}\n"
        f"Status: {result.status}\n"
        f"Summary: {result.summary}\n"
        f"Citations:\n{chr(10).join(citation_lines) if citation_lines else '- none'}\n"
        f"Ephemeral detail:\n{detail[:4000] if detail else '(none)'}\n"
        "Use this evidence directly. Distinguish retrieved evidence from your own inference."
    )


def _tool_retry_context_block(result: ToolResult) -> str:
    detail = result.stderr or result.raw_text or result.summary
    return (
        f"Tool {result.tool_name} failed.\n"
        f"Summary: {result.summary}\n"
        f"Failure detail:\n{detail[:2000] if detail else '(none)'}\n"
        "If you retry, correct the mistake directly. Otherwise continue without another tool call."
    )


def _failed_tool_result(
    *,
    decision: ToolDecision,
    context: ToolInvocationContext,
    call_id: str,
    message: str,
) -> ToolResult:
    selected_sources = [
        source for source in context.sources if not decision.source_ids or source.source_id in decision.source_ids
    ]
    detail = message.strip() or "Tool execution failed"
    request_payload: dict[str, Any] = {
        "query": decision.query,
        "question": decision.question,
        "source_ids": list(decision.source_ids),
    }
    if decision.tool_name == "execute_python":
        request_payload["python_code"] = decision.python_code.strip()
    return ToolResult(
        tool_name=decision.tool_name,
        status="failed",
        request=request_payload,
        summary=f"{decision.tool_name} failed: {detail}",
        sources=selected_sources,
        stderr=detail,
        raw_text=detail,
        raw_metadata={"tool_call_id": call_id},
    )


def _tool_planning_context(results: list[ToolResult]) -> str:
    if not results:
        return ""
    lines: list[str] = []
    for index, result in enumerate(results, start=1):
        lines.append(
            f"{index}. {result.tool_name} [{result.status}] - {result.summary}"
        )
    return "\n".join(lines)


async def _emit_tool_event(
    event_sink: EventSink | None,
    event_type: str,
    *,
    context: ToolInvocationContext,
    payload: dict[str, Any],
) -> None:
    if event_sink is None:
        return
    await event_sink(
        event_type,
        {
            "agent_id": context.agent_id,
            "round_number": context.round_index,
            "stage": context.stage,
            "timestamp": datetime.now(UTC).isoformat(),
            **payload,
        },
    )


def normalize_raw_usage(
    *,
    usage: dict[str, Any],
    model_name: str,
    provider: str,
) -> dict[str, Any]:
    """Normalize one raw caller usage payload into engine-style aggregate format."""

    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    thinking_tokens = usage.get("thinking_tokens", usage.get("reasoning_tokens"))
    total_tokens = int(
        usage.get("tokens")
        or usage.get("total_tokens")
        or (int(input_tokens or 0) + int(output_tokens or 0) + int(thinking_tokens or 0))
    )
    return {
        "tokens": total_tokens,
        "total_tokens": total_tokens,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "thinking_tokens": thinking_tokens,
        "reasoning_tokens": usage.get("reasoning_tokens"),
        "model_tokens": {model_name: total_tokens},
        "model_input_tokens": ({model_name: int(input_tokens)} if input_tokens is not None else {}),
        "model_output_tokens": ({model_name: int(output_tokens)} if output_tokens is not None else {}),
        "model_thinking_tokens": (
            {model_name: int(thinking_tokens)} if thinking_tokens is not None else {}
        ),
        "model_latency_ms": {model_name: float(usage.get("latency_ms", 0.0))},
        "latency_ms": float(usage.get("latency_ms", 0.0)),
        "provider": provider,
        "fallback_events": list(usage.get("fallback_events", [])),
    }


def _merge_numeric_map(target: dict[str, Any], source: Any) -> None:
    if not isinstance(source, dict):
        return
    for key, value in source.items():
        if not isinstance(key, str):
            continue
        numeric = float(value or 0.0)
        existing = target.get(key, 0)
        if isinstance(existing, float) or isinstance(value, float):
            target[key] = float(existing) + numeric
        else:
            target[key] = int(existing) + int(numeric)
