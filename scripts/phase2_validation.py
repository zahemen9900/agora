#!/usr/bin/env python3
"""Run the Phase 2 validation harness and write the benchmark artifact."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from agora.runtime.orchestrator import AgoraOrchestrator  # noqa: E402
from benchmarks.runner import BenchmarkRunner  # noqa: E402


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        default="benchmarks/results/phase2_validation.json",
        help="Output path for the benchmark artifact.",
    )
    parser.add_argument(
        "--training-per-category",
        type=int,
        default=6,
        help="Number of training tasks per category.",
    )
    parser.add_argument(
        "--holdout-per-category",
        type=int,
        default=2,
        help="Number of holdout tasks per category.",
    )
    parser.add_argument(
        "--agent-count",
        type=int,
        default=3,
        help="Agent count for the orchestrator validation runs.",
    )
    parser.add_argument(
        "--bandit-state-path",
        default=None,
        help="Optional path for persisted bandit state.",
    )
    parser.add_argument(
        "--live-agents",
        action="store_true",
        help="Use configured live model providers instead of deterministic local agents.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Base RNG seed used for deterministic validation runs in offline mode.",
    )
    return parser.parse_args()


async def _offline_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
    """Deterministic local agent used by default for reproducible validation."""

    del system_prompt
    lowered = user_prompt.lower()
    if "capital of france" in lowered:
        answer = "Paris"
    elif "solana" in lowered and "btc" in lowered:
        answer = "BTC"
    elif "derivative" in lowered and "x^3" in lowered:
        answer = "3x^2"
    elif "2+2" in lowered:
        answer = "4"
    else:
        answer = "Option A"
    return {
        "answer": answer,
        "confidence": 0.84,
        "predicted_group_answer": answer,
        "reasoning": "Deterministic offline validation agent.",
    }


async def _run_validation(args: argparse.Namespace) -> dict[str, Any]:
    training_tasks, holdout_tasks = BenchmarkRunner.build_phase2_task_split(
        training_per_category=args.training_per_category,
        holdout_per_category=args.holdout_per_category,
    )
    orchestrator = AgoraOrchestrator(
        agent_count=args.agent_count,
        bandit_state_path=args.bandit_state_path,
    )
    agents = None if args.live_agents else [_offline_agent] * args.agent_count
    deterministic_seed = None if args.live_agents else args.seed
    runner = BenchmarkRunner(orchestrator, agents=agents)
    return await runner.run_phase2_validation(
        training_tasks=training_tasks,
        holdout_tasks=holdout_tasks,
        output_path=args.output,
        seed=deterministic_seed,
    )


def main() -> None:
    args = _parse_args()
    payload = asyncio.run(_run_validation(args))
    output_path = Path(args.output)
    print(
        json.dumps(
            {
                "output_path": str(output_path.resolve()),
                "training_runs": len(payload["pre_learning"]["runs"]),
                "holdout_runs": len(payload["post_learning"]["runs"]),
                "seed": None if args.live_agents else args.seed,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
