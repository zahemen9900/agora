"""Phase 2 benchmark runner for comparison, ablation, and validation exports."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agora.engines.debate import DebateEngine
from agora.engines.vote import VoteEngine
from agora.runtime.orchestrator import AgoraOrchestrator
from agora.selector.features import extract_features
from agora.types import DeliberationResult, MechanismSelection, MechanismType

_DATASET_DIR = Path(__file__).resolve().parent / "datasets"
_RESULTS_DIR = Path(__file__).resolve().parent / "results"
_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


class BenchmarkRunner:
    """Run comparison and ablation suites over Agora mechanisms."""

    def __init__(self, orchestrator: AgoraOrchestrator):
        self.orchestrator = orchestrator

    async def run_comparison(
        self,
        tasks: list[dict[str, Any]],
        mechanisms_to_test: list[str] | None = None,
    ) -> dict[str, Any]:
        """Compare forced debate, forced vote, and selector execution."""

        mechanisms = mechanisms_to_test or ["debate", "vote", "selector"]
        runs: list[dict[str, Any]] = []

        for task_index, task_item in enumerate(tasks):
            for mechanism in mechanisms:
                override = None if mechanism == "selector" else mechanism
                result = await self.orchestrator.run(
                    task=task_item["task"],
                    stakes=float(task_item.get("stakes", 0.0)),
                    mechanism_override=override,
                )
                runs.append(self._build_run_record(task_index, mechanism, task_item, result))

        return {
            "runs": runs,
            "summary": self._summarize_runs(runs),
        }

    async def run_ablation(self, tasks: list[dict[str, Any]]) -> dict[str, Any]:
        """Run Phase 2 ablations for vote and debate variants."""

        runs: list[dict[str, Any]] = []
        for task_index, task_item in enumerate(tasks):
            vote_selection = await self._forced_selection(task_item["task"], MechanismType.VOTE)
            debate_selection = await self._forced_selection(task_item["task"], MechanismType.DEBATE)

            vote_variants = {
                "simple_majority_vote": VoteEngine(
                    agent_count=self.orchestrator.agent_count,
                    hasher=self.orchestrator.hasher,
                    aggregation_mode="majority",
                ),
                "confidence_weighted_vote": VoteEngine(
                    agent_count=self.orchestrator.agent_count,
                    hasher=self.orchestrator.hasher,
                    aggregation_mode="confidence_weighted",
                ),
                "isp_vote": VoteEngine(
                    agent_count=self.orchestrator.agent_count,
                    hasher=self.orchestrator.hasher,
                    aggregation_mode="isp",
                ),
            }
            debate_variants = {
                "flat_debate": DebateEngine(
                    agent_count=self.orchestrator.agent_count,
                    hasher=self.orchestrator.hasher,
                    monitor=self.orchestrator.monitor,
                    enable_devils_advocate=False,
                    enable_adaptive_termination=False,
                ),
                "factional_debate": DebateEngine(
                    agent_count=self.orchestrator.agent_count,
                    hasher=self.orchestrator.hasher,
                    monitor=self.orchestrator.monitor,
                    enable_devils_advocate=True,
                    enable_adaptive_termination=False,
                ),
                "full_debate": DebateEngine(
                    agent_count=self.orchestrator.agent_count,
                    hasher=self.orchestrator.hasher,
                    monitor=self.orchestrator.monitor,
                    enable_devils_advocate=True,
                    enable_adaptive_termination=True,
                ),
            }

            for variant_name, engine in vote_variants.items():
                outcome = await engine.run(task_item["task"], vote_selection)
                runs.append(
                    self._build_run_record(task_index, variant_name, task_item, outcome.result)
                )

            for variant_name, engine in debate_variants.items():
                outcome = await engine.run(task_item["task"], debate_selection)
                if outcome.result is None:
                    continue
                runs.append(
                    self._build_run_record(task_index, variant_name, task_item, outcome.result)
                )

        return {
            "runs": runs,
            "summary": self._summarize_runs(runs),
        }

    async def run_phase2_validation(
        self,
        training_tasks: list[dict[str, Any]],
        holdout_tasks: list[dict[str, Any]],
        output_path: str | None = None,
    ) -> dict[str, Any]:
        """Run training/learning cycle and export a dashboard-ready artifact."""

        pre_learning_runs: list[dict[str, Any]] = []
        learning_updates: list[dict[str, Any]] = []
        holdout_runs: list[dict[str, Any]] = []

        for task_index, task_item in enumerate(training_tasks):
            first = await self.orchestrator.run(task_item["task"])
            second = await self.orchestrator.run(task_item["task"])
            record = self._build_run_record(task_index, "selector", task_item, first)
            record["merkle_root_rerun"] = second.merkle_root
            record["merkle_deterministic"] = first.merkle_root == second.merkle_root
            pre_learning_runs.append(record)

            learned = await self.orchestrator.run_and_learn(
                task_item["task"],
                ground_truth=task_item.get("ground_truth"),
            )
            learning_updates.append(
                self._build_run_record(task_index, "selector_learn", task_item, learned)
            )

        for task_index, task_item in enumerate(holdout_tasks):
            holdout = await self.orchestrator.run(task_item["task"])
            holdout_runs.append(self._build_run_record(task_index, "selector", task_item, holdout))

        payload = {
            "generated_at": datetime.now(UTC).isoformat(),
            "pre_learning": {
                "runs": pre_learning_runs,
                "summary": self._summarize_runs(pre_learning_runs),
            },
            "learning_updates": {
                "runs": learning_updates,
                "summary": self._summarize_runs(learning_updates),
            },
            "post_learning": {
                "runs": holdout_runs,
                "summary": self._summarize_runs(holdout_runs),
            },
            "bandit_stats": self.orchestrator.selector.bandit.get_stats(),
        }
        self.export_results(
            payload,
            output_path or str(_RESULTS_DIR / "phase2_validation.json"),
        )
        return payload

    def export_results(self, results: dict[str, Any], output_path: str) -> None:
        """Export benchmark results to JSON."""

        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(results, indent=2, ensure_ascii=True), encoding="utf-8")

    @staticmethod
    def load_dataset(dataset_name: str) -> list[dict[str, Any]]:
        """Load a benchmark dataset by filename stem."""

        path = _DATASET_DIR / f"{dataset_name}.json"
        return json.loads(path.read_text(encoding="utf-8"))

    async def _forced_selection(
        self,
        task: str,
        mechanism: MechanismType,
    ) -> MechanismSelection:
        """Build a deterministic forced selection for direct engine evaluation."""

        features = await extract_features(
            task_text=task,
            agent_count=self.orchestrator.agent_count,
            stakes=self.orchestrator.default_stakes,
        )
        reasoning = f"Forced benchmark mechanism: {mechanism.value}"
        return MechanismSelection(
            mechanism=mechanism,
            confidence=1.0,
            reasoning=reasoning,
            reasoning_hash=self.orchestrator.hasher.hash_content(reasoning),
            bandit_recommendation=mechanism,
            bandit_confidence=1.0,
            task_features=features,
        )

    def _build_run_record(
        self,
        task_index: int,
        mode: str,
        task_item: dict[str, Any],
        result: DeliberationResult,
    ) -> dict[str, Any]:
        """Build a benchmark run record from a deliberation result."""

        return {
            "task_index": task_index,
            "task": task_item["task"],
            "category": task_item.get("category", "reasoning"),
            "mode": mode,
            "mechanism_used": result.mechanism_used.value,
            "correct": self._score_result(task_item, result),
            "confidence": result.confidence,
            "tokens_used": result.total_tokens_used,
            "latency_ms": result.total_latency_ms,
            "rounds": result.round_count,
            "switches": result.mechanism_switches,
            "quorum_reached": result.quorum_reached,
            "merkle_root": result.merkle_root,
            "final_answer": result.final_answer,
            "selector_reasoning": result.mechanism_selection.reasoning,
            "selector_reasoning_hash": result.mechanism_selection.reasoning_hash,
        }

    def _score_result(self, task_item: dict[str, Any], result: DeliberationResult) -> bool:
        """Score a result against task metadata or proxy heuristic."""

        category = str(task_item.get("category", "reasoning")).lower()
        if category == "creative":
            return result.quorum_reached and result.confidence >= 0.6

        ground_truth = task_item.get("ground_truth")
        if not ground_truth:
            return False

        predicted = self._normalize_answer(result.final_answer)
        expected = self._normalize_answer(str(ground_truth))
        if predicted == expected:
            return True

        predicted_numbers = _NUMBER_RE.findall(predicted)
        expected_numbers = _NUMBER_RE.findall(expected)
        return bool(predicted_numbers and predicted_numbers[-1:] == expected_numbers[-1:])

    @staticmethod
    def _normalize_answer(answer: str) -> str:
        """Normalize answers for simple exact-match evaluation."""

        lowered = answer.strip().lower()
        lowered = re.sub(r"\s+", " ", lowered)
        lowered = lowered.removeprefix("answer: ").strip()
        return lowered

    def _summarize_runs(self, runs: list[dict[str, Any]]) -> dict[str, Any]:
        """Aggregate benchmark records by mode and category."""

        if not runs:
            return {"per_mode": {}, "per_category": {}}

        per_mode: dict[str, list[dict[str, Any]]] = defaultdict(list)
        per_category: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(
            lambda: defaultdict(list)
        )
        for run in runs:
            per_mode[run["mode"]].append(run)
            per_category[run["category"]][run["mode"]].append(run)

        mode_summary = {
            mode: {
                "accuracy": sum(1 for run in mode_runs if run["correct"]) / len(mode_runs),
                "avg_tokens": sum(run["tokens_used"] for run in mode_runs) / len(mode_runs),
                "avg_latency_ms": sum(run["latency_ms"] for run in mode_runs) / len(mode_runs),
                "avg_rounds": sum(run["rounds"] for run in mode_runs) / len(mode_runs),
                "switch_rate": sum(run["switches"] for run in mode_runs) / len(mode_runs),
            }
            for mode, mode_runs in per_mode.items()
        }

        category_summary = {
            category: {
                mode: {
                    "accuracy": sum(1 for run in category_runs if run["correct"])
                    / len(category_runs),
                    "avg_tokens": sum(run["tokens_used"] for run in category_runs)
                    / len(category_runs),
                    "avg_latency_ms": sum(run["latency_ms"] for run in category_runs)
                    / len(category_runs),
                }
                for mode, category_runs in mode_runs.items()
            }
            for category, mode_runs in per_category.items()
        }

        return {
            "per_mode": mode_summary,
            "per_category": category_summary,
        }
