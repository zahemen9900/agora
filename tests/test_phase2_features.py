from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from agora.runtime.hasher import TranscriptHasher
from agora.runtime.orchestrator import AgoraOrchestrator
from agora.sdk import AgoraArbitrator, AgoraNode, ReceiptVerificationError
from api.auth import AuthenticatedUser
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


def _assert_normalized_selector_summary(
    payload: dict[str, Any],
    *,
    mode_accuracy: float,
    reasoning_accuracy: float,
) -> None:
    summary = payload["summary"]

    assert summary["per_mode"]["selector"]["accuracy"] == pytest.approx(mode_accuracy)
    assert summary["per_mode"]["debate"]["accuracy"] == pytest.approx(0.0)
    assert summary["per_mode"]["vote"]["accuracy"] == pytest.approx(0.0)
    assert summary["per_category"]["reasoning"]["selector"]["accuracy"] == pytest.approx(
        reasoning_accuracy
    )
    assert "math" in summary["per_category"]
    assert "demo" in summary["per_category"]


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
        _assert_normalized_selector_summary(
            response.json(),
            mode_accuracy=0.8,
            reasoning_accuracy=0.75,
        )
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
async def test_benchmarks_route_allows_human_bearer_without_admin_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "benchmarks-human-auth"))
    task_routes._store = store
    summary = {
        "summary": {
            "per_mode": {"selector": {"accuracy": 0.91}},
            "per_category": {"reasoning": {"selector": {"accuracy": 0.81}}},
        }
    }

    async def fake_human_user(_credentials: object) -> AuthenticatedUser:
        return AuthenticatedUser(
            auth_method="jwt",
            workspace_id="user-1",
            user_id="user-1",
            email="user1@example.com",
            display_name="User One",
            scopes=["tasks:read"],
        )

    try:
        monkeypatch.setattr(benchmark_routes.settings, "benchmark_admin_token", "")
        monkeypatch.setattr(benchmark_routes, "get_current_user", fake_human_user)
        await store.save_benchmark_summary(summary)

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get(
                "/benchmarks",
                headers={"Authorization": "Bearer dummy"},
            )

        assert response.status_code == 200
        _assert_normalized_selector_summary(
            response.json(),
            mode_accuracy=0.91,
            reasoning_accuracy=0.81,
        )
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_benchmarks_route_rejects_api_key_principal_without_admin_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "benchmarks-api-key-auth"))
    task_routes._store = store
    summary = {
        "summary": {
            "per_mode": {"selector": {"accuracy": 0.5}},
            "per_category": {"math": {"selector": {"accuracy": 0.5}}},
        }
    }

    async def fake_api_key_user(_credentials: object) -> AuthenticatedUser:
        return AuthenticatedUser(
            auth_method="api_key",
            workspace_id="user-1",
            user_id=None,
            email="",
            display_name="API Key",
            scopes=["tasks:read"],
            api_key_id="key-1",
        )

    try:
        monkeypatch.setattr(benchmark_routes.settings, "benchmark_admin_token", "")
        monkeypatch.setattr(benchmark_routes, "get_current_user", fake_api_key_user)
        await store.save_benchmark_summary(summary)

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get(
                "/benchmarks",
                headers={"Authorization": "Bearer dummy"},
            )

        assert response.status_code == 403
        assert response.json()["detail"] == "Human authentication required"
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
async def test_benchmarks_route_promotes_stage_summary_from_file_fallback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "benchmarks-stage-summary"))
    original_results_path = benchmark_routes._RESULTS_PATH
    task_routes._store = store
    benchmark_routes._RESULTS_PATH = tmp_path / "phase2-validation-stage-summary.json"

    file_payload = {
        "summary": None,
        "post_learning": {
            "summary": {
                "per_mode": {"selector": {"accuracy": 0.2}},
                "per_category": {"math": {"selector": {"accuracy": 0.5}}},
            }
        },
        "metadata": {"source": "stage_summary_file"},
    }
    benchmark_routes._RESULTS_PATH.write_text(json.dumps(file_payload), encoding="utf-8")

    try:
        monkeypatch.setattr(benchmark_routes.settings, "benchmark_admin_token", "admin-token")
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get(
                "/benchmarks",
                headers={"x-agora-admin-token": "admin-token"},
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["metadata"]["source"] == "stage_summary_file"
        assert payload["summary"]["per_mode"]["selector"]["accuracy"] == pytest.approx(0.2)
        assert payload["summary"]["per_category"]["math"]["selector"]["accuracy"] == pytest.approx(
            0.5
        )
    finally:
        task_routes._store = None
        benchmark_routes._RESULTS_PATH = original_results_path


@pytest.mark.asyncio
async def test_benchmarks_route_heals_missing_store_summary_from_global_artifact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "benchmarks-artifact-heal"))
    task_routes._store = store

    artifact_payload = {
        "summary": None,
        "post_learning": {
            "summary": {
                "per_mode": {"selector": {"accuracy": 0.73}},
                "per_category": {"reasoning": {"selector": {"accuracy": 0.61}}},
            }
        },
    }
    artifact = {
        "artifact_id": "local-stage-summary",
        "scope": "global",
        "source": "local_backfill",
        "status": "completed",
        "benchmark_payload": artifact_payload,
    }

    try:
        monkeypatch.setattr(benchmark_routes.settings, "benchmark_admin_token", "admin-token")
        await store.save_global_benchmark_artifact("local-stage-summary", artifact)

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get(
                "/benchmarks",
                headers={"x-agora-admin-token": "admin-token"},
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["summary"]["per_mode"]["selector"]["accuracy"] == pytest.approx(0.73)
        assert (
            payload["summary"]["per_category"]["reasoning"]["selector"]["accuracy"]
            == pytest.approx(0.61)
        )

        healed_summary = await store.get_benchmark_summary()
        assert healed_summary is not None
        assert healed_summary["summary"]["per_mode"]["selector"]["accuracy"] == pytest.approx(0.73)
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_benchmarks_route_include_demo_keeps_stage_runs_without_synthesized_top_level(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "benchmarks-include-demo-stage-runs"))
    original_results_dir = benchmark_routes._RESULTS_DIR
    task_routes._store = store
    benchmark_routes._RESULTS_DIR = tmp_path

    summary = {
        "post_learning": {
            "runs": [
                {
                    "task": "Stage run task",
                    "mode": "debate",
                    "latency_ms": 12,
                    "merkle_root": "stage-root",
                }
            ],
            "summary": {
                "per_mode": {"selector": {"accuracy": 0.7}},
                "per_category": {"reasoning": {"selector": {"accuracy": 0.7}}},
            },
        }
    }

    demo_payload = {
        "target": "local",
        "query": "Demo query",
        "mechanism": "vote",
        "sdk_flow": {
            "status_after_run": {
                "task_id": "demo-task",
                "task_text": "Demo query",
                "mechanism": "vote",
                "merkle_root": "demo-root",
            },
            "run_result": {
                "mechanism": "vote",
                "latency_ms": 44,
                "merkle_root": "demo-root",
            },
        },
    }

    try:
        monkeypatch.setattr(benchmark_routes.settings, "benchmark_admin_token", "admin-token")
        await store.save_benchmark_summary(summary)
        (tmp_path / "phase2_demo_local_2026-04-17.json").write_text(
            json.dumps(demo_payload),
            encoding="utf-8",
        )

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get(
                "/benchmarks?include_demo=true",
                headers={"x-agora-admin-token": "admin-token"},
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["post_learning"]["runs"][0]["task"] == "Stage run task"
        assert payload["demo_report"]["artifact"] == "phase2_demo_local_2026-04-17.json"
        assert "runs" not in payload
    finally:
        task_routes._store = None
        benchmark_routes._RESULTS_DIR = original_results_dir


@pytest.mark.asyncio
async def test_benchmarks_route_include_demo_synthesizes_top_level_run_when_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "benchmarks-include-demo-synthesized"))
    original_results_dir = benchmark_routes._RESULTS_DIR
    task_routes._store = store
    benchmark_routes._RESULTS_DIR = tmp_path

    summary = {
        "summary": {
            "per_mode": {"selector": {"accuracy": 0.51}},
            "per_category": {"math": {"selector": {"accuracy": 0.49}}},
        }
    }

    demo_payload = {
        "target": "local",
        "query": "Synthesized run query",
        "mechanism": "vote",
        "final_status": "completed",
        "sdk_flow": {
            "status_after_run": {
                "task_id": "demo-task-2",
                "task_text": "Synthesized run query",
                "mechanism": "vote",
                "merkle_root": "demo-root-2",
                "status": "completed",
            },
            "status_after_pay": {
                "status": "completed",
            },
            "run_result": {
                "mechanism": "vote",
                "latency_ms": 87,
                "merkle_root": "demo-root-2",
                "confidence": 0.91,
                "final_answer": "AGORA_DEMO_OK",
            },
        },
        "tx_summary": {
            "receipt_explorer_url": "https://explorer.solana.com/tx/example",
        },
    }

    try:
        monkeypatch.setattr(benchmark_routes.settings, "benchmark_admin_token", "admin-token")
        await store.save_benchmark_summary(summary)
        (tmp_path / "phase2_demo_local_2026-04-17.json").write_text(
            json.dumps(demo_payload),
            encoding="utf-8",
        )

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get(
                "/benchmarks?include_demo=true",
                headers={"x-agora-admin-token": "admin-token"},
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["demo_report"]["artifact"] == "phase2_demo_local_2026-04-17.json"
        assert payload["runs"][0]["task"] == "Synthesized run query"
        assert payload["runs"][0]["mode"] == "vote"
        assert payload["runs"][0]["task_id"] == "demo-task-2"
    finally:
        task_routes._store = None
        benchmark_routes._RESULTS_DIR = original_results_dir


@pytest.mark.asyncio
async def test_phase2_validation_reruns_are_deterministic_offline(tmp_path: Path) -> None:
    async def deterministic_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt, user_prompt
        return {
            "answer": "Constraint-matching answer",
            "confidence": 0.84,
            "predicted_group_answer": "Constraint-matching answer",
            "reasoning": "Deterministic test agent.",
            "claim": "The answer follows the explicit benchmark constraint.",
            "evidence": "The benchmark prompt states the decisive constraint directly.",
            "defense": "The critique does not break the explicit benchmark constraint.",
            "final_answer": "Constraint-matching answer",
            "summary": "The deterministic local agent selected the constraint-matching answer.",
            "analyses": [
                {
                    "faction": "pro",
                    "weakest_claim": "benchmark pro claim",
                    "flaw": "Needs explicit constraint support.",
                    "attack_axis": "constraint_fit",
                    "counterexample": "A candidate satisfying more prompt constraints.",
                    "failure_mode": "The claim is plausible but insufficiently grounded.",
                    "question": "Which prompt constraint makes the pro claim decisive?",
                },
                {
                    "faction": "opp",
                    "weakest_claim": "benchmark opp claim",
                    "flaw": "Relies on an unstated assumption.",
                    "attack_axis": "hidden_assumption",
                    "counterexample": "A boundary condition where the assumption fails.",
                    "failure_mode": "The claim wins only if the hidden assumption holds.",
                    "question": "Which assumption must hold for the opp claim to win?",
                },
            ],
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
        answer = f"Changing candidate {call_counter['value']}"
        return {
            "answer": answer,
            "confidence": 0.55,
            "predicted_group_answer": answer,
            "reasoning": "Intentional non-deterministic test agent.",
            "claim": answer,
            "evidence": "Intentional non-deterministic evidence.",
            "defense": "Intentional non-deterministic defense.",
            "final_answer": answer,
            "summary": "Intentional non-deterministic synthesis.",
            "analyses": [
                {
                    "faction": "pro",
                    "weakest_claim": answer,
                    "flaw": "Intentional drift.",
                    "attack_axis": "determinism",
                    "counterexample": "A repeat run with different content.",
                    "failure_mode": "Merkle root divergence.",
                    "question": "Does the repeated run produce the same transcript hash?",
                },
                {
                    "faction": "opp",
                    "weakest_claim": answer,
                    "flaw": "Intentional drift.",
                    "attack_axis": "determinism",
                    "counterexample": "A repeat run with different content.",
                    "failure_mode": "Merkle root divergence.",
                    "question": "Does the repeated run produce the same transcript hash?",
                },
            ],
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


@pytest.mark.asyncio
async def test_sdk_hosted_lifecycle_helpers_cover_create_run_status_and_pay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arbitrator = AgoraArbitrator(
        api_url="https://example.invalid",
        auth_token="agora_test_public.secret",
        mechanism="vote",
        agent_count=4,
        strict_verification=False,
    )
    status_payload: dict[str, Any] = {
        "task_id": "task-phase2-demo",
        "task_text": "Should we use vote for the phase 2 demo?",
        "mechanism": "vote",
        "status": "completed",
        "selector_reasoning": "Pinned for strict demo stability.",
        "selector_reasoning_hash": "selector-hash",
        "selector_confidence": 1.0,
        "merkle_root": "root-123",
        "decision_hash": "decision-123",
        "solana_tx_hash": "receipt-tx",
        "payment_amount": 0.01,
        "payment_status": "locked",
        "result": {
            "task_id": "task-phase2-demo",
            "mechanism": "vote",
            "final_answer": "Yes",
            "confidence": 0.95,
            "quorum_reached": True,
            "round_count": 1,
            "mechanism_switches": 0,
            "merkle_root": "root-123",
            "decision_hash": "decision-123",
            "transcript_hashes": ["leaf-1", "leaf-2"],
            "agent_models_used": [
                "gemini-3-flash-preview",
                "moonshotai/kimi-k2-thinking",
                "gemini-3.1-flash-lite-preview",
                "claude-sonnet-4-6",
            ],
            "convergence_history": [],
            "locked_claims": [],
            "total_tokens_used": 88,
            "latency_ms": 20.0,
        },
    }
    seen_calls: list[tuple[str, str, dict[str, Any]]] = []

    async def fake_post(url: str, *_args: object, **kwargs: object) -> _FakeResponse:
        seen_calls.append(("POST", url, dict(kwargs)))
        if url == "/tasks/":
            return _FakeResponse(
                {
                    "task_id": "task-phase2-demo",
                    "mechanism": "vote",
                    "confidence": 1.0,
                    "reasoning": "Pinned for strict demo stability.",
                    "selector_reasoning_hash": "selector-hash",
                    "status": "pending",
                }
            )
        if url == "/tasks/task-phase2-demo/run":
            return _FakeResponse(status_payload["result"])
        if url == "/tasks/task-phase2-demo/pay":
            return _FakeResponse({"released": True, "tx_hash": "pay-tx"})
        raise AssertionError(f"Unexpected POST url: {url}")

    async def fake_get(url: str, *_args: object, **kwargs: object) -> _FakeResponse:
        seen_calls.append(("GET", url, dict(kwargs)))
        if url == "/tasks/task-phase2-demo":
            return _FakeResponse(status_payload)
        raise AssertionError(f"Unexpected GET url: {url}")

    monkeypatch.setattr(arbitrator._client, "post", fake_post)
    monkeypatch.setattr(arbitrator._client, "get", fake_get)

    created = await arbitrator.create_task(
        "Should we use vote for the phase 2 demo?",
        stakes=0.01,
    )
    run = await arbitrator.run_task("task-phase2-demo")
    status = await arbitrator.get_task_status("task-phase2-demo", detailed=True)
    payment = await arbitrator.release_payment("task-phase2-demo")
    await arbitrator.aclose()

    assert created.task_id == "task-phase2-demo"
    assert run.final_answer == "Yes"
    assert status.result is not None
    assert status.result.agent_models_used[-1] == "claude-sonnet-4-6"
    assert payment.released is True
    assert payment.tx_hash == "pay-tx"
    assert arbitrator.latest_task_id == "task-phase2-demo"
    assert seen_calls[0][2]["headers"] == {
        "Authorization": "Bearer agora_test_public.secret",
    }
    assert seen_calls[0][2]["json"] == {
        "task": "Should we use vote for the phase 2 demo?",
        "agent_count": 4,
        "stakes": 0.01,
        "mechanism_override": "vote",
        "allow_mechanism_switch": True,
        "allow_offline_fallback": False,
        "quorum_threshold": 0.6,
    }
    assert seen_calls[2][2]["params"] == {"detailed": "true"}


@pytest.mark.asyncio
async def test_sdk_get_task_result_tracks_task_id_mapping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arbitrator = AgoraArbitrator(
        api_url="https://example.invalid",
        auth_token="agora_test_public.secret",
        strict_verification=False,
    )
    hasher = TranscriptHasher()
    transcript_hashes = [
        hasher.hash_content("agent-1: Paris"),
        hasher.hash_content("agent-2: Paris"),
        hasher.hash_content("agent-3: Paris"),
        hasher.hash_content("agent-4: Paris"),
    ]
    merkle_root = hasher.build_merkle_tree(transcript_hashes)
    decision_hash = hasher.hash_content("Paris")
    status_payload: dict[str, Any] = {
        "task_id": "task-mapped",
        "task_text": "What is the capital of France?",
        "mechanism": "vote",
        "status": "completed",
        "selector_reasoning": "Low disagreement, use vote.",
        "selector_reasoning_hash": "selector-hash",
        "selector_confidence": 0.97,
        "merkle_root": merkle_root,
        "decision_hash": decision_hash,
        "solana_tx_hash": "receipt-tx",
        "payment_amount": 0.01,
        "payment_status": "locked",
        "result": {
            "task_id": "task-mapped",
            "mechanism": "vote",
            "final_answer": "Paris",
            "confidence": 0.97,
            "quorum_reached": True,
            "round_count": 1,
            "mechanism_switches": 0,
            "merkle_root": merkle_root,
            "decision_hash": decision_hash,
            "transcript_hashes": transcript_hashes,
            "agent_models_used": [],
            "convergence_history": [],
            "locked_claims": [],
            "total_tokens_used": 32,
            "latency_ms": 10.0,
        },
    }

    async def fake_get(url: str, *_args: object, **_kwargs: object) -> _FakeResponse:
        if url != "/tasks/task-mapped":
            raise AssertionError(f"Unexpected GET url: {url}")
        return _FakeResponse(status_payload)

    monkeypatch.setattr(arbitrator._client, "get", fake_get)

    result = await arbitrator.get_task_result("task-mapped")
    await arbitrator.aclose()

    assert result.final_answer == "Paris"
    assert arbitrator.latest_task_id == "task-mapped"
    assert arbitrator.task_id_for_result(result) == "task-mapped"


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


@pytest.mark.asyncio
async def test_sdk_arbitrator_default_create_payload_uses_four_agents(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arbitrator = AgoraArbitrator(mechanism="vote", strict_verification=False)

    async def fake_post(url: str, *_args: object, **kwargs: object) -> _FakeResponse:
        assert url == "/tasks/"
        payload = kwargs.get("json")
        assert isinstance(payload, dict)
        assert payload["agent_count"] == 4
        return _FakeResponse({"task_id": "task-default-four", "mechanism": "vote"})

    monkeypatch.setattr(arbitrator._client, "post", fake_post)

    try:
        created = await arbitrator.create_task("default agent count")
    finally:
        await arbitrator.aclose()

    assert created.task_id == "task-default-four"
    assert arbitrator.config.agent_count == 4


@pytest.mark.asyncio
async def test_agora_node_default_uses_four_agents() -> None:
    node = AgoraNode()
    try:
        assert node.arbitrator.config.agent_count == 4
    finally:
        await node.aclose()


@pytest.mark.asyncio
async def test_agora_node_aclose_closes_wrapped_client() -> None:
    node = AgoraNode()
    await node.aclose()

    assert node.arbitrator._client.is_closed


@pytest.mark.asyncio
async def test_agora_node_async_context_closes_on_exit() -> None:
    async with AgoraNode() as node:
        client = node.arbitrator._client
        assert client.is_closed is False

    assert client.is_closed is True


@pytest.mark.asyncio
async def test_sdk_get_task_status_parses_chain_operations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arbitrator = AgoraArbitrator(strict_verification=False)

    async def fake_get(url: str, *_args: object, **kwargs: object) -> _FakeResponse:
        assert url == "/tasks/task-chain-status"
        params = kwargs.get("params")
        assert params == {"detailed": "true"}
        return _FakeResponse(
            {
                "task_id": "task-chain-status",
                "task_text": "Check chain status typing",
                "workspace_id": "ws-test",
                "created_by": "sdk-test",
                "mechanism": "debate",
                "status": "completed",
                "selector_reasoning": "debate wins",
                "selector_reasoning_hash": "a" * 64,
                "selector_confidence": 0.91,
                "agent_count": 4,
                "chain_operations": {
                    "initialize_task": {
                        "status": "succeeded",
                        "tx_hash": "sig-123",
                        "explorer_url": "https://explorer.solana.com/tx/sig-123?cluster=devnet",
                        "attempts": 2,
                        "updated_at": "2026-04-18T06:30:00Z",
                    }
                },
                "events": [],
            }
        )

    monkeypatch.setattr(arbitrator._client, "get", fake_get)

    try:
        status = await arbitrator.get_task_status("task-chain-status", detailed=True)
    finally:
        await arbitrator.aclose()

    operation = status.chain_operations["initialize_task"]
    assert operation.status == "succeeded"
    assert operation.tx_hash == "sig-123"
    assert operation.attempts == 2
    assert isinstance(operation.updated_at, datetime)


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
async def test_sdk_verify_receipt_strict_hosted_payload_requires_rpc_url(
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
    with pytest.raises(ReceiptVerificationError, match="requires rpc_url"):
        await arbitrator.verify_receipt(result)
    await arbitrator.aclose()


@pytest.mark.asyncio
async def test_sdk_verify_receipt_strict_succeeds_with_onchain_match(
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
        rpc_url="http://localhost:8899",
    )
    result = await arbitrator.arbitrate(
        "Should I buy Solana or BTC?",
        agents=[unanimous_agent, unanimous_agent, unanimous_agent],
    )
    arbitrator._result_task_ids[result.merkle_root] = "task-verify-onchain"

    decision_hash = TranscriptHasher().hash_content(result.final_answer)
    payload: dict[str, Any] = {
        "task_id": "task-verify-onchain",
        "task_text": "Should I buy Solana or BTC?",
        "mechanism": "vote",
        "status": "completed",
        "selector_reasoning": result.mechanism_selection.reasoning,
        "selector_reasoning_hash": result.mechanism_selection.reasoning_hash,
        "selector_confidence": result.mechanism_selection.confidence,
        "merkle_root": result.merkle_root,
        "decision_hash": decision_hash,
        "solana_tx_hash": "tx-123",
        "payment_amount": 0.0,
        "payment_status": "none",
        "events": [],
        "result": {
            "task_id": "task-verify-onchain",
            "mechanism": "vote",
            "final_answer": result.final_answer,
            "confidence": result.confidence,
            "quorum_reached": result.quorum_reached,
            "round_count": result.round_count,
            "mechanism_switches": result.mechanism_switches,
            "merkle_root": result.merkle_root,
            "decision_hash": decision_hash,
            "transcript_hashes": result.transcript_hashes,
            "convergence_history": [],
            "locked_claims": [],
            "total_tokens_used": result.total_tokens_used,
            "latency_ms": result.total_latency_ms,
        },
    }

    async def fake_get(*_args: object, **_kwargs: object) -> _FakeResponse:
        return _FakeResponse(payload)

    async def fake_verify_onchain_receipt(*_args: object, **_kwargs: object) -> bool:
        return True

    monkeypatch.setattr(arbitrator._client, "get", fake_get)
    monkeypatch.setattr(arbitrator, "_verify_onchain_receipt", fake_verify_onchain_receipt)

    verification = await arbitrator.verify_receipt(result)
    await arbitrator.aclose()

    assert verification["valid"] is True
    assert verification["hosted_metadata_match"] is True
    assert verification["on_chain_match"] is True


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
async def test_agora_node_passes_phase2_control_config() -> None:
    node = AgoraNode(
        mechanism="vote",
        agent_count=3,
        allow_mechanism_switch=False,
        allow_offline_fallback=True,
        quorum_threshold=0.75,
    )
    try:
        assert node.arbitrator.config.allow_mechanism_switch is False
        assert node.arbitrator.config.allow_offline_fallback is True
        assert node.arbitrator.config.quorum_threshold == 0.75
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
