from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from pydantic import BaseModel

from agora.tools.runtime import (
    ToolDecision,
    ToolInvocationContext,
    ToolPolicyConfig,
    maybe_augment_prompt_with_tool,
)
from agora.tools.types import SourceRef, ToolResult


class _FakeCaller:
    def __init__(self, responses: list[ToolDecision]) -> None:
        self.model = "fake-model"
        self._responses = list(responses)
        self.prompts: list[str] = []

    async def call(
        self,
        system_prompt: str,
        user_prompt: str,
        response_format: type[BaseModel] | None = None,
        temperature: float | None = None,
        stream: bool = False,
        stream_callback: Callable[[str], None] | None = None,
    ) -> tuple[ToolDecision, dict[str, Any]]:
        del system_prompt, response_format, temperature, stream, stream_callback
        self.prompts.append(user_prompt)
        return self._responses.pop(0), {"tokens": 3, "latency_ms": 5.0}


class _OpenRouterFallbackCaller:
    def __init__(self) -> None:
        self.model = "qwen/qwen3.5-flash-02-23"
        self.calls: list[type[BaseModel] | None] = []

    async def call(
        self,
        system_prompt: str,
        user_prompt: str,
        response_format: type[BaseModel] | None = None,
        temperature: float | None = None,
        stream: bool = False,
        stream_callback: Callable[[str], None] | None = None,
    ) -> tuple[str | ToolDecision, dict[str, Any]]:
        del system_prompt, user_prompt, temperature, stream, stream_callback
        self.calls.append(response_format)
        if response_format is not None:
            raise RuntimeError("structured tool planning failed")
        return (
            """```json
{"should_call":true,"tool_name":"execute_python","rationale":"Need exact computation","source_ids":["file-1"],"python_code":"print(42)"}
```""",
            {"tokens": 4, "latency_ms": 6.0},
        )


class _RaisingBroker:
    def __init__(self) -> None:
        self.calls = 0

    async def execute_python(
        self,
        *,
        code: str,
        sources: list[SourceRef],
        timeout_seconds: int,
    ) -> ToolResult:
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("sandbox boom")
        return ToolResult(
            tool_name="execute_python",
            status="success",
            request={"timeout_seconds": timeout_seconds, "code": code},
            summary="Executed Python sandbox task successfully",
            sources=sources,
            stdout="42\n",
            exit_code=0,
        )


class _FailedThenStopBroker:
    async def execute_python(
        self,
        *,
        code: str,
        sources: list[SourceRef],
        timeout_seconds: int,
    ) -> ToolResult:
        del code, timeout_seconds
        return ToolResult(
            tool_name="execute_python",
            status="failed",
            request={},
            summary="Python sandbox execution failed with exit code 1",
            sources=sources,
            stderr="NameError: df is not defined",
            exit_code=1,
        )


class _MultiToolBroker:
    async def analyze_file(
        self,
        *,
        question: str,
        source: SourceRef,
    ) -> ToolResult:
        return ToolResult(
            tool_name="analyze_file",
            status="success",
            request={"question": question},
            summary="Loaded local text file source dataset.csv",
            sources=[source],
            raw_text="vendor,cost,uptime\nhelix,140000,99.95\n",
        )

    async def execute_python(
        self,
        *,
        code: str,
        sources: list[SourceRef],
        timeout_seconds: int,
    ) -> ToolResult:
        del code, timeout_seconds
        return ToolResult(
            tool_name="execute_python",
            status="success",
            request={},
            summary="Executed Python sandbox task successfully",
            sources=sources,
            stdout="best_vendor=helix\n",
            exit_code=0,
        )


def _source() -> SourceRef:
    return SourceRef(
        source_id="file-1",
        kind="text_file",
        display_name="dataset.csv",
        mime_type="text/csv",
        storage_uri="file:///tmp/dataset.csv",
        size_bytes=128,
    )


@pytest.mark.asyncio
async def test_tool_runtime_retries_once_after_execute_python_exception() -> None:
    events: list[tuple[str, dict[str, Any]]] = []
    caller = _FakeCaller(
        [
            ToolDecision(
                should_call=True,
                tool_name="execute_python",
                rationale="Need exact computation",
                source_ids=["file-1"],
                python_code="print('bad first try')",
            ),
            ToolDecision(
                should_call=True,
                tool_name="execute_python",
                rationale="Retry with corrected code",
                source_ids=["file-1"],
                python_code="print(42)",
            ),
        ]
    )
    result = await maybe_augment_prompt_with_tool(
        caller=caller,
        system_prompt="system",
        user_prompt="Parse the CSV and compute the exact winner.",
        context=ToolInvocationContext(
            task="Parse the CSV and compute the exact winner.",
            agent_id="agent-1",
            round_index=0,
            stage="independent_generation",
            sources=[_source()],
            tool_policy=ToolPolicyConfig(),
            event_sink=lambda event_type, payload: _capture_event(events, event_type, payload),
            broker=_RaisingBroker(),
        ),
    )

    assert len(result.tool_results) == 2
    assert result.tool_results[0].status == "failed"
    assert result.tool_results[1].status == "success"
    assert result.planning_usage["tokens"] == 6
    assert any(event_type == "tool_call_retrying" for event_type, _payload in events)
    assert "Previous tool attempt feedback:" in caller.prompts[1]
    assert "sandbox boom" in result.user_prompt
    assert "Executed Python sandbox task successfully" in result.user_prompt


