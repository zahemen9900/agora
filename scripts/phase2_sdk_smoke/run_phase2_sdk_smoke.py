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

from agora.sdk import AgoraArbitrator, HostedTaskExecutionError

PACKAGE_NAME = "agora-arbitrator-sdk"
DEFAULT_PROMPT = (
    "Should we use a monolith or microservices for a small internal tool?"
)


@dataclass(frozen=True)
class SmokeConfig:
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


def _default_prompt() -> str:
    return os.getenv("AGORA_PHASE2_SMOKE_PROMPT", DEFAULT_PROMPT).strip()


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default

    try:
        return int(raw.strip())
    except ValueError as exc:
        raise ValueError(f"{name} must be a valid integer, got: {raw!r}") from exc


def _float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default

    try:
        return float(raw.strip())
    except ValueError as exc:
        raise ValueError(f"{name} must be a valid float, got: {raw!r}") from exc


def _build_config(args: argparse.Namespace) -> SmokeConfig:
    auth_token = args.auth_token.strip()
    if not auth_token:
        raise RuntimeError(
            "AGORA_API_KEY is required. Set it in the environment, in a .env file, "
            "or pass --auth-token explicitly."
        )
    if args.agent_count < 1:
        raise RuntimeError("--agent-count must be >= 1")
    if args.quorum_threshold < 0.0 or args.quorum_threshold > 1.0:
        raise RuntimeError("--quorum-threshold must be between 0.0 and 1.0")
    return SmokeConfig(
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
        description=(
            "Install agora-arbitrator-sdk, run a simple hosted arbitration prompt, "
            "and print the result."
        )
    )
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
        default=_int_env("AGORA_PHASE2_SMOKE_AGENT_COUNT", 3),
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
        default=_float_env("AGORA_PHASE2_QUORUM_THRESHOLD", 0.6),
    )
    return _build_config(parser.parse_args(argv))


def _installed_sdk_version() -> str:
    try:
        return importlib.metadata.version(PACKAGE_NAME)
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
    provider_health = _build_provider_health(result_payload)
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
        "execution_mode": result_payload.get("execution_mode"),
        "fallback_count": result_payload.get("fallback_count"),
        "provider_health_status": provider_health["status"],
    }
    return {
        "sdk": {
            "package_version": _installed_sdk_version(),
            "python_executable": sys.executable,
            "agora_module_path": str(getattr(agora_module, "__file__", "")),
        },
        "request": {
            "prompt": config.prompt,
            "mechanism": config.mechanism,
            "agent_count": config.agent_count,
            "allow_mechanism_switch": config.allow_mechanism_switch,
            "allow_offline_fallback": config.allow_offline_fallback,
            "quorum_threshold": config.quorum_threshold,
        },
        "summary": summary,
        "provider_health": provider_health,
        "receipt_verification": verification,
        "result": result_payload,
    }


def _build_provider_health(result_payload: dict[str, Any]) -> dict[str, Any]:
    fallback_events = result_payload.get("fallback_events")
    normalized_events = fallback_events if isinstance(fallback_events, list) else []
    fallback_reasons = sorted(
        {
            str(event.get("reason", "")).strip()
            for event in normalized_events
            if isinstance(event, dict) and str(event.get("reason", "")).strip()
        }
    )
    execution_mode = str(result_payload.get("execution_mode") or "unknown")
    fallback_count = int(result_payload.get("fallback_count") or 0)
    used_fallback = execution_mode != "live" or fallback_count > 0
    status = "fallback_execution" if used_fallback else "live_provider_execution"
    return {
        "status": status,
        "execution_mode": execution_mode,
        "fallback_count": fallback_count,
        "fallback_reasons": fallback_reasons,
        "agent_models_used": list(result_payload.get("agent_models_used") or []),
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


def _print_provider_health(report: dict[str, Any]) -> None:
    provider_health = report.get("provider_health")
    if not isinstance(provider_health, dict):
        return

    status = str(provider_health.get("status") or "unknown")
    execution_mode = str(provider_health.get("execution_mode") or "unknown")
    fallback_count = int(provider_health.get("fallback_count") or 0)
    fallback_reasons = provider_health.get("fallback_reasons")
    if not isinstance(fallback_reasons, list):
        fallback_reasons = []

    if status == "live_provider_execution":
        print("[sdk] provider health: live provider execution confirmed")
    else:
        print("[sdk] provider health: fallback execution detected")
    print(f"[sdk] execution_mode: {execution_mode}")
    print(f"[sdk] fallback_count: {fallback_count}")
    if fallback_reasons:
        print(f"[sdk] fallback_reasons: {', '.join(str(reason) for reason in fallback_reasons)}")


async def _run(config: SmokeConfig) -> dict[str, Any]:
    async with AgoraArbitrator(
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
        await arbitrator.start_task_run(created.task_id)
        stream_task = asyncio.create_task(_consume_task_stream(arbitrator, created.task_id))
        try:
            result = await arbitrator.wait_for_task_result(created.task_id)
        finally:
            if not stream_task.done():
                stream_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await stream_task
            else:
                await stream_task
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

    print(f"[sdk] {PACKAGE_NAME} version: {_installed_sdk_version()}")
    print(f"[sdk] python: {sys.executable}")
    print(f"[sdk] prompt: {config.prompt}")

    try:
        report = asyncio.run(_run(config))
    except HostedTaskExecutionError as exc:
        print(f"[sdk] hosted task failed: {exc.failure_reason or exc.status}")
        if exc.latest_error_event:
            print("[sdk] latest error event:")
            print(json.dumps(exc.latest_error_event, indent=2, sort_keys=True))
        raise
    _print_provider_health(report)
    print("[sdk] final json payload:")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
