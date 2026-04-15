from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from agora.runtime.hasher import TranscriptHasher
from agora.runtime.orchestrator import AgoraOrchestrator
from agora.sdk import AgoraArbitrator, AgoraNode, ReceiptVerificationError
from api.main import app
from api.routes import benchmarks as benchmark_routes
from api.routes import tasks as task_routes
from api.store_local import LocalTaskStore
from benchmarks.runner import BenchmarkRunner


def test_benchmark_runner_loads_curated_dataset() -> None:
    dataset = BenchmarkRunner.load_dataset("math")
    dataset_by_spec_name = BenchmarkRunner.load_dataset("math_tasks")

    assert len(dataset) == 20
    assert dataset == dataset_by_spec_name
    assert {item["category"] for item in dataset} == {"math"}
    assert all("task" in item for item in dataset)
    assert all("source" in item for item in dataset)


def test_benchmark_runner_builds_default_phase2_split() -> None:
    training, holdout = BenchmarkRunner.build_phase2_task_split()

    assert len(training) == 30
    assert len(holdout) == 10
    assert {item["category"] for item in training} == {
        "math",
        "factual",
        "reasoning",
        "code",
        "creative",
    }


@pytest.mark.asyncio
async def test_benchmarks_route_reads_store_summary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "benchmarks-data"))
    task_routes._store = store
    summary = {
        "summary": {
            "per_mode": {"selector": {"accuracy": 0.8}},
            "per_category": {"reasoning": {"selector": {"accuracy": 0.75}}},
        }
    }

    try:
        monkeypatch.setattr(benchmark_routes.settings, "benchmark_admin_token", "admin-token")
        await store.save_benchmark_summary(summary)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get(
                "/benchmarks",
                headers={"x-agora-admin-token": "admin-token"},
            )

        assert response.status_code == 200
        assert response.json() == summary
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_benchmarks_route_requires_admin_token(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "benchmarks-tasks"))
    task_routes._store = store

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get("/benchmarks")

        assert response.status_code == 403
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_benchmarks_route_uses_file_fallback_not_completed_tasks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "benchmarks-order"))
    original_results_path = benchmark_routes._RESULTS_PATH
    task_routes._store = store
    benchmark_routes._RESULTS_PATH = tmp_path / "phase2-validation-file.json"

    file_payload = {
        "summary": {
            "per_mode": {"selector": {"accuracy": 0.11}},
            "per_category": {"math": {"selector": {"accuracy": 0.22}}},
        },
        "metadata": {"source": "file_artifact"},
    }
    benchmark_routes._RESULTS_PATH.write_text(json.dumps(file_payload), encoding="utf-8")

    task_payload = {
        "task_id": "task-2",
        "task_text": "Should we split this service now?",
        "mechanism": "vote",
        "status": "completed",
        "selector_reasoning": "Use vote for low disagreement.",
        "selector_reasoning_hash": "hash-2",
        "selector_confidence": 0.83,
        "result": {
            "task_id": "task-2",
            "mechanism": "vote",
            "final_answer": "No, keep it together.",
            "confidence": 0.9,
            "quorum_reached": True,
            "merkle_root": "root-2",
            "decision_hash": "decision-2",
            "total_tokens_used": 98,
            "latency_ms": 30.0,
            "round_count": 1,
            "mechanism_switches": 0,
            "transcript_hashes": ["leaf-2"],
            "convergence_history": [],
            "locked_claims": [],
        },
    }

    try:
        monkeypatch.setattr(benchmark_routes.settings, "benchmark_admin_token", "admin-token")
        await store.save_task("user-1", "task-2", task_payload)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get(
                "/benchmarks",
                headers={"x-agora-admin-token": "admin-token"},
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["metadata"]["source"] == "file_artifact"
        assert payload["summary"]["per_mode"]["selector"]["accuracy"] == 0.11
    finally:
        task_routes._store = None
        benchmark_routes._RESULTS_PATH = original_results_path


@pytest.mark.asyncio
async def test_phase2_validation_reruns_are_deterministic_offline(tmp_path: Path) -> None:
    async def deterministic_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt, user_prompt
        return {
            "answer": "Option A",
            "confidence": 0.84,
            "predicted_group_answer": "Option A",
            "reasoning": "Deterministic test agent.",
        }

    training, holdout = BenchmarkRunner.build_phase2_task_split(
        training_per_category=1,
        holdout_per_category=1,
    )
    orchestrator = AgoraOrchestrator(agent_count=3)
    runner = BenchmarkRunner(orchestrator, agents=[deterministic_agent] * 3)

    payload = await runner.run_phase2_validation(
        training_tasks=training,
        holdout_tasks=holdout,
        output_path=str(tmp_path / "phase2_validation_test.json"),
        seed=7,
    )

    assert payload["pre_learning"]["runs"]
    assert all(run["merkle_deterministic"] is True for run in payload["pre_learning"]["runs"])


@pytest.mark.asyncio
async def test_phase2_validation_seeded_mode_raises_on_merkle_divergence(
    tmp_path: Path,
) -> None:
    call_counter = {"value": 0}

    async def changing_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt, user_prompt
        call_counter["value"] += 1
        answer = f"Option {call_counter['value']}"
        return {
            "answer": answer,
            "confidence": 0.55,
            "predicted_group_answer": answer,
            "reasoning": "Intentional non-deterministic test agent.",
        }

    orchestrator = AgoraOrchestrator(agent_count=3)
    runner = BenchmarkRunner(orchestrator, agents=[changing_agent] * 3)

    training_tasks = [
        {
            "task": "Is 2+2 equal to 4?",
            "category": "math",
            "ground_truth": "4",
        }
    ]

    with pytest.raises(
        RuntimeError,
        match="Determinism check failed for training task index=0 category=math",
    ):
        await runner.run_phase2_validation(
            training_tasks=training_tasks,
            holdout_tasks=[],
            output_path=str(tmp_path / "phase2_validation_failure.json"),
            seed=11,
        )


@pytest.mark.asyncio
async def test_sdk_local_mode_supports_custom_agents() -> None:
    async def unanimous_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt, user_prompt
        return {
            "answer": "BTC",
            "confidence": 0.92,
            "predicted_group_answer": "BTC",
            "reasoning": "All agents independently prefer BTC here.",
        }

    arbitrator = AgoraArbitrator(
        mechanism="vote",
        agent_count=3,
        strict_verification=False,
    )
    result = await arbitrator.arbitrate(
        "Should I buy Solana or BTC?",
        agents=[unanimous_agent, unanimous_agent, unanimous_agent],
    )
    verification = await arbitrator.verify_receipt(result)
    await arbitrator.aclose()

    assert result.mechanism_used.value == "vote"
    assert result.quorum_reached is True
    assert result.final_answer == "BTC"
    assert verification["valid"] is True


@pytest.mark.asyncio
async def test_sdk_verify_receipt_strict_raises_without_task_mapping() -> None:
    async def unanimous_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt, user_prompt
        return {
            "answer": "BTC",
            "confidence": 0.93,
            "predicted_group_answer": "BTC",
            "reasoning": "Deterministic vote.",
        }

    arbitrator = AgoraArbitrator(
        mechanism="vote",
        agent_count=3,
        solana_wallet="wallet-test",
    )
    result = await arbitrator.arbitrate(
        "Should I buy Solana or BTC?",
        agents=[unanimous_agent, unanimous_agent, unanimous_agent],
    )
    with pytest.raises(ReceiptVerificationError):
        await arbitrator.verify_receipt(result)
    await arbitrator.aclose()


@pytest.mark.asyncio
async def test_sdk_verify_receipt_lenient_allows_missing_task_mapping() -> None:
    async def unanimous_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt, user_prompt
        return {
            "answer": "BTC",
            "confidence": 0.93,
            "predicted_group_answer": "BTC",
            "reasoning": "Deterministic vote.",
        }

    arbitrator = AgoraArbitrator(
        mechanism="vote",
        agent_count=3,
        solana_wallet="wallet-test",
        strict_verification=False,
    )
    result = await arbitrator.arbitrate(
        "Should I buy Solana or BTC?",
        agents=[unanimous_agent, unanimous_agent, unanimous_agent],
    )
    verification = await arbitrator.verify_receipt(result)
    await arbitrator.aclose()

    assert verification["valid"] is True
    assert verification["on_chain_match"] is None


def test_sdk_hosted_mode_keeps_bearer_auth_token_interface() -> None:
    arbitrator = AgoraArbitrator(
        api_url="https://example.invalid",
        auth_token="agora_test_public.secret",
        strict_verification=False,
    )

    assert arbitrator._headers() == {
        "Authorization": "Bearer agora_test_public.secret",
    }


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


@pytest.mark.asyncio
async def test_sdk_verify_receipt_strict_hosted_payload_mismatch_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def unanimous_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt, user_prompt
        return {
            "answer": "BTC",
            "confidence": 0.93,
            "predicted_group_answer": "BTC",
            "reasoning": "Deterministic vote.",
        }

    arbitrator = AgoraArbitrator(
        mechanism="vote",
        agent_count=3,
        solana_wallet="wallet-test",
    )
    result = await arbitrator.arbitrate(
        "Should I buy Solana or BTC?",
        agents=[unanimous_agent, unanimous_agent, unanimous_agent],
    )
    arbitrator._result_task_ids[result.merkle_root] = "task-verify-1"

    decision_hash = TranscriptHasher().hash_content(result.final_answer)
    mismatched_payload: dict[str, Any] = {
        "merkle_root": result.merkle_root,
        "decision_hash": decision_hash,
        "solana_tx_hash": "",
        "result": {
            "merkle_root": result.merkle_root,
            "decision_hash": decision_hash,
            "final_answer": result.final_answer,
            "transcript_hashes": result.transcript_hashes,
        },
    }

    async def fake_get(*_args: object, **_kwargs: object) -> _FakeResponse:
        return _FakeResponse(mismatched_payload)

    monkeypatch.setattr(arbitrator._client, "get", fake_get)
    with pytest.raises(ReceiptVerificationError):
        await arbitrator.verify_receipt(result)
    await arbitrator.aclose()


@pytest.mark.asyncio
async def test_sdk_verify_receipt_strict_hosted_payload_still_requires_chain_proof(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def unanimous_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt, user_prompt
        return {
            "answer": "BTC",
            "confidence": 0.93,
            "predicted_group_answer": "BTC",
            "reasoning": "Deterministic vote.",
        }

    arbitrator = AgoraArbitrator(
        mechanism="vote",
        agent_count=3,
        solana_wallet="wallet-test",
    )
    result = await arbitrator.arbitrate(
        "Should I buy Solana or BTC?",
        agents=[unanimous_agent, unanimous_agent, unanimous_agent],
    )
    arbitrator._result_task_ids[result.merkle_root] = "task-verify-2"

    decision_hash = TranscriptHasher().hash_content(result.final_answer)
    payload: dict[str, Any] = {
        "merkle_root": result.merkle_root,
        "decision_hash": decision_hash,
        "solana_tx_hash": "tx-123",
        "result": {
            "merkle_root": result.merkle_root,
            "decision_hash": decision_hash,
            "final_answer": result.final_answer,
            "transcript_hashes": result.transcript_hashes,
        },
    }

    async def fake_get(*_args: object, **_kwargs: object) -> _FakeResponse:
        return _FakeResponse(payload)

    monkeypatch.setattr(arbitrator._client, "get", fake_get)
    with pytest.raises(ReceiptVerificationError, match="Strict on-chain receipt verification"):
        await arbitrator.verify_receipt(result)
    await arbitrator.aclose()


@pytest.mark.asyncio
async def test_sdk_verify_receipt_uses_hosted_task_mapping_without_wallet(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arbitrator = AgoraArbitrator(
        mechanism="vote",
        agent_count=3,
        strict_verification=False,
    )
    hasher = TranscriptHasher()
    final_answer = "BTC"
    transcript_hashes = [
        hasher.hash_content("agent-1: BTC"),
        hasher.hash_content("agent-2: BTC"),
        hasher.hash_content("agent-3: BTC"),
    ]
    merkle_root = hasher.build_merkle_tree(transcript_hashes)
    decision_hash = hasher.hash_content(final_answer)

    status_payload: dict[str, Any] = {
        "task_id": "task-hosted-verify",
        "task_text": "Should I buy Solana or BTC?",
        "mechanism": "vote",
        "status": "completed",
        "selector_reasoning": "Low disagreement, use vote.",
        "selector_reasoning_hash": "selector-hash",
        "selector_confidence": 0.91,
        "merkle_root": merkle_root,
        "decision_hash": decision_hash,
        "solana_tx_hash": "tx-123",
        "payment_amount": 0.0,
        "result": {
            "mechanism": "vote",
            "final_answer": final_answer,
            "confidence": 0.93,
            "quorum_reached": True,
            "round_count": 1,
            "mechanism_switches": 0,
            "merkle_root": merkle_root,
            "decision_hash": decision_hash,
            "transcript_hashes": transcript_hashes,
            "convergence_history": [],
            "locked_claims": [],
            "total_tokens_used": 24,
            "latency_ms": 12.0,
        },
    }

    async def fake_post(url: str, *_args: object, **_kwargs: object) -> _FakeResponse:
        if url == "/tasks/":
            create_payload = _kwargs.get("json")
            assert isinstance(create_payload, dict)
            assert create_payload.get("task") == "Should I buy Solana or BTC?"
            assert create_payload.get("agent_count") == 3
            assert create_payload.get("stakes") == 0.0
            assert create_payload.get("mechanism_override") == "vote"
            return _FakeResponse({"task_id": "task-hosted-verify"})
        if url == "/tasks/task-hosted-verify/run":
            return _FakeResponse({"ok": True})
        raise AssertionError(f"Unexpected POST url: {url}")

    async def fake_get(url: str, *_args: object, **_kwargs: object) -> _FakeResponse:
        if url != "/tasks/task-hosted-verify":
            raise AssertionError(f"Unexpected GET url: {url}")
        return _FakeResponse(status_payload)

    monkeypatch.setattr(arbitrator._client, "post", fake_post)
    monkeypatch.setattr(arbitrator._client, "get", fake_get)

    result = await arbitrator.arbitrate("Should I buy Solana or BTC?")
    verification = await arbitrator.verify_receipt(result)
    await arbitrator.aclose()

    assert verification["valid"] is True
    assert verification["merkle_match"] is True
    assert verification["hosted_metadata_match"] is True
    assert verification["on_chain_match"] is None


@pytest.mark.asyncio
async def test_agora_node_passes_strict_and_wallet_config() -> None:
    node = AgoraNode(
        mechanism="vote",
        agent_count=3,
        solana_wallet="wallet-test",
        strict_verification=False,
    )
    try:
        assert node.arbitrator.config.strict_verification is False
        assert node.arbitrator.config.solana_wallet == "wallet-test"
    finally:
        await node.arbitrator.aclose()


@pytest.mark.asyncio
async def test_agora_node_lenient_verification_allows_missing_task_mapping() -> None:
    async def unanimous_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt, user_prompt
        return {
            "answer": "BTC",
            "confidence": 0.93,
            "predicted_group_answer": "BTC",
            "reasoning": "Deterministic vote.",
        }

    node = AgoraNode(
        mechanism="vote",
        agent_count=3,
        solana_wallet="wallet-test",
        strict_verification=False,
    )
    try:
        result = await node.arbitrator.arbitrate(
            "Should I buy Solana or BTC?",
            agents=[unanimous_agent, unanimous_agent, unanimous_agent],
        )
        verification = await node.arbitrator.verify_receipt(result)
    finally:
        await node.arbitrator.aclose()

    assert verification["valid"] is True
    assert verification["on_chain_match"] is None


@pytest.mark.asyncio
async def test_agora_node_strict_verification_raises_without_task_mapping() -> None:
    async def unanimous_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt, user_prompt
        return {
            "answer": "BTC",
            "confidence": 0.93,
            "predicted_group_answer": "BTC",
            "reasoning": "Deterministic vote.",
        }

    node = AgoraNode(
        mechanism="vote",
        agent_count=3,
        solana_wallet="wallet-test",
    )
    try:
        result = await node.arbitrator.arbitrate(
            "Should I buy Solana or BTC?",
            agents=[unanimous_agent, unanimous_agent, unanimous_agent],
        )
        with pytest.raises(ReceiptVerificationError):
            await node.arbitrator.verify_receipt(result)
    finally:
        await node.arbitrator.aclose()
