from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from agora.agent import AgentCallError
from agora.runtime.hasher import TranscriptHasher
from agora.runtime.orchestrator import AgoraOrchestrator
from agora.sdk import AgoraArbitrator, AgoraNode, ReceiptVerificationError
from agora.sdk.config import CANONICAL_HOSTED_API_URL, resolve_hosted_api_url
from api.auth import AuthenticatedUser
from api.main import app
from api.routes import benchmarks as benchmark_routes
from api.routes import tasks as task_routes
from api.store_local import LocalTaskStore
from benchmarks.runner import BenchmarkRunner
from agora.types import DeliberationResult, MechanismType
from tests.helpers import make_selection


def _override_user() -> AuthenticatedUser:
    return AuthenticatedUser(
        auth_method="jwt",
        workspace_id="user-1",
        user_id="user-1",
        email="user1@example.com",
        display_name="User One",
        scopes=["tasks:read", "tasks:write"],
    )


def test_benchmark_runner_loads_curated_dataset() -> None:
    dataset = BenchmarkRunner.load_dataset("math")
    dataset_by_spec_name = BenchmarkRunner.load_dataset("math_tasks")
    demo_dataset = BenchmarkRunner.load_dataset("demo")

    assert len(dataset) == 20
    assert dataset == dataset_by_spec_name
    assert {item["category"] for item in dataset} == {"math"}
    assert all("task" in item for item in dataset)
    assert all("source" in item for item in dataset)
    assert len(demo_dataset) == 20
    assert {item["category"] for item in demo_dataset} == {"demo"}
    assert all("?" in item["task"] for item in demo_dataset)


def test_benchmark_runner_builds_default_phase2_split() -> None:
    training, holdout = BenchmarkRunner.build_phase2_task_split()

    assert len(training) == 36
    assert len(holdout) == 12
    assert {item["category"] for item in training} == {
        "math",
        "factual",
        "reasoning",
        "code",
        "creative",
        "demo",
    }
    assert {item["category"] for item in holdout} == {
        "math",
        "factual",
        "reasoning",
        "code",
        "creative",
        "demo",
    }

def _assert_normalized_selector_summary(
    payload: dict[str, Any],
    *,
    mode_accuracy: float,
    reasoning_accuracy: float,
) -> None:
    summary = payload["summary"]

    assert summary["per_mode"]["selector"]["accuracy"] == pytest.approx(mode_accuracy)
    assert summary["per_mechanism"]["selector"]["accuracy"] == pytest.approx(mode_accuracy)
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
        "generated_at": "2026-04-21T00:00:00+00:00",
        "artifact_version": "benchmark-tasklike-v2",
        "benchmark_config": {
            "agent_count": 4,
            "training_per_category": 1,
            "holdout_per_category": 1,
        },
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
        "source": "user_triggered",
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
async def test_benchmarks_route_heal_skips_legacy_global_artifact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "benchmarks-artifact-heal-skip-legacy"))
    task_routes._store = store

    legacy_artifact = {
        "artifact_id": "legacy-phase2-validation",
        "scope": "global",
        "source": "legacy_backfill",
        "status": "completed",
        "benchmark_payload": {
            "generated_at": "2026-04-17T00:00:00+00:00",
            "summary": {
                "per_mode": {"selector": {"accuracy": 0.11}},
                "per_category": {"reasoning": {"selector": {"accuracy": 0.22}}},
            },
        },
    }
    current_artifact = {
        "artifact_id": "current-tasklike-benchmark",
        "scope": "global",
        "source": "user_triggered",
        "status": "completed",
        "benchmark_payload": {
            "generated_at": "2026-04-21T00:00:00+00:00",
            "artifact_version": "benchmark-tasklike-v2",
            "benchmark_config": {
                "agent_count": 4,
                "training_per_category": 1,
                "holdout_per_category": 1,
            },
            "summary": {
                "per_mode": {"selector": {"accuracy": 0.73}},
                "per_category": {"reasoning": {"selector": {"accuracy": 0.61}}},
            },
        },
    }

    try:
        monkeypatch.setattr(benchmark_routes.settings, "benchmark_admin_token", "admin-token")
        await store.save_global_benchmark_artifact("legacy-phase2-validation", legacy_artifact)
        await store.save_global_benchmark_artifact("current-tasklike-benchmark", current_artifact)

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
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_benchmark_catalog_hides_legacy_backfill_artifacts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "benchmark-catalog-hides-legacy"))
    task_routes._store = store

    legacy_artifact = {
        "artifact_id": "legacy-phase2-validation",
        "scope": "global",
        "source": "legacy_backfill",
        "status": "completed",
        "benchmark_payload": {
            "generated_at": "2026-04-17T00:00:00+00:00",
            "summary": {
                "per_mode": {"selector": {"accuracy": 0.11}},
                "per_category": {"reasoning": {"selector": {"accuracy": 0.22}}},
            },
        },
    }
    current_artifact = {
        "artifact_id": "current-tasklike-benchmark",
        "scope": "global",
        "source": "user_triggered",
        "status": "completed",
        "benchmark_payload": {
            "generated_at": "2026-04-21T00:00:00+00:00",
            "artifact_version": "benchmark-tasklike-v2",
            "benchmark_config": {
                "agent_count": 4,
                "training_per_category": 1,
                "holdout_per_category": 1,
            },
            "summary": {
                "per_mode": {"selector": {"accuracy": 0.73}},
                "per_category": {"reasoning": {"selector": {"accuracy": 0.61}}},
            },
        },
    }

    try:
        monkeypatch.setattr(benchmark_routes.settings, "benchmark_admin_token", "")
        app.dependency_overrides[benchmark_routes.get_current_user] = _override_user
        await store.save_global_benchmark_artifact("legacy-phase2-validation", legacy_artifact)
        await store.save_global_benchmark_artifact("current-tasklike-benchmark", current_artifact)

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get(
                "/benchmarks/catalog",
                headers={"Authorization": "Bearer dummy"},
            )

        assert response.status_code == 200
        payload = response.json()
        artifact_ids = [entry["artifact_id"] for entry in payload["global_recent"]]
        assert "current-tasklike-benchmark" in artifact_ids
        assert "legacy-phase2-validation" not in artifact_ids
    finally:
        app.dependency_overrides.pop(benchmark_routes.get_current_user, None)
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
        assert "demo" in payload["summary"]["per_category"]
        assert "vote" in payload["summary"]["per_mechanism"]
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
        assert "demo" in payload["summary"]["per_category"]
        assert "vote" in payload["summary"]["per_mechanism"]
    finally:
        task_routes._store = None
        benchmark_routes._RESULTS_DIR = original_results_dir


