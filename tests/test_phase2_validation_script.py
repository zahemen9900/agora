from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "phase2_validation.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("phase2_validation", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_live_agents_enable_offline_fallback(monkeypatch) -> None:
    module = _load_module()
    seen: dict[str, object] = {}

    class _FakeBandit:
        def to_state(self) -> dict[str, object]:
            return {}

    class _FakeOrchestrator:
        def __init__(
            self,
            agent_count: int,
            bandit_state_path: str | None = None,
            allow_offline_fallback: bool = False,
        ) -> None:
            seen["agent_count"] = agent_count
            seen["bandit_state_path"] = bandit_state_path
            seen["allow_offline_fallback"] = allow_offline_fallback
            self.selector = SimpleNamespace(bandit=_FakeBandit())

    class _FakeRunner:
        def __init__(self, orchestrator: object, agents: list[object] | None = None) -> None:
            seen["orchestrator"] = orchestrator
            seen["agents"] = agents

        @staticmethod
        def build_phase2_task_split(
            *,
            training_per_category: int,
            holdout_per_category: int,
        ) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
            seen["split"] = (training_per_category, holdout_per_category)
            return ([{"question": "What is 2 + 2?"}], [])

        async def run_phase2_validation(self, **kwargs: object) -> dict[str, object]:
            seen["run_kwargs"] = kwargs
            return {
                "pre_learning": {"runs": [{}]},
                "learning_updates": [],
                "post_learning": {"runs": []},
                "bandit_stats": {},
            }

    monkeypatch.setattr(module, "AgoraOrchestrator", _FakeOrchestrator)
    monkeypatch.setattr(module, "BenchmarkRunner", _FakeRunner)

    args = SimpleNamespace(
        training_per_category=1,
        holdout_per_category=1,
        agent_count=2,
        bandit_state_path=None,
        live_agents=True,
        seed=42,
        output="benchmarks/results/test-phase2-validation.json",
    )

    payload = asyncio.run(module._run_validation(args))

    assert seen["allow_offline_fallback"] is True
    assert seen["agents"] is None
    assert seen["split"] == (1, 1)
    assert payload["pre_learning"]["runs"] == [{}]
