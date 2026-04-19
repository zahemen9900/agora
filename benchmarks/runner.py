"""Phase 2 benchmark runner for comparison, ablation, and validation exports."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from agora.runtime.costing import build_model_telemetry, estimate_cost_for_models
from agora.runtime.orchestrator import AgoraOrchestrator
from agora.selector.features import extract_features
from agora.types import DeliberationResult, MechanismSelection, MechanismType

_DATASET_DIR = Path(__file__).resolve().parent / "datasets"
_RESULTS_DIR = Path(__file__).resolve().parent / "results"
_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")
_DATASET_ALIASES = {
    "math": "math_tasks",
    "factual": "factual_tasks",
    "reasoning": "reasoning_tasks",
    "code": "code_tasks",
    "creative": "creative_tasks",
}

def _normalized_model_token_usage(
    model_token_usage: dict[str, int],
    *,
    fallback_models: Sequence[str],
    fallback_total_tokens: int,
) -> dict[str, int]:
    usage: dict[str, int] = {
        model: int(tokens)
        for model, tokens in model_token_usage.items()
        if isinstance(tokens, int) and tokens > 0 and model.strip()
    }
    if usage:
        return usage

    models = [
        model.strip() for model in fallback_models if isinstance(model, str) and model.strip()
    ]
    if not models or fallback_total_tokens <= 0:
        return {}

    base = fallback_total_tokens // len(models)
    remainder = fallback_total_tokens % len(models)
    derived: dict[str, int] = {}
    for index, model in enumerate(models):
        derived[model] = base + (1 if index < remainder else 0)
    return derived
def _record_cost_telemetry(
    run: dict[str, Any],
    *,
    fallback_models: Sequence[str] | None = None,
    fallback_total_tokens: int | None = None,
) -> tuple[float, dict[str, float], dict[str, int], int]:
    token_usage_raw = run.get("model_token_usage")
    token_usage_map = {
        model: int(tokens)
        for model, tokens in (token_usage_raw.items() if isinstance(token_usage_raw, dict) else [])
        if isinstance(tokens, int) and tokens > 0 and str(model).strip()
    }
    model_usage = _normalized_model_token_usage(
        token_usage_map,
        fallback_models=fallback_models or run.get("agent_models_used") or [],
        fallback_total_tokens=int(
            fallback_total_tokens
            if fallback_total_tokens is not None
            else run.get("tokens_used") or run.get("total_tokens_used") or 0
        ),
    )
    model_telemetry = build_model_telemetry(
        models=list(model_usage.keys()),
        model_token_usage=model_usage,
    )
    cost_payload = estimate_cost_for_models(model_telemetry)

    thinking_tokens = int(run.get("thinking_tokens_used") or 0)
    return (
        float(cost_payload["estimated_cost_usd"] or 0.0),
        cost_payload["model_estimated_costs_usd"],
        model_usage,
        max(thinking_tokens, 0),
    )


class BenchmarkRunner:
    """Run comparison and ablation suites over Agora mechanisms."""

    def __init__(
        self,
        orchestrator: AgoraOrchestrator,
        agents: Sequence[Callable[..., Any]] | None = None,
    ):
        self.orchestrator = orchestrator
        self.agents = agents

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
                    agents=self.agents,
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
                "simple_majority_vote": self.orchestrator.build_vote_engine(
                    aggregation_mode="majority",
                ),
                "confidence_weighted_vote": self.orchestrator.build_vote_engine(
                    aggregation_mode="confidence_weighted",
                ),
                "isp_vote": self.orchestrator.build_vote_engine(
                    aggregation_mode="isp",
                ),
            }
            debate_variants = {
                "flat_debate": self.orchestrator.build_debate_engine(
                    enable_devils_advocate=False,
                    enable_adaptive_termination=False,
                ),
                "factional_debate": self.orchestrator.build_debate_engine(
                    enable_devils_advocate=True,
                    enable_adaptive_termination=False,
                ),
                "full_debate": self.orchestrator.build_debate_engine(
                    enable_devils_advocate=True,
                    enable_adaptive_termination=True,
                ),
            }

            for variant_name, engine in vote_variants.items():
                outcome = await engine.run(
                    task_item["task"],
                    vote_selection,
                    custom_agents=self.agents,
                )
                runs.append(
                    self._build_run_record(task_index, variant_name, task_item, outcome.result)
                )

            for variant_name, engine in debate_variants.items():
                outcome = await engine.run(
                    task_item["task"],
                    debate_selection,
                    custom_agents=self.agents,
                )
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
        seed: int | None = None,
        progress_callback: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        """Run training/learning cycle and export a dashboard-ready artifact."""

        pre_learning_runs: list[dict[str, Any]] = []
        learning_updates: list[dict[str, Any]] = []
        holdout_runs: list[dict[str, Any]] = []

        def _seed_rng(seed_offset: int) -> None:
            if seed is not None:
                np.random.seed(seed + seed_offset)

        for task_index, task_item in enumerate(training_tasks):
            base_seed_offset = task_index * 3

            _seed_rng(base_seed_offset)
            first = await self.orchestrator.run(task_item["task"], agents=self.agents)

            _seed_rng(base_seed_offset)
            second = await self.orchestrator.run(task_item["task"], agents=self.agents)

            record = self._build_run_record(task_index, "selector", task_item, first)
            record["merkle_root_rerun"] = second.merkle_root
            record["merkle_deterministic"] = first.merkle_root == second.merkle_root
            if seed is not None and not record["merkle_deterministic"]:
                raise RuntimeError(
                    "Determinism check failed for training task "
                    f"index={task_index} category={task_item.get('category', 'unknown')}"
                )
            pre_learning_runs.append(record)
            if progress_callback is not None:
                await progress_callback(
                    "domain_progress",
                    self._progress_payload(
                        phase="pre_learning",
                        completed=len(pre_learning_runs),
                        total=len(training_tasks) * 2 + len(holdout_tasks),
                        latest_run=record,
                        accumulated_runs=pre_learning_runs + learning_updates + holdout_runs,
                    ),
                )

            _seed_rng(base_seed_offset + 1)
            learned = await self.orchestrator.run_and_learn(
                task_item["task"],
                ground_truth=task_item.get("ground_truth"),
                agents=self.agents,
            )
            learned_record = self._build_run_record(task_index, "selector_learn", task_item, learned)
            learning_updates.append(learned_record)
            if progress_callback is not None:
                await progress_callback(
                    "domain_progress",
                    self._progress_payload(
                        phase="learning_updates",
                        completed=len(pre_learning_runs) + len(learning_updates),
                        total=len(training_tasks) * 2 + len(holdout_tasks),
                        latest_run=learned_record,
                        accumulated_runs=pre_learning_runs + learning_updates + holdout_runs,
                    ),
                )

        for task_index, task_item in enumerate(holdout_tasks):
            _seed_rng(len(training_tasks) * 3 + task_index)
            holdout = await self.orchestrator.run(task_item["task"], agents=self.agents)
            holdout_record = self._build_run_record(task_index, "selector", task_item, holdout)
            holdout_runs.append(holdout_record)
            if progress_callback is not None:
                await progress_callback(
                    "domain_progress",
                    self._progress_payload(
                        phase="post_learning",
                        completed=len(pre_learning_runs) + len(learning_updates) + len(holdout_runs),
                        total=len(training_tasks) * 2 + len(holdout_tasks),
                        latest_run=holdout_record,
                        accumulated_runs=pre_learning_runs + learning_updates + holdout_runs,
                    ),
                )

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

    @staticmethod
    def _progress_payload(
        *,
        phase: str,
        completed: int,
        total: int,
        latest_run: dict[str, Any],
        accumulated_runs: list[dict[str, Any]],
    ) -> dict[str, Any]:
        summary = BenchmarkRunner._summarize_runs(accumulated_runs)
        return {
            "phase": phase,
            "completed": completed,
            "total": total,
            "latest_run": latest_run,
            "latest_mechanism": latest_run.get("mechanism_used") or latest_run.get("mode"),
            "telemetry": {
                "agent_count": int(latest_run.get("agent_count") or 0) or None,
                "total_tokens": sum(
                    int(run.get("tokens_used") or run.get("total_tokens_used") or 0)
                    for run in accumulated_runs
                ),
                "thinking_tokens": sum(
                    int(run.get("thinking_tokens_used") or 0) for run in accumulated_runs
                ),
                "total_latency_ms": sum(float(run.get("latency_ms") or 0.0) for run in accumulated_runs),
                "model_token_usage": {
                    model: int(tokens)
                    for model, tokens in BenchmarkRunner._aggregate_model_usage(
                        accumulated_runs
                    ).items()
                },
                "model_telemetry": BenchmarkRunner._aggregate_model_telemetry(accumulated_runs),
                "summary": summary,
                "cost": BenchmarkRunner._aggregate_cost(accumulated_runs),
            },
        }

    def export_results(self, results: dict[str, Any], output_path: str) -> None:
        """Export benchmark results to JSON."""

        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(results, indent=2, ensure_ascii=True), encoding="utf-8")

    @staticmethod
    def load_dataset(dataset_name: str) -> list[dict[str, Any]]:
        """Load a benchmark dataset by filename stem."""

        normalized_name = _DATASET_ALIASES.get(dataset_name, dataset_name)
        path = _DATASET_DIR / f"{normalized_name}.json"
        return json.loads(path.read_text(encoding="utf-8"))

    @classmethod
    def build_phase2_task_split(
        cls,
        training_per_category: int = 6,
        holdout_per_category: int = 2,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Build the default 30-train / 10-holdout Phase 2 split."""

        training_tasks: list[dict[str, Any]] = []
        holdout_tasks: list[dict[str, Any]] = []
        for category in _DATASET_ALIASES:
            dataset = cls.load_dataset(category)
            required = training_per_category + holdout_per_category
            if len(dataset) < required:
                raise ValueError(
                    f"Dataset '{category}' needs at least {required} tasks, found {len(dataset)}"
                )
            training_tasks.extend(dataset[:training_per_category])
            holdout_tasks.extend(dataset[training_per_category:required])

        return training_tasks, holdout_tasks

    @staticmethod
    def summarize_completed_task_records(records: list[dict[str, Any]]) -> dict[str, Any]:
        """Aggregate completed task records into a benchmark-like summary.

        Accuracy is reported as a quorum-rate proxy when no explicit correctness signal is stored.
        """

        runs: list[dict[str, Any]] = []
        for task_index, record in enumerate(records):
            result = record.get("result")
            if not isinstance(result, dict):
                continue

            total_cost, model_costs, model_usage, thinking_tokens = _record_cost_telemetry(result)
            model_telemetry = build_model_telemetry(
                models=list((result.get("agent_models_used") or [])),
                model_token_usage=model_usage,
                model_latency_ms=result.get("model_latency_ms") or {},
                fallback_total_tokens=int(result.get("total_tokens_used", 0)),
            )
            cost_payload = estimate_cost_for_models(model_telemetry)

            category = str(record.get("category") or record.get("benchmark_category") or "unknown")
            quorum_reached = bool(result.get("quorum_reached"))
            runs.append(
                {
                    "task_index": task_index,
                    "task_id": record.get("task_id"),
                    "task": record.get("task_text", "Completed task"),
                    "category": category,
                    "mode": str(record.get("mechanism") or result.get("mechanism") or "selector"),
                    "mechanism_used": str(result.get("mechanism") or record.get("mechanism") or ""),
                    "correct": quorum_reached,
                    "confidence": float(result.get("confidence", 0.0)),
                    "tokens_used": int(result.get("total_tokens_used", 0)),
                    "latency_ms": float(result.get("latency_ms", 0.0)),
                    "rounds": int(result.get("round_count", record.get("round_count", 0) or 0)),
                    "switches": int(
                        result.get(
                            "mechanism_switches",
                            record.get("mechanism_switches", 0) or 0,
                        )
                    ),
                    "quorum_reached": quorum_reached,
                    "merkle_root": result.get("merkle_root"),
                    "final_answer": result.get("final_answer", ""),
                    "selector_reasoning": record.get("selector_reasoning", ""),
                    "selector_reasoning_hash": record.get("selector_reasoning_hash", ""),
                    "accuracy_is_proxy": True,
                    "agent_count": int(result.get("agent_count") or record.get("agent_count") or 0),
                    "agent_models_used": result.get("agent_models_used") or [],
                    "model_token_usage": model_usage,
                    "model_latency_ms": result.get("model_latency_ms") or {},
                    "model_telemetry": model_telemetry,
                    "thinking_tokens_used": thinking_tokens,
                    "estimated_cost_usd": total_cost or cost_payload["estimated_cost_usd"],
                    "model_estimated_costs_usd": model_costs or cost_payload["model_estimated_costs_usd"],
                    "pricing_version": cost_payload["pricing_version"],
                    "cost_estimated_at": cost_payload["estimated_at"].isoformat(),
                    "estimation_mode": cost_payload["estimation_mode"],
                    "pricing_sources": cost_payload["pricing_sources"],
                }
            )

        summary = BenchmarkRunner._summarize_runs(runs)
        return {
            "runs": runs,
            "summary": summary,
            "metadata": {
                "source": "completed_task_records",
                "accuracy_is_proxy": True,
            },
        }

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

        model_token_usage = _normalized_model_token_usage(
            {model: int(tokens) for model, tokens in result.model_token_usage.items()},
            fallback_models=result.agent_models_used,
            fallback_total_tokens=result.total_tokens_used,
        )
        model_telemetry = build_model_telemetry(
            models=result.agent_models_used,
            model_token_usage=model_token_usage,
            model_latency_ms=result.model_latency_ms,
            model_input_tokens=getattr(result, "model_input_token_usage", {}),
            model_output_tokens=getattr(result, "model_output_token_usage", {}),
            model_thinking_tokens=getattr(result, "model_thinking_token_usage", {}),
            fallback_total_tokens=result.total_tokens_used,
        )
        cost_payload = estimate_cost_for_models(model_telemetry)
        model_thinking_usage_raw = getattr(result, "model_thinking_token_usage", {})
        model_thinking_usage = {
            model: int(tokens)
            for model, tokens in (
                model_thinking_usage_raw.items()
                if isinstance(model_thinking_usage_raw, dict)
                else []
            )
            if isinstance(tokens, int) and tokens > 0 and str(model).strip()
        }
        thinking_tokens_used = int(
            getattr(result, "thinking_tokens_used", 0) or sum(model_thinking_usage.values())
        )

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
            "agent_count": result.agent_count,
            "agent_models_used": result.agent_models_used,
            "model_token_usage": model_token_usage,
            "model_latency_ms": {
                model: float(latency)
                for model, latency in result.model_latency_ms.items()
                if isinstance(latency, (int, float)) and latency >= 0
            },
            "model_telemetry": model_telemetry,
            "model_thinking_token_usage": model_thinking_usage,
            "thinking_tokens_used": thinking_tokens_used,
            "estimated_cost_usd": cost_payload["estimated_cost_usd"],
            "model_estimated_costs_usd": cost_payload["model_estimated_costs_usd"],
            "pricing_version": cost_payload["pricing_version"],
            "cost_estimated_at": cost_payload["estimated_at"].isoformat(),
            "estimation_mode": cost_payload["estimation_mode"],
            "pricing_sources": cost_payload["pricing_sources"],
        }

    @staticmethod
    def _aggregate_model_usage(runs: list[dict[str, Any]]) -> dict[str, int]:
        aggregated: dict[str, int] = {}
        for run in runs:
            usage = run.get("model_token_usage")
            if not isinstance(usage, dict):
                continue
            for model, tokens in usage.items():
                key = str(model).strip()
                if not key:
                    continue
                aggregated[key] = aggregated.get(key, 0) + int(tokens or 0)
        return aggregated

    @staticmethod
    def _aggregate_model_telemetry(runs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        aggregated: dict[str, dict[str, Any]] = {}
        for run in runs:
            models = run.get("model_telemetry")
            if not isinstance(models, dict):
                models = {}
            for model, payload in models.items():
                if not isinstance(payload, dict):
                    continue
                bucket = aggregated.setdefault(
                    str(model),
                    {
                        "total_tokens": 0,
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "thinking_tokens": 0,
                        "latency_ms": 0.0,
                    },
                )
                bucket["total_tokens"] += int(payload.get("total_tokens", 0) or 0)
                bucket["input_tokens"] += int(payload.get("input_tokens", 0) or 0)
                bucket["output_tokens"] += int(payload.get("output_tokens", 0) or 0)
                bucket["thinking_tokens"] += int(payload.get("thinking_tokens", 0) or 0)
                bucket["latency_ms"] += float(payload.get("latency_ms", 0.0) or 0.0)
        return aggregated

    @staticmethod
    def _aggregate_cost(runs: list[dict[str, Any]]) -> dict[str, Any]:
        total = 0.0
        model_costs: dict[str, float] = {}
        pricing_version = None
        estimated_at = None
        estimation_mode = None
        pricing_sources: dict[str, str] = {}
        for run in runs:
            run_cost = float(run.get("estimated_cost_usd") or 0.0)
            total += run_cost
            for model, value in (run.get("model_estimated_costs_usd") or {}).items():
                key = str(model).strip()
                if not key:
                    continue
                model_costs[key] = model_costs.get(key, 0.0) + float(value or 0.0)
            pricing_version = pricing_version or run.get("pricing_version")
            estimated_at = estimated_at or run.get("cost_estimated_at")
            estimation_mode = estimation_mode or run.get("estimation_mode")
            if isinstance(run.get("pricing_sources"), dict):
                for model, source in run["pricing_sources"].items():
                    pricing_sources[str(model)] = str(source)
        return {
            "estimated_cost_usd": round(total, 8) if total > 0 else None,
            "model_estimated_costs_usd": {
                model: round(value, 8) for model, value in model_costs.items() if value > 0
            },
            "pricing_version": pricing_version,
            "estimated_at": estimated_at,
            "estimation_mode": estimation_mode,
            "pricing_sources": pricing_sources,
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

    @staticmethod
    def _summarize_runs(runs: list[dict[str, Any]]) -> dict[str, Any]:
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
                "avg_thinking_tokens": sum(
                    float(run.get("thinking_tokens_used") or 0) for run in mode_runs
                )
                / len(mode_runs),
                "avg_estimated_cost_usd": sum(
                    float(run.get("estimated_cost_usd") or 0.0) for run in mode_runs
                )
                / len(mode_runs),
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
                    "avg_thinking_tokens": sum(
                        float(run.get("thinking_tokens_used") or 0) for run in category_runs
                    )
                    / len(category_runs),
                    "avg_estimated_cost_usd": sum(
                        float(run.get("estimated_cost_usd") or 0.0) for run in category_runs
                    )
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