@pytest.mark.asyncio
async def test_phase2_validation_reruns_are_deterministic_offline(tmp_path: Path) -> None:
    class _FailingSelectorCaller:
        async def call(self, *args: object, **kwargs: object) -> tuple[object, dict[str, object]]:
            del args, kwargs
            raise AgentCallError("selector provider unavailable")

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
    training = [task for task in training if task["category"] != "demo"]
    holdout = [task for task in holdout if task["category"] != "demo"]
    orchestrator = AgoraOrchestrator(agent_count=3)
    orchestrator.selector.reasoning._caller = _FailingSelectorCaller()
    runner = BenchmarkRunner(orchestrator, agents=[deterministic_agent] * 3)

    payload = await runner.run_phase2_validation(
        training_tasks=training,
        holdout_tasks=holdout,
        output_path=str(tmp_path / "phase2_validation_test.json"),
        seed=7,
    )

    assert payload["pre_learning"]["runs"]
    assert all(run["merkle_deterministic"] is True for run in payload["pre_learning"]["runs"])
    sample_run = payload["pre_learning"]["runs"][0]
    assert "execution_mode" in sample_run
    assert "selector_source" in sample_run
    assert "mechanism_override_source" in sample_run
    assert "convergence_history" in sample_run
    assert "mechanism_trace" in sample_run
    assert "transcript_hash_count" in sample_run
    assert "model_token_usage" in sample_run
    assert "model_telemetry" in sample_run
    assert "input_tokens_used" in sample_run
    assert "output_tokens_used" in sample_run
    assert "thinking_tokens_used" in sample_run
    assert "cost" in sample_run


@pytest.mark.asyncio
async def test_phase2_validation_continues_after_failed_item(tmp_path: Path) -> None:
    class _FailingSelectorCaller:
        async def call(self, *args: object, **kwargs: object) -> tuple[object, dict[str, object]]:
            del args, kwargs
            raise AgentCallError("selector provider unavailable")

    async def mixed_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
        del system_prompt
        if "FAIL BENCHMARK ITEM" in user_prompt:
            raise RuntimeError("provider_kimi_unavailable_or_invalid")
        return {
            "answer": "Constraint-matching answer",
            "confidence": 0.81,
            "predicted_group_answer": "Constraint-matching answer",
            "reasoning": "Deterministic success agent.",
            "claim": "The answer follows the prompt directly.",
            "evidence": "The prompt states the deciding condition clearly.",
            "defense": "The critique does not invalidate the direct answer.",
            "final_answer": "Constraint-matching answer",
            "summary": "The deterministic local agent selected the direct answer.",
            "analyses": [
                {
                    "faction": "pro",
                    "weakest_claim": "pro claim",
                    "flaw": "Needs explicit constraint support.",
                    "attack_axis": "constraint_fit",
                    "counterexample": "A stronger answer satisfying more constraints.",
                    "failure_mode": "The claim is plausible but under-grounded.",
                    "question": "Which prompt constraint makes the claim decisive?",
                },
                {
                    "faction": "opp",
                    "weakest_claim": "opp claim",
                    "flaw": "Relies on an unstated assumption.",
                    "attack_axis": "hidden_assumption",
                    "counterexample": "A boundary case where the assumption breaks.",
                    "failure_mode": "The claim fails when its hidden assumption is false.",
                    "question": "Which assumption must hold for the claim to win?",
                },
            ],
        }

    orchestrator = AgoraOrchestrator(agent_count=3, allow_offline_fallback=True)
    orchestrator.selector.reasoning._caller = _FailingSelectorCaller()
    runner = BenchmarkRunner(orchestrator, agents=[mixed_agent] * 3)

    payload = await runner.run_phase2_validation(
        training_tasks=[
            {
                "task": "FAIL BENCHMARK ITEM",
                "category": "reasoning",
                "ground_truth": "Constraint-matching answer",
                "stakes": 0.0,
            },
            {
                "task": "Safe benchmark item",
                "category": "math",
                "ground_truth": "Constraint-matching answer",
                "stakes": 0.0,
            },
        ],
        holdout_tasks=[
            {
                "task": "Safe holdout benchmark item",
                "category": "factual",
                "ground_truth": "Constraint-matching answer",
                "stakes": 0.0,
            }
        ],
        output_path=str(tmp_path / "phase2_validation_partial.json"),
    )

    pre_learning_runs = payload["pre_learning"]["runs"]
    learning_runs = payload["learning_updates"]["runs"]
    post_learning_runs = payload["post_learning"]["runs"]

    assert any(run["item_status"] == "failed" for run in pre_learning_runs)
    assert any(run["item_status"] == "completed" for run in pre_learning_runs + learning_runs + post_learning_runs)
    assert payload["pre_learning"]["summary"]["failed_run_count"] >= 1
    assert payload["post_learning"]["summary"]["completed_run_count"] >= 1
    assert payload["pre_learning"]["summary"]["failure_counts_by_reason"]
    assert all(
        "selector_source" in run and "selector_fallback_path" in run
        for run in pre_learning_runs + learning_runs + post_learning_runs
    )


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
async def test_phase2_validation_forwards_live_orchestrator_events_with_benchmark_context(
    tmp_path: Path,
) -> None:
    class _FakeBandit:
        @staticmethod
        def get_stats() -> dict[str, object]:
            return {"debate": {"alpha": 1.0, "beta": 1.0}}

    class _FakeSelector:
        bandit = _FakeBandit()

    def _result(task: str) -> DeliberationResult:
        return DeliberationResult(
            task=task,
            mechanism_used=MechanismType.DEBATE,
            mechanism_selection=make_selection(
                mechanism=MechanismType.DEBATE,
                topic_category="reasoning",
            ),
            final_answer="Hybrid answer",
            confidence=0.82,
            quorum_reached=True,
            round_count=2,
            agent_count=4,
            mechanism_switches=0,
            merkle_root="benchmark-root",
            transcript_hashes=["h1", "h2"],
            agent_models_used=["gemini-3-flash-preview", "claude-sonnet-4-6"],
            model_token_usage={"gemini-3-flash-preview": 11, "claude-sonnet-4-6": 9},
            model_input_token_usage={"gemini-3-flash-preview": 5, "claude-sonnet-4-6": 4},
            model_output_token_usage={"gemini-3-flash-preview": 6, "claude-sonnet-4-6": 5},
            total_tokens_used=20,
            total_latency_ms=25.0,
            timestamp=datetime.now(UTC),
        )

    class _FakeOrchestrator:
        selector = _FakeSelector()

        async def run(self, task: str, **kwargs: object) -> DeliberationResult:
            event_sink = kwargs.get("event_sink")
            if callable(event_sink):
                await event_sink(
                    "agent_output_delta",
                    {
                        "agent_id": "agent-1",
                        "agent_model": "gemini-3-flash-preview",
                        "role": "voter",
                        "content_delta": "live chunk",
                    },
                )
                await event_sink(
                    "usage_delta",
                    {
                        "agent_id": "agent-1",
                        "agent_model": "gemini-3-flash-preview",
                        "total_tokens": 11,
                    },
                )
            return _result(task)

        async def run_and_learn(self, task: str, **kwargs: object) -> DeliberationResult:
            return await self.run(task, **kwargs)

    runner = BenchmarkRunner(_FakeOrchestrator(), agents=None)
    captured_events: list[tuple[str, dict[str, object]]] = []

    async def event_sink(event_type: str, payload: dict[str, object]) -> None:
        captured_events.append((event_type, payload))

    await runner.run_phase2_validation(
        training_tasks=[
            {
                "task": "Should we deliberate or vote?",
                "category": "reasoning",
                "ground_truth": "Hybrid answer",
            }
        ],
        holdout_tasks=[],
        output_path=str(tmp_path / "phase2_validation_live_events.json"),
        seed=None,
        event_sink=event_sink,
    )

    forwarded = [event for event in captured_events if event[0] in {"agent_output_delta", "usage_delta"}]
    assert forwarded
    event_type, payload = forwarded[0]
    assert event_type == "agent_output_delta"
    assert payload["agent_id"] == "agent-1"
    benchmark_context = payload["benchmark_context"]
    assert isinstance(benchmark_context, dict)
    assert benchmark_context["phase"] == "pre_learning"
    assert benchmark_context["category"] == "reasoning"
    assert benchmark_context["task_index"] == 0
    assert benchmark_context["run_kind"] == "selector_initial"


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


