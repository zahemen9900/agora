"""Run a live Agora deliberation and print a proof-of-work summary.

This demo is designed to mirror the proof output Joshua saw from Dave's slice,
but it forces the runtime onto Claude-only model settings so it can run with
just `ANTHROPIC_API_KEY`.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
from datetime import UTC


def _configure_claude_only_defaults() -> None:
    """Ensure the runtime uses Anthropic-backed models instead of Gemini."""

    os.environ.setdefault("AGORA_FLASH_MODEL", "claude-sonnet-4-6")
    os.environ.setdefault("AGORA_PRO_MODEL", "claude-sonnet-4-6")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a live Agora demo task.")
    parser.add_argument(
        "task",
        nargs="?",
        default="What is the capital of France?",
        help="Task text to run through the deliberation pipeline.",
    )
    parser.add_argument(
        "--agent-count",
        type=int,
        default=3,
        help="Number of agents to use for the demo run.",
    )
    parser.add_argument(
        "--gcloud-project",
        default="even-ally-480821-f3",
        help="Google Cloud project used to look up the Anthropic secret.",
    )
    parser.add_argument(
        "--secret-name",
        default="ANTHROPIC_API_KEY",
        help="Secret Manager secret name for the Anthropic key.",
    )
    return parser


def _try_load_anthropic_key_from_gcloud(project_id: str, secret_name: str) -> None:
    """Populate ANTHROPIC_API_KEY from Google Cloud Secret Manager when available."""

    if os.getenv("ANTHROPIC_API_KEY"):
        return

    gcloud = os.getenv("GCLOUD_BIN", "gcloud")
    try:
        completed = subprocess.run(
            [
                gcloud,
                "secrets",
                "versions",
                "access",
                "latest",
                "--project",
                project_id,
                "--secret",
                secret_name,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return
    except subprocess.CalledProcessError:
        return

    secret = completed.stdout.strip()
    if secret:
        os.environ["ANTHROPIC_API_KEY"] = secret


async def _run(task: str, agent_count: int) -> None:
    from agora.runtime.orchestrator import AgoraOrchestrator

    orchestrator = AgoraOrchestrator(agent_count=agent_count)
    result = await orchestrator.run(task)

    print(f"TASK={task}")
    print(f"MECHANISM={result.mechanism_used.value}")
    print(f"FINAL_ANSWER={result.final_answer}")
    print(f"CONFIDENCE={result.confidence}")
    print(f"TOKENS_USED={result.total_tokens_used}")
    print(f"LATENCY_MS={round(result.total_latency_ms, 2)}")
    print(f"QUORUM={result.quorum_reached}")
    print(f"ROUND_COUNT={result.round_count}")
    print(f"MECHANISM_SWITCHES={result.mechanism_switches}")
    print(f"MERKLE_ROOT={result.merkle_root}")
    print(f"REASONING_HASH={result.mechanism_selection.reasoning_hash}")
    print(f"TIMESTAMP={result.timestamp.astimezone(UTC).isoformat()}")


def main() -> None:
    _configure_claude_only_defaults()

    args = _build_parser().parse_args()
    _try_load_anthropic_key_from_gcloud(
        project_id=args.gcloud_project,
        secret_name=args.secret_name,
    )

    if not os.getenv("ANTHROPIC_API_KEY"):
        raise SystemExit(
            "ANTHROPIC_API_KEY is missing. Set it from your GCloud secret store "
            "before running this demo."
        )

    asyncio.run(_run(task=args.task, agent_count=args.agent_count))


if __name__ == "__main__":
    main()