@pytest.mark.asyncio
async def test_tool_runtime_failed_execute_python_does_not_abort_when_model_declines_retry() -> None:
    caller = _FakeCaller(
        [
            ToolDecision(
                should_call=True,
                tool_name="execute_python",
                rationale="Need exact computation",
                source_ids=["file-1"],
                python_code="print(df.head())",
            ),
            ToolDecision(
                should_call=False,
                rationale="Proceed without another tool call",
            ),
        ]
    )

    result = await maybe_augment_prompt_with_tool(
        caller=caller,
        system_prompt="system",
        user_prompt="Read the attached CSV and summarize the best vendor.",
        context=ToolInvocationContext(
            task="Read the attached CSV and summarize the best vendor.",
            agent_id="agent-1",
            round_index=0,
            stage="independent_generation",
            sources=[_source()],
            tool_policy=ToolPolicyConfig(),
            broker=_FailedThenStopBroker(),
        ),
    )

    assert len(result.tool_results) == 1
    assert result.tool_results[0].status == "failed"
    assert "NameError: df is not defined" in result.user_prompt
    assert result.planning_usage["tokens"] == 6


@pytest.mark.asyncio
async def test_tool_runtime_allows_multiple_successive_tool_calls_in_one_pass() -> None:
    caller = _FakeCaller(
        [
            ToolDecision(
                should_call=True,
                tool_name="analyze_file",
                rationale="Inspect the attached dataset schema first",
                source_ids=["file-1"],
                question="Read the attached CSV and confirm its columns.",
            ),
            ToolDecision(
                should_call=True,
                tool_name="execute_python",
                rationale="Now compute the exact winner from the parsed file",
                source_ids=["file-1"],
                python_code="print('best_vendor=helix')",
            ),
            ToolDecision(
                should_call=False,
                rationale="Further tools would be redundant",
            ),
        ]
    )

    result = await maybe_augment_prompt_with_tool(
        caller=caller,
        system_prompt="system",
        user_prompt="Inspect the attached vendor dataset and determine the best option exactly.",
        context=ToolInvocationContext(
            task="Inspect the attached vendor dataset and determine the best option exactly.",
            agent_id="agent-1",
            round_index=0,
            stage="independent_generation",
            sources=[_source()],
            tool_policy=ToolPolicyConfig(),
            broker=_MultiToolBroker(),
        ),
    )

    assert len(result.tool_results) == 2
    assert result.tool_results[0].tool_name == "analyze_file"
    assert result.tool_results[1].tool_name == "execute_python"
    assert result.tool_results[0].status == "success"
    assert result.tool_results[1].status == "success"
    assert "Tool budget for this pass: up to 12 calls total." in caller.prompts[0]
    assert "Loaded local text file source dataset.csv" in caller.prompts[1]
    assert "Executed Python sandbox task successfully" in result.user_prompt
    assert result.planning_usage["tokens"] == 9


@pytest.mark.asyncio
async def test_tool_runtime_falls_back_to_raw_openrouter_tool_decision() -> None:
    caller = _OpenRouterFallbackCaller()

    result = await maybe_augment_prompt_with_tool(
        caller=caller,
        system_prompt="system",
        user_prompt="Read the attached CSV and compute the exact winner.",
        context=ToolInvocationContext(
            task="Read the attached CSV and compute the exact winner.",
            agent_id="agent-1",
            round_index=0,
            stage="independent_generation",
            sources=[_source()],
            tool_policy=ToolPolicyConfig(max_tool_calls_per_agent=1),
            broker=_MultiToolBroker(),
        ),
    )

    assert caller.calls == [ToolDecision, None]
    assert len(result.tool_results) == 1
    assert result.tool_results[0].tool_name == "execute_python"
    assert result.tool_results[0].status == "success"
    assert "Executed Python sandbox task successfully" in result.user_prompt


async def _capture_event(
    sink: list[tuple[str, dict[str, Any]]],
    event_type: str,
    payload: dict[str, Any],
) -> None:
    sink.append((event_type, payload))