@pytest.mark.asyncio
async def test_sdk_hosted_streaming_helpers_cover_start_and_task_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arbitrator = AgoraArbitrator(
        auth_token="agora_test_public.secret",
        mechanism="vote",
        agent_count=4,
        strict_verification=False,
    )
    seen_calls: list[tuple[str, str, dict[str, Any]]] = []

    async def fake_post(url: str, *_args: object, **kwargs: object) -> _FakeResponse:
        seen_calls.append(("POST", url, dict(kwargs)))
        if url == "/tasks/task-stream/run-async":
            return _FakeResponse(
                {
                    "task_id": "task-stream",
                    "task_text": "Stream this task",
                    "workspace_id": "user-1",
                    "created_by": "user-1",
                    "mechanism": "vote",
                    "status": "pending",
                    "selector_reasoning": "Vote is stable.",
                    "selector_reasoning_hash": "selector-hash",
                    "selector_confidence": 1.0,
                    "agent_count": 4,
                    "reasoning_presets": {
                        "gemini_pro": "high",
                        "gemini_flash": "high",
                        "kimi": "high",
                        "claude": "high",
                    },
                }
            )
        if url == "/tasks/task-stream/stream-ticket":
            return _FakeResponse({"ticket": "ticket-stream"})
        raise AssertionError(f"Unexpected POST url: {url}")

    class _FakeStreamResponse:
        def __init__(self, lines: list[str]) -> None:
            self._lines = lines

        def raise_for_status(self) -> None:
            return None

        async def aiter_lines(self):
            for line in self._lines:
                yield line

    class _FakeStreamContext:
        def __init__(self, lines: list[str]) -> None:
            self._response = _FakeStreamResponse(lines)

        async def __aenter__(self) -> _FakeStreamResponse:
            return self._response

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

    def fake_stream(method: str, url: str, *_args: object, **kwargs: object) -> _FakeStreamContext:
        seen_calls.append((method, url, dict(kwargs)))
        assert method == "GET"
        assert url == "/tasks/task-stream/stream"
        assert kwargs.get("params") == {"ticket": "ticket-stream"}
        return _FakeStreamContext(
            [
                "event: agent_output_delta",
                'data: {"payload": {"content": "hello", "role": "proponent"}, "timestamp": "2026-04-20T10:00:00Z"}',
                "",
                "event: complete",
                'data: {"payload": {"task_id": "task-stream", "status": "completed"}, "timestamp": "2026-04-20T10:01:00Z"}',
                "",
            ]
        )

    monkeypatch.setattr(arbitrator._client, "post", fake_post)
    monkeypatch.setattr(arbitrator._client, "stream", fake_stream)

    started = await arbitrator.start_task_run("task-stream")
    events = [event async for event in arbitrator.stream_task_events("task-stream")]
    await arbitrator.aclose()

    assert started.status == "pending"
    assert events == [
        {
            "event": "agent_output_delta",
            "data": {"content": "hello", "role": "proponent"},
            "timestamp": "2026-04-20T10:00:00Z",
        },
        {
            "event": "complete",
            "data": {"task_id": "task-stream", "status": "completed"},
            "timestamp": "2026-04-20T10:01:00Z",
        },
    ]
    assert arbitrator.latest_task_id == "task-stream"
    assert seen_calls[0][1] == "/tasks/task-stream/run-async"
    assert seen_calls[1][1] == "/tasks/task-stream/stream-ticket"


