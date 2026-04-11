"""Tests for the Josh-side Solana bridge client."""

from __future__ import annotations

import json

import httpx
import pytest

from agora.solana.client import SolanaClient, SolanaReceipt, build_decision_hash, build_task_id


def test_build_task_id_is_deterministic() -> None:
    """Task identifiers should be stable for the same prompt."""

    first = build_task_id("capital of france")
    second = build_task_id("capital of france")
    different = build_task_id("different task")

    assert first == second
    assert first != different


def test_build_decision_hash_changes_with_inputs() -> None:
    """Decision hash should change when material receipt fields change."""

    base = build_decision_hash(
        task_id="task-1",
        mechanism="vote",
        merkle_root="root-a",
        final_answer_hash="answer-a",
        round_count=1,
        mechanism_switches=0,
    )
    changed = build_decision_hash(
        task_id="task-1",
        mechanism="debate",
        merkle_root="root-a",
        final_answer_hash="answer-a",
        round_count=1,
        mechanism_switches=0,
    )

    assert base != changed


@pytest.mark.asyncio
async def test_submit_receipt_posts_expected_payload() -> None:
    """Receipt submission should hit the expected bridge endpoint."""

    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(200, json={"tx_signature": "receipt-tx"})

    client = SolanaClient(
        base_url="https://bridge.example",
        transport=httpx.MockTransport(handler),
    )
    receipt = SolanaReceipt(
        task_id="task-123",
        decision_hash="decision-abc",
        mechanism="vote",
        merkle_root="root",
        final_answer_hash="answer-hash",
        quorum_reached=True,
        round_count=1,
        mechanism_switches=0,
        selector_reasoning_hash="reasoning-hash",
    )

    tx_signature = await client.submit_receipt(receipt)

    assert tx_signature == "receipt-tx"
    assert captured["method"] == "POST"
    assert captured["path"] == "/tasks/task-123/receipt"
    assert captured["body"] == receipt.model_dump(mode="json")


@pytest.mark.asyncio
async def test_get_task_status_normalizes_response() -> None:
    """Task status should return a normalized dict payload."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/tasks/task-123"
        return httpx.Response(
            200,
            json={
                "task_id": "task-123",
                "status": "confirmed",
                "tx_signature": "receipt-tx",
                "mechanism": "vote",
                "merkle_root": "root",
                "decision_hash": "decision-abc",
                "metadata": {"confirmations": 3},
            },
        )

    client = SolanaClient(
        base_url="https://bridge.example",
        transport=httpx.MockTransport(handler),
    )

    status = await client.get_task_status("task-123")

    assert status["task_id"] == "task-123"
    assert status["status"] == "confirmed"
    assert status["metadata"]["confirmations"] == 3
