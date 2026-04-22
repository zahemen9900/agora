from __future__ import annotations

import asyncio

import pytest

from api.live_journal import BufferedEventJournal, BufferedStateWriter


@pytest.mark.asyncio
async def test_buffered_event_journal_emits_immediately_and_batches_persistence() -> None:
    emitted: list[str] = []
    persisted_batches: list[list[str]] = []

    async def emit(payload: dict[str, object]) -> None:
        emitted.append(str(payload["event"]))

    async def append_many(payloads: list[dict[str, object]]) -> None:
        persisted_batches.append([str(payload["event"]) for payload in payloads])

    journal = BufferedEventJournal(
        emit=emit,
        append_many=append_many,
        flush_interval_seconds=0.01,
        max_buffered_events=8,
    )

    await journal.publish({"event": "agent_output_delta"}, buffered=True)
    await journal.publish({"event": "thinking_delta"}, buffered=True)

    assert emitted == ["agent_output_delta", "thinking_delta"]
    assert persisted_batches == []

    await asyncio.sleep(0.03)
    await journal.close()

    assert persisted_batches == [["agent_output_delta", "thinking_delta"]]


@pytest.mark.asyncio
async def test_buffered_event_journal_flushes_buffer_before_immediate_event() -> None:
    persisted_batches: list[list[str]] = []

    async def emit(_payload: dict[str, object]) -> None:
        return None

    async def append_many(payloads: list[dict[str, object]]) -> None:
        persisted_batches.append([str(payload["event"]) for payload in payloads])

    journal = BufferedEventJournal(
        emit=emit,
        append_many=append_many,
        flush_interval_seconds=1.0,
        max_buffered_events=8,
    )

    await journal.publish({"event": "agent_output_delta"}, buffered=True)
    await journal.publish({"event": "complete"}, buffered=False)
    await journal.close()

    assert persisted_batches == [["agent_output_delta"], ["complete"]]


@pytest.mark.asyncio
async def test_buffered_state_writer_coalesces_multiple_updates() -> None:
    saved_snapshots: list[dict[str, object]] = []
    state = {"status": "running", "completed": 0}

    async def save(snapshot: dict[str, object]) -> None:
        saved_snapshots.append(snapshot)

    writer = BufferedStateWriter(
        save=save,
        snapshot=lambda: dict(state),
        flush_interval_seconds=0.01,
    )

    state["completed"] = 1
    await writer.mark_dirty()
    state["completed"] = 2
    await writer.mark_dirty()
    await asyncio.sleep(0.03)
    await writer.close()

    assert saved_snapshots == [{"status": "running", "completed": 2}]