@pytest.mark.asyncio
async def test_sdk_benchmark_helpers_cover_run_wait_detail_and_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agora.sdk import HostedBenchmarkRunRequest

    arbitrator = AgoraArbitrator(
        auth_token="human-bearer-token",
        strict_verification=False,
    )
    seen_calls: list[tuple[str, str, dict[str, Any]]] = []
    status_payloads = [
        {
            "run_id": "run-sdk",
            "status": "running",
            "created_at": "2026-04-21T04:00:00Z",
            "updated_at": "2026-04-21T04:00:01Z",
        },
        {
            "run_id": "run-sdk",
            "status": "completed",
            "created_at": "2026-04-21T04:00:00Z",
            "updated_at": "2026-04-21T04:00:02Z",
            "artifact_id": "artifact-sdk",
            "latest_mechanism": "selector",
            "agent_count": 2,
            "total_tokens": 48,
        },
    ]
    status_index = {"value": 0}

    async def fake_post(url: str, *_args: object, **kwargs: object) -> _FakeResponse:
        seen_calls.append(("POST", url, dict(kwargs)))
        if url == "/benchmarks/run":
            return _FakeResponse(
                {
                    "run_id": "run-sdk",
                    "status": "queued",
                    "created_at": "2026-04-21T04:00:00Z",
                }
            )
        if url == "/benchmarks/runs/run-sdk/stream-ticket":
            return _FakeResponse({"ticket": "ticket-benchmark"})
        raise AssertionError(f"Unexpected POST url: {url}")

    async def fake_get(url: str, *_args: object, **kwargs: object) -> _FakeResponse:
        seen_calls.append(("GET", url, dict(kwargs)))
        if url == "/benchmarks/runs/run-sdk":
            payload = status_payloads[min(status_index["value"], len(status_payloads) - 1)]
            status_index["value"] += 1
            return _FakeResponse(payload)
        if url == "/benchmarks/run-sdk":
            return _FakeResponse(
                {
                    "benchmark_id": "run-sdk",
                    "artifact_id": "artifact-sdk",
                    "run_id": "run-sdk",
                    "scope": "user",
                    "source": "user_test",
                    "status": "completed",
                    "created_at": "2026-04-21T04:00:00Z",
                    "updated_at": "2026-04-21T04:00:02Z",
                    "run_count": 1,
                    "latest_mechanism": "selector",
                    "agent_count": 2,
                    "total_tokens": 48,
                    "thinking_tokens": 0,
                    "total_latency_ms": 15.0,
                    "models": ["gemini-3-flash-preview"],
                    "model_telemetry": {
                        "gemini-3-flash-preview": {
                            "total_tokens": 48,
                            "input_tokens": 20,
                            "output_tokens": 28,
                            "thinking_tokens": 0,
                            "latency_ms": 15.0,
                        }
                    },
                    "events": [],
                    "summary": {"accuracy": 1.0},
                    "benchmark_payload": {"benchmark_config": {"agent_count": 2}},
                }
            )
        raise AssertionError(f"Unexpected GET url: {url}")

    class _FakeStreamResponse:
        def __init__(self, lines: list[str]) -> None:
            self._lines = lines

        def raise_for_status(self) -> None:
            return None

        async def aiter_lines(self):
            for line in self._lines:
                yield line

    class _FakeStreamContext:
        def __init__(self, lines: list[str]) -> None:
            self._response = _FakeStreamResponse(lines)

        async def __aenter__(self) -> _FakeStreamResponse:
            return self._response

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

    def fake_stream(method: str, url: str, *_args: object, **kwargs: object) -> _FakeStreamContext:
        seen_calls.append((method, url, dict(kwargs)))
        assert method == "GET"
        assert url == "/benchmarks/runs/run-sdk/stream"
        assert kwargs.get("params") == {"ticket": "ticket-benchmark"}
        return _FakeStreamContext(
            [
                "event: running",
                'data: {"payload": {"run_id": "run-sdk", "status": "running"}, "timestamp": "2026-04-21T04:00:01Z"}',
                "",
                "event: complete",
                'data: {"payload": {"run_id": "run-sdk", "status": "completed", "artifact_id": "artifact-sdk"}, "timestamp": "2026-04-21T04:00:02Z"}',
                "",
            ]
        )

    monkeypatch.setattr(arbitrator._client, "post", fake_post)
    monkeypatch.setattr(arbitrator._client, "get", fake_get)
    monkeypatch.setattr(arbitrator._client, "stream", fake_stream)

    started = await arbitrator.run_benchmark(
        HostedBenchmarkRunRequest(
            agent_count=2,
            live_agents=False,
            domain_prompts={
                "math": {
                    "template_id": "math-stepwise",
                    "question": "What is 2 + 2?",
                    "source": "custom",
                }
            },
        )
    )
    completed = await arbitrator.wait_for_benchmark_run(
        started.run_id,
        timeout_seconds=1.0,
        poll_interval_seconds=0.01,
    )
    detail = await arbitrator.get_benchmark_detail(started.run_id)
    events = [event async for event in arbitrator.stream_benchmark_run_events(started.run_id)]
    await arbitrator.aclose()

    assert started.status == "queued"
    assert completed.status == "completed"
    assert completed.artifact_id == "artifact-sdk"
    assert detail.benchmark_id == "run-sdk"
    assert detail.summary["accuracy"] == 1.0
    assert events[-1]["event"] == "complete"
    assert seen_calls[0][2]["json"] == {
        "training_per_category": 1,
        "holdout_per_category": 1,
        "agent_count": 2,
        "live_agents": False,
        "seed": 42,
        "domain_prompts": {
            "math": {
                "template_id": "math-stepwise",
                "prompt": "What is 2 + 2?",
                "source": "custom",
            }
        },
        "reasoning_presets": None,
    }


@pytest.mark.asyncio
async def test_sdk_wait_for_benchmark_run_raises_structured_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agora.sdk import HostedBenchmarkRunExecutionError

    arbitrator = AgoraArbitrator(auth_token="human-bearer-token", strict_verification=False)

    async def fake_get(url: str, *_args: object, **_kwargs: object) -> _FakeResponse:
        assert url == "/benchmarks/runs/run-failed"
        return _FakeResponse(
            {
                "run_id": "run-failed",
                "status": "failed",
                "created_at": "2026-04-21T04:00:00Z",
                "updated_at": "2026-04-21T04:00:03Z",
                "error": "benchmark providers unavailable",
            }
        )

    monkeypatch.setattr(arbitrator._client, "get", fake_get)

    with pytest.raises(HostedBenchmarkRunExecutionError) as exc_info:
        await arbitrator.wait_for_benchmark_run("run-failed", poll_interval_seconds=0.01)

    await arbitrator.aclose()

    assert exc_info.value.run_id == "run-failed"
    assert exc_info.value.status == "failed"
    assert exc_info.value.error == "benchmark providers unavailable"


