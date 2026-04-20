#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import contextlib
import importlib
import importlib.metadata
import json
import os
import sys
from dataclasses import dataclass
from typing import Any

from agora.sdk import AgoraArbitrator

DEFAULT_API_URL = "https://agora-api-dcro4pg6ca-uc.a.run.app"
DEFAULT_PROMPT = (
    "Should we use a monolith or microservices for a small internal tool?"
)


@dataclass(frozen=True)
class SmokeConfig:
    api_url: str
    auth_token: str
    prompt: str
    mechanism: str | None
    agent_count: int
    allow_mechanism_switch: bool
    allow_offline_fallback: bool
    quorum_threshold: float


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _default_api_url() -> str:
    return os.getenv("AGORA_API_URL", DEFAULT_API_URL).rstrip("/")


def _default_prompt() -> str:
    return os.getenv("AGORA_PHASE2_SMOKE_PROMPT", DEFAULT_PROMPT).strip()


def _build_config(args: argparse.Namespace) -> SmokeConfig:
    auth_token = args.auth_token.strip()
    if not auth_token:
        raise RuntimeError(
            "AGORA_API_KEY is required. Set it in /home/zahemen/projects/dl-lib/agora/.env "
            "or pass --auth-token explicitly."
        )
    if args.agent_count < 1:
        raise RuntimeError("--agent-count must be >= 1")
    if args.quorum_threshold < 0.0 or args.quorum_threshold > 1.0:
        raise RuntimeError("--quorum-threshold must be between 0.0 and 1.0")
    return SmokeConfig(
        api_url=args.api_url.rstrip("/"),
        auth_token=auth_token,
        prompt=args.prompt.strip(),
        mechanism=args.mechanism,
        agent_count=args.agent_count,
        allow_mechanism_switch=args.allow_mechanism_switch,
        allow_offline_fallback=args.allow_offline_fallback,
        quorum_threshold=args.quorum_threshold,
    )


def _parse_args(argv: list[str] | None = None) -> SmokeConfig:
    parser = argparse.ArgumentParser(
        description="Install agora-sdk, run a simple hosted arbitration prompt, and print the result."
    )
    parser.add_argument("--api-url", default=_default_api_url())
    parser.add_argument("--auth-token", default=os.getenv("AGORA_API_KEY", ""))
    parser.add_argument("--prompt", default=_default_prompt())
    parser.add_argument(
        "--mechanism",
        choices=["debate", "vote"],
        default=os.getenv("AGORA_PHASE2_SMOKE_MECHANISM", "vote").strip() or "vote",
    )
    parser.add_argument(
        "--agent-count",
        type=int,
        default=int(os.getenv("AGORA_PHASE2_SMOKE_AGENT_COUNT", "4")),
    )
    parser.add_argument(
        "--allow-mechanism-switch",
        action=argparse.BooleanOptionalAction,
        default=_bool_env("AGORA_PHASE2_ALLOW_MECHANISM_SWITCH", True),
    )
    parser.add_argument(
        "--allow-offline-fallback",
        action=argparse.BooleanOptionalAction,
        default=_bool_env("AGORA_PHASE2_ALLOW_OFFLINE_FALLBACK", False),
    )
    parser.add_argument(
        "--quorum-threshold",
        type=float,
        default=float(os.getenv("AGORA_PHASE2_QUORUM_THRESHOLD", "0.6")),
    )
    return _build_config(parser.parse_args(argv))


def _installed_sdk_version() -> str:
    try:
        return importlib.metadata.version("agora-sdk")
    except importlib.metadata.PackageNotFoundError:
        return "uninstalled"


