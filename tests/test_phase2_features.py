from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agora.sdk import AgoraArbitrator
from api.main import app
from api.routes import tasks as task_routes
from api.store_local import LocalTaskStore
from benchmarks.runner import BenchmarkRunner


def test_benchmark_runner_loads_curated_dataset() -> None:
    dataset = BenchmarkRunner.load_dataset("math")

    assert len(dataset) == 6
    assert {item["category"] for item in dataset} == {"math"}
    assert all("task" in item for item in dataset)
    assert all("source" in item for item in dataset)


def test_benchmarks_route_reads_store_summary(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "benchmarks-data"))
    task_routes._store = store
    summary = {
        "summary": {
            "per_mode": {"selector": {"accuracy": 0.8}},
            "per_category": {"reasoning": {"selector": {"accuracy": 0.75}}},
        }
    }

    asyncio.run(store.save_benchmark_summary(summary))
    client = TestClient(app)
    response = client.get("/benchmarks")

    assert response.status_code == 200
    assert response.json() == summary
    task_routes._store = None


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

    arbitrator = AgoraArbitrator(mechanism="vote", agent_count=3)
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