@pytest.mark.asyncio
async def test_sdk_benchmark_flow_e2e_against_local_api(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agora.sdk import HostedBenchmarkRunRequest

    store = LocalTaskStore(data_dir=str(tmp_path / "sdk-benchmark-e2e"))
    task_routes._store = store

    async def fake_human_user(_credentials: object | None = None) -> AuthenticatedUser:
        return AuthenticatedUser(
            auth_method="jwt",
            workspace_id="workspace-sdk",
            user_id="user-sdk",
            email="sdk@example.com",
            display_name="SDK User",
            scopes=["tasks:read", "tasks:write"],
        )

    async def fake_execute_benchmark_run(
        *,
        workspace_id: str,
        run_id: str,
        request: Any,
    ) -> None:
        stream = benchmark_routes.get_stream_manager()
        started_at = datetime.now(UTC)
        await store.save_user_test_result(
            workspace_id,
            run_id,
            {
                "run_id": run_id,
                "workspace_id": workspace_id,
                "kind": "benchmark",
                "status": "running",
                "created_at": started_at.isoformat(),
                "updated_at": started_at.isoformat(),
                "request": request.model_dump(mode="json"),
                "label": "User-triggered benchmark",
            },
        )
        await benchmark_routes._persist_and_emit_benchmark_event(
            store=store,
            stream=stream,
            workspace_id=workspace_id,
            run_id=run_id,
            event_type="running",
            event_data={"run_id": run_id, "status": "running"},
        )

        completed_at = datetime.now(UTC)
        await store.save_user_test_result(
            workspace_id,
            run_id,
            {
                "run_id": run_id,
                "workspace_id": workspace_id,
                "kind": "benchmark",
                "status": "completed",
                "created_at": started_at.isoformat(),
                "updated_at": completed_at.isoformat(),
                "artifact_id": "artifact-sdk-e2e",
                "request": request.model_dump(mode="json"),
                "latest_mechanism": "selector",
                "agent_count": request.agent_count,
                "total_tokens": 64,
                "thinking_tokens": 8,
                "total_latency_ms": 12.5,
                "model_telemetry": {
                    "gemini-3-flash-preview": {
                        "total_tokens": 64,
                        "input_tokens": 32,
                        "output_tokens": 24,
                        "thinking_tokens": 8,
                        "latency_ms": 12.5,
                    }
                },
                "cost": {
                    "estimated_cost_usd": 0.0012,
                    "model_estimated_costs_usd": {"gemini-3-flash-preview": 0.0012},
                    "pricing_version": "2026-04-21",
                    "estimation_mode": "exact",
                    "pricing_sources": {"gemini-3-flash-preview": "test"},
                },
                "summary": {"accuracy": 1.0},
                "benchmark_payload": {"benchmark_config": {"agent_count": request.agent_count}},
                "events": [],
                "source": "user_test",
                "run_count": 1,
                "model_counts": {"gemini-3-flash-preview": 1},
                "mechanism_counts": {"selector": 1},
                "models": ["gemini-3-flash-preview"],
            },
        )
        await benchmark_routes._persist_and_emit_benchmark_event(
            store=store,
            stream=stream,
            workspace_id=workspace_id,
            run_id=run_id,
            event_type="complete",
            event_data={
                "run_id": run_id,
                "status": "completed",
                "artifact_id": "artifact-sdk-e2e",
            },
        )

    app.dependency_overrides[benchmark_routes.get_current_user] = fake_human_user
    monkeypatch.setattr(benchmark_routes, "_execute_benchmark_run", fake_execute_benchmark_run)

    try:
        arbitrator = AgoraArbitrator(auth_token="human-bearer-token", strict_verification=False)
        await arbitrator._client.aclose()
        arbitrator._client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        )

        started = await arbitrator.run_benchmark(
            HostedBenchmarkRunRequest(agent_count=2, live_agents=False)
        )
        completed = await arbitrator.wait_for_benchmark_run(
            started.run_id,
            timeout_seconds=2.0,
            poll_interval_seconds=0.01,
        )
        detail = await arbitrator.get_benchmark_detail(started.run_id)
        await arbitrator.aclose()

        assert started.status == "queued"
        assert completed.status == "completed"
        assert detail.benchmark_id == started.run_id
        assert detail.agent_count == 2
        assert detail.request is not None
        assert detail.request["agent_count"] == 2
    finally:
        app.dependency_overrides.clear()
        task_routes._store = None


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


@pytest.mark.asyncio
async def test_sdk_get_task_result_raises_structured_failure_for_failed_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agora.sdk import HostedTaskExecutionError

    arbitrator = AgoraArbitrator(strict_verification=False)

    async def fake_get(*_args: object, **_kwargs: object) -> _FakeResponse:
        return _FakeResponse(
            {
                "task_id": "task-failed",
                "task_text": "This task failed.",
                "workspace_id": "ws-test",
                "created_by": "sdk-test",
                "mechanism": "vote",
                "status": "failed",
                "selector_reasoning": "vote",
                "selector_reasoning_hash": "b" * 64,
                "selector_confidence": 1.0,
                "agent_count": 3,
                "reasoning_presets": {
                    "gemini_pro": "high",
                    "gemini_flash": "medium",
                    "kimi": "low",
                    "claude": "medium",
                },
                "failure_reason": "Provider fallback disabled for vote._VoteResponse",
                "latest_error_event": {
                    "event": "error",
                    "data": {
                        "message": "Provider fallback disabled for vote._VoteResponse"
                    },
                },
                "events": [
                    {
                        "event": "error",
                        "data": {
                            "message": "Provider fallback disabled for vote._VoteResponse"
                        },
                        "timestamp": "2026-04-21T03:10:00Z",
                    }
                ],
            }
        )

    monkeypatch.setattr(arbitrator._client, "get", fake_get)

    try:
        with pytest.raises(HostedTaskExecutionError) as exc_info:
            await arbitrator.get_task_result("task-failed")
    finally:
        await arbitrator.aclose()

    assert exc_info.value.task_id == "task-failed"
    assert exc_info.value.status == "failed"
    assert exc_info.value.failure_reason == "Provider fallback disabled for vote._VoteResponse"
    assert exc_info.value.latest_error_event == {
        "event": "error",
        "data": {"message": "Provider fallback disabled for vote._VoteResponse"},
    }