def _build_report(
    *,
    config: SmokeConfig,
    result: Any,
    verification: dict[str, bool | None],
) -> dict[str, Any]:
    agora_module = importlib.import_module("agora")
    result_payload = result.model_dump(mode="json", exclude_none=True)
    model_telemetry = result_payload.get("model_telemetry", {})
    summary = {
        "mechanism_used": result_payload.get("mechanism_used"),
        "final_answer": result_payload.get("final_answer"),
        "confidence": result_payload.get("confidence"),
        "merkle_root": result_payload.get("merkle_root"),
        "decision_hash": result_payload.get("decision_hash"),
        "total_tokens_used": result_payload.get("total_tokens_used"),
        "total_latency_ms": result_payload.get("total_latency_ms"),
        "model_count": len(result_payload.get("agent_models_used") or []),
        "model_telemetry_models": sorted(model_telemetry.keys()),
    }
    return {
        "sdk": {
            "package_version": _installed_sdk_version(),
            "python_executable": sys.executable,
            "agora_module_path": str(getattr(agora_module, "__file__", "")),
        },
        "request": {
            "api_url": config.api_url,
            "prompt": config.prompt,
            "mechanism": config.mechanism,
            "agent_count": config.agent_count,
            "allow_mechanism_switch": config.allow_mechanism_switch,
            "allow_offline_fallback": config.allow_offline_fallback,
            "quorum_threshold": config.quorum_threshold,
        },
        "summary": summary,
        "receipt_verification": verification,
        "result": result_payload,
    }


def _format_stream_event(event: dict[str, Any]) -> str:
    event_name = str(event.get("event", "message"))
    timestamp = event.get("timestamp")
    data = event.get("data")
    if isinstance(data, dict):
        for key in ("content", "answer", "message", "reasoning", "defense", "question"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                prefix = f"[stream] {event_name}"
                if timestamp:
                    prefix = f"[stream] {timestamp} {event_name}"
                return f"{prefix}: {value.strip()}"
    payload = json.dumps(data, sort_keys=True, ensure_ascii=False)
    if timestamp:
        return f"[stream] {timestamp} {event_name}: {payload}"
    return f"[stream] {event_name}: {payload}"


async def _consume_task_stream(arbitrator: AgoraArbitrator, task_id: str) -> None:
    async for event in arbitrator.stream_task_events(task_id):
        print(_format_stream_event(event))
        if event.get("event") == "error":
            raise RuntimeError(f"Hosted task failed: {json.dumps(event.get('data', {}), sort_keys=True)}")
        if event.get("event") == "complete":
            return


async def _run(config: SmokeConfig) -> dict[str, Any]:
    async with AgoraArbitrator(
        api_url=config.api_url,
        auth_token=config.auth_token,
        mechanism=config.mechanism,
        agent_count=config.agent_count,
        allow_mechanism_switch=config.allow_mechanism_switch,
        allow_offline_fallback=config.allow_offline_fallback,
        quorum_threshold=config.quorum_threshold,
        strict_verification=False,
    ) as arbitrator:
        created = await arbitrator.create_task(
            config.prompt,
            mechanism=config.mechanism,
            agent_count=config.agent_count,
            allow_mechanism_switch=config.allow_mechanism_switch,
            allow_offline_fallback=config.allow_offline_fallback,
            quorum_threshold=config.quorum_threshold,
        )
        print(f"[sdk] created task_id: {created.task_id}")
        stream_task = asyncio.create_task(_consume_task_stream(arbitrator, created.task_id))
        try:
            await arbitrator.start_task_run(created.task_id)
            await stream_task
        finally:
            if not stream_task.done():
                stream_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await stream_task

        result = await arbitrator.get_task_result(created.task_id)
        verification = await arbitrator.verify_receipt(
            result,
            strict=False,
            task_id=created.task_id,
        )
        if not verification.get("valid"):
            raise RuntimeError(f"Receipt verification failed: {verification}")
        return _build_report(config=config, result=result, verification=verification)


def main(argv: list[str] | None = None) -> int:
    config = _parse_args(argv)

    print(f"[sdk] agora-sdk version: {_installed_sdk_version()}")
    print(f"[sdk] python: {sys.executable}")
    print(f"[sdk] api_url: {config.api_url}")
    print(f"[sdk] prompt: {config.prompt}")

    report = asyncio.run(_run(config))
    print("[sdk] final json payload:")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