@pytest.mark.asyncio
async def test_sdk_get_task_result_raises_when_task_not_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agora.sdk import HostedTaskNotCompleteError

    arbitrator = AgoraArbitrator(strict_verification=False)

    async def fake_get(*_args: object, **_kwargs: object) -> _FakeResponse:
        return _FakeResponse(
            {
                "task_id": "task-in-progress",
                "task_text": "Pending task",
                "workspace_id": "ws-test",
                "created_by": "sdk-test",
                "mechanism": "vote",
                "status": "in_progress",
                "selector_reasoning": "vote",
                "selector_reasoning_hash": "c" * 64,
                "selector_confidence": 1.0,
                "agent_count": 3,
                "reasoning_presets": {
                    "gemini_pro": "high",
                    "gemini_flash": "medium",
                    "kimi": "low",
                    "claude": "medium",
                },
            }
        )

    monkeypatch.setattr(arbitrator._client, "get", fake_get)

    try:
        with pytest.raises(HostedTaskNotCompleteError) as exc_info:
            await arbitrator.get_task_result("task-in-progress")
    finally:
        await arbitrator.aclose()

    assert exc_info.value.task_id == "task-in-progress"
    assert exc_info.value.status == "in_progress"


@pytest.mark.asyncio
async def test_sdk_get_task_result_raises_protocol_error_for_missing_terminal_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agora.sdk import HostedTaskProtocolError

    arbitrator = AgoraArbitrator(strict_verification=False)

    async def fake_get(*_args: object, **_kwargs: object) -> _FakeResponse:
        return _FakeResponse(
            {
                "task_id": "task-bad-terminal",
                "task_text": "Malformed completion",
                "workspace_id": "ws-test",
                "created_by": "sdk-test",
                "mechanism": "vote",
                "status": "completed",
                "selector_reasoning": "vote",
                "selector_reasoning_hash": "d" * 64,
                "selector_confidence": 1.0,
                "agent_count": 3,
                "reasoning_presets": {
                    "gemini_pro": "high",
                    "gemini_flash": "medium",
                    "kimi": "low",
                    "claude": "medium",
                },
            }
        )

    monkeypatch.setattr(arbitrator._client, "get", fake_get)

    try:
        with pytest.raises(HostedTaskProtocolError, match="did not include a result payload"):
            await arbitrator.get_task_result("task-bad-terminal")
    finally:
        await arbitrator.aclose()


@pytest.mark.asyncio
async def test_sdk_wait_for_task_result_polls_until_completed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arbitrator = AgoraArbitrator(
        auth_token="agora_test_public.secret",
        mechanism="vote",
        strict_verification=False,
    )
    seen_posts: list[str] = []
    get_calls = {"count": 0}

    async def fake_post(url: str, *_args: object, **_kwargs: object) -> _FakeResponse:
        seen_posts.append(url)
        if url == "/tasks/":
            return _FakeResponse(
                {
                    "task_id": "task-polled",
                    "mechanism": "vote",
                    "confidence": 1.0,
                    "reasoning": "forced",
                    "selector_reasoning_hash": "e" * 64,
                    "status": "pending",
                    "selector_source": "forced_override",
                    "mechanism_override_source": "request",
                }
            )
        if url == "/tasks/task-polled/run-async":
            return _FakeResponse(
                {
                    "task_id": "task-polled",
                    "task_text": "Should we use microservices or a monolith?",
                    "workspace_id": "ws-test",
                    "created_by": "sdk-test",
                    "mechanism": "vote",
                    "status": "pending",
                    "selector_reasoning": "forced",
                    "selector_reasoning_hash": "e" * 64,
                    "selector_confidence": 1.0,
                    "agent_count": 4,
                    "reasoning_presets": {
                        "gemini_pro": "high",
                        "gemini_flash": "medium",
                        "kimi": "low",
                        "claude": "medium",
                    },
                }
            )
        raise AssertionError(f"Unexpected POST url: {url}")

    async def fake_get(url: str, *_args: object, **_kwargs: object) -> _FakeResponse:
        assert url == "/tasks/task-polled"
        get_calls["count"] += 1
        if get_calls["count"] == 1:
            return _FakeResponse(
                {
                    "task_id": "task-polled",
                    "task_text": "Should we use microservices or a monolith?",
                    "workspace_id": "ws-test",
                    "created_by": "sdk-test",
                    "mechanism": "vote",
                    "status": "in_progress",
                    "selector_reasoning": "forced",
                    "selector_reasoning_hash": "e" * 64,
                    "selector_confidence": 1.0,
                    "agent_count": 4,
                    "reasoning_presets": {
                        "gemini_pro": "high",
                        "gemini_flash": "medium",
                        "kimi": "low",
                        "claude": "medium",
                    },
                }
            )
        return _FakeResponse(
            {
                "task_id": "task-polled",
                "task_text": "Should we use microservices or a monolith?",
                "workspace_id": "ws-test",
                "created_by": "sdk-test",
                "mechanism": "vote",
                "status": "completed",
                "selector_reasoning": "forced",
                "selector_reasoning_hash": "e" * 64,
                "selector_confidence": 1.0,
                "agent_count": 4,
                "reasoning_presets": {
                    "gemini_pro": "high",
                    "gemini_flash": "medium",
                    "kimi": "low",
                    "claude": "medium",
                },
                "result": {
                    "task_id": "task-polled",
                    "mechanism": "vote",
                    "final_answer": "Monolith",
                    "confidence": 0.92,
                    "quorum_reached": True,
                    "merkle_root": "root-polled",
                    "decision_hash": "decision-polled",
                    "agent_count": 4,
                    "agent_models_used": [
                        "gemini-3-flash-preview",
                        "gemini-3.1-flash-lite-preview",
                    ],
                    "model_token_usage": {
                        "gemini-3-flash-preview": 10,
                        "gemini-3.1-flash-lite-preview": 12,
                    },
                    "model_latency_ms": {
                        "gemini-3-flash-preview": 100.0,
                        "gemini-3.1-flash-lite-preview": 120.0,
                    },
                    "model_telemetry": {},
                    "total_tokens_used": 22,
                    "input_tokens_used": 10,
                    "output_tokens_used": 12,
                    "thinking_tokens_used": 0,
                    "latency_ms": 220.0,
                    "cost": None,
                    "round_count": 1,
                    "mechanism_switches": 0,
                    "transcript_hashes": ["hash-1", "hash-2"],
                    "convergence_history": [],
                    "locked_claims": [],
                    "mechanism_trace": [],
                    "execution_mode": "live",
                    "selector_source": "forced_override",
                    "fallback_count": 0,
                    "fallback_events": [],
                    "mechanism_override_source": "request",
                },
            }
        )

    monkeypatch.setattr(arbitrator._client, "post", fake_post)
    monkeypatch.setattr(arbitrator._client, "get", fake_get)

    try:
        result = await arbitrator.arbitrate("Should we use microservices or a monolith?")
    finally:
        await arbitrator.aclose()

    assert "/tasks/task-polled/run-async" in seen_posts
    assert get_calls["count"] >= 2
    assert result.final_answer == "Monolith"
    assert result.mechanism_used.value == "vote"


@pytest.mark.asyncio
async def test_sdk_hosted_api_url_defaults_to_canonical(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AGORA_API_URL", raising=False)
    monkeypatch.delenv("AGORA_ALLOW_API_URL_OVERRIDE", raising=False)

    arbitrator = AgoraArbitrator(strict_verification=False)
    node = AgoraNode()
    try:
        assert resolve_hosted_api_url() == CANONICAL_HOSTED_API_URL
        assert arbitrator.config.api_url == CANONICAL_HOSTED_API_URL
        assert node.arbitrator.config.api_url == CANONICAL_HOSTED_API_URL
    finally:
        await arbitrator.aclose()
        await node.aclose()


def test_sdk_hosted_api_url_override_env_is_ignored_without_gate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGORA_API_URL", "https://example.invalid")
    monkeypatch.delenv("AGORA_ALLOW_API_URL_OVERRIDE", raising=False)

    assert resolve_hosted_api_url() == CANONICAL_HOSTED_API_URL


def test_sdk_hosted_api_url_override_requires_gate() -> None:
    with pytest.raises(ValueError, match="AGORA_ALLOW_API_URL_OVERRIDE=1"):
        AgoraArbitrator(
            api_url="https://example.invalid",
            strict_verification=False,
        )


@pytest.mark.asyncio
async def test_sdk_hosted_api_url_override_can_be_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGORA_ALLOW_API_URL_OVERRIDE", "1")
    monkeypatch.setenv("AGORA_API_URL", "https://example.invalid")

    arbitrator = AgoraArbitrator(
        api_url="https://example.invalid",
        strict_verification=False,
    )
    try:
        assert resolve_hosted_api_url() == "https://example.invalid"
        assert arbitrator.config.api_url == "https://example.invalid"
    finally:
        await arbitrator.aclose()


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
            "agent_models_used": ["gemini-3-flash-preview", "claude-sonnet-4-6"],
            "model_token_usage": {
                "gemini-3-flash-preview": 12,
                "claude-sonnet-4-6": 12,
            },
            "model_latency_ms": {
                "gemini-3-flash-preview": 4.0,
                "claude-sonnet-4-6": 8.0,
            },
            "model_telemetry": {
                "gemini-3-flash-preview": {
                    "total_tokens": 12,
                    "input_tokens": 4,
                    "output_tokens": 5,
                    "thinking_tokens": 3,
                    "latency_ms": 4.0,
                    "estimated_cost_usd": 0.000017,
                    "estimation_mode": "exact",
                },
                "claude-sonnet-4-6": {
                    "total_tokens": 12,
                    "input_tokens": 5,
                    "output_tokens": 4,
                    "thinking_tokens": 3,
                    "latency_ms": 8.0,
                    "estimated_cost_usd": 0.000072,
                    "estimation_mode": "exact",
                },
            },
            "round_count": 1,
            "mechanism_switches": 0,
            "merkle_root": merkle_root,
            "decision_hash": decision_hash,
            "transcript_hashes": transcript_hashes,
            "convergence_history": [],
            "locked_claims": [],
            "total_tokens_used": 24,
            "input_tokens_used": 9,
            "output_tokens_used": 9,
            "thinking_tokens_used": 6,
            "latency_ms": 12.0,
            "cost": {
                "estimated_cost_usd": 0.000089,
                "model_estimated_costs_usd": {
                    "gemini-3-flash-preview": 0.000017,
                    "claude-sonnet-4-6": 0.000072,
                },
                "pricing_version": "2026-04-18",
                "estimated_at": "2026-04-18T00:00:00+00:00",
                "estimation_mode": "exact",
                "pricing_sources": {
                    "gemini-3-flash-preview": "https://ai.google.dev/pricing",
                    "claude-sonnet-4-6": "https://claude.com/pricing",
                },
            },
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

    assert result.model_token_usage == {
        "gemini-3-flash-preview": 12,
        "claude-sonnet-4-6": 12,
    }
    assert result.model_input_token_usage == {
        "gemini-3-flash-preview": 4,
        "claude-sonnet-4-6": 5,
    }
    assert result.model_output_token_usage == {
        "gemini-3-flash-preview": 5,
        "claude-sonnet-4-6": 4,
    }
    assert result.model_thinking_token_usage == {
        "gemini-3-flash-preview": 3,
        "claude-sonnet-4-6": 3,
    }
    assert result.input_tokens_used == 9
    assert result.output_tokens_used == 9
    assert result.thinking_tokens_used == 6
    assert result.cost is not None
    assert result.cost.estimated_cost_usd == pytest.approx(0.000089)
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


def test_sdk_rejects_mixing_hosted_auth_with_explicit_local_models() -> None:
    from agora.sdk import LocalModelSpec, LocalProviderKeys

    with pytest.raises(ValueError, match="auth_token"):
        AgoraArbitrator(
            auth_token="agora_live_public.secret",
            local_models=[
                LocalModelSpec(provider="gemini", model="gemini-3-flash-preview"),
            ],
            local_provider_keys=LocalProviderKeys(gemini_api_key="test-key"),
            strict_verification=False,
        )


def test_sdk_rejects_agent_count_mismatch_for_local_models() -> None:
    from agora.sdk import LocalModelSpec, LocalProviderKeys

    with pytest.raises(ValueError, match="agent_count"):
        AgoraArbitrator(
            mechanism="vote",
            agent_count=5,
            local_models=[
                LocalModelSpec(provider="gemini", model="gemini-3-flash-preview"),
                LocalModelSpec(provider="openrouter", model="moonshotai/kimi-k2-thinking"),
                LocalModelSpec(provider="anthropic", model="claude-sonnet-4-6"),
            ],
            local_provider_keys=LocalProviderKeys(
                gemini_api_key="gem-key",
                openrouter_api_key="or-key",
                anthropic_api_key="anth-key",
            ),
            strict_verification=False,
        )


@pytest.mark.asyncio
async def test_sdk_local_models_fail_fast_when_provider_key_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agora.sdk import LocalModelSpec, LocalProviderKeys
    from agora.config import get_config

    monkeypatch.delenv("AGORA_OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("AGORA_OPENROUTER_SECRET_NAME", raising=False)
    monkeypatch.delenv("AGORA_OPENROUTER_SECRET_PROJECT", raising=False)
    monkeypatch.delenv("AGORA_OPENROUTER_SECRET_VERSION", raising=False)
    get_config.cache_clear()

    arbitrator = AgoraArbitrator(
        mechanism="vote",
        local_models=[
            LocalModelSpec(provider="gemini", model="gemini-3-flash-preview"),
            LocalModelSpec(provider="openrouter", model="moonshotai/kimi-k2-thinking"),
            LocalModelSpec(provider="anthropic", model="claude-sonnet-4-6"),
            LocalModelSpec(provider="gemini", model="gemini-3.1-flash-lite-preview"),
        ],
        local_provider_keys=LocalProviderKeys(
            gemini_api_key="gem-key",
            anthropic_api_key="anth-key",
        ),
        strict_verification=False,
    )

    try:
        with pytest.raises(ValueError, match="OpenRouter"):
            await arbitrator.arbitrate("Should we use microservices or a monolith?")
    finally:
        await arbitrator.aclose()
        get_config.cache_clear()


@pytest.mark.asyncio
async def test_sdk_local_model_roster_is_forwarded_to_orchestrator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agora.sdk import LocalDebateConfig, LocalModelSpec, LocalProviderKeys

    captured: dict[str, Any] = {}

    class _FakeLocalRosterOrchestrator:
        def __init__(
            self,
            agent_count: int,
            bandit_state_path: str | None = None,
            default_stakes: float = 0.5,
            allow_offline_fallback: bool = False,
            reasoning_presets=None,
            local_models=None,
            local_provider_keys=None,
            local_debate_config=None,
        ) -> None:
            del bandit_state_path, default_stakes
            captured["agent_count"] = agent_count
            captured["allow_offline_fallback"] = allow_offline_fallback
            captured["reasoning_presets"] = reasoning_presets
            captured["local_models"] = local_models
            captured["local_provider_keys"] = local_provider_keys
            captured["local_debate_config"] = local_debate_config

        def build_vote_engine(self, **_overrides: object) -> object:
            return object()

        async def run(self, task: str, **_kwargs: object) -> Any:
            return {
                "task": task,
            }

    async def fake_run(self, task: str, **_kwargs: object):
        from agora.types import DeliberationResult, MechanismType
        from tests.helpers import make_selection

        return DeliberationResult(
            task=task,
            mechanism_used=MechanismType.VOTE,
            mechanism_selection=make_selection(
                mechanism=MechanismType.VOTE,
                topic_category="reasoning",
            ),
            final_answer="Monolith",
            confidence=0.88,
            quorum_reached=True,
            round_count=1,
            agent_count=4,
            mechanism_switches=0,
            merkle_root="local-model-root",
            transcript_hashes=["h1", "h2", "h3", "h4"],
            agent_models_used=[
                "gemini-3-flash-preview",
                "gemini-3.1-flash-lite-preview",
                "moonshotai/kimi-k2-thinking",
                "claude-sonnet-4-6",
            ],
            convergence_history=[],
            locked_claims=[],
            total_tokens_used=44,
            total_latency_ms=12.0,
            timestamp=datetime.now(),
        )

    monkeypatch.setattr(_FakeLocalRosterOrchestrator, "run", fake_run)
    monkeypatch.setattr("agora.sdk.arbitrator.AgoraOrchestrator", _FakeLocalRosterOrchestrator)

    local_models = [
        LocalModelSpec(provider="gemini", model="gemini-3-flash-preview"),
        LocalModelSpec(provider="gemini", model="gemini-3.1-flash-lite-preview"),
        LocalModelSpec(provider="openrouter", model="moonshotai/kimi-k2-thinking"),
        LocalModelSpec(provider="anthropic", model="claude-sonnet-4-6"),
    ]
    provider_keys = LocalProviderKeys(
        gemini_api_key="gem-key",
        openrouter_api_key="or-key",
        anthropic_api_key="anth-key",
    )
    debate_config = LocalDebateConfig(
        devils_advocate_model=LocalModelSpec(
            provider="openrouter",
            model="moonshotai/kimi-k2-thinking",
        )
    )

    arbitrator = AgoraArbitrator(
        mechanism="vote",
        local_models=local_models,
        local_provider_keys=provider_keys,
        local_debate_config=debate_config,
        strict_verification=False,
    )

    try:
        result = await arbitrator.arbitrate("Should we use microservices or a monolith?")
    finally:
        await arbitrator.aclose()

    assert result.final_answer == "Monolith"
    assert captured["agent_count"] == 4
    assert captured["local_models"] == local_models
    assert captured["local_provider_keys"] == provider_keys
    assert captured["local_debate_config"] == debate_config


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
