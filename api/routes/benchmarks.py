"""Benchmark summary and orchestration API endpoints."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from agora.runtime.orchestrator import AgoraOrchestrator
from api.auth import AuthenticatedUser, get_current_user, require_human_user
from api.config import settings
from api.models import (
    BenchmarkCatalogEntry,
    BenchmarkCatalogResponse,
    BenchmarkRunRequest,
    BenchmarkRunResponse,
    BenchmarkRunStatusResponse,
)
from api.routes.tasks import get_task_store
from api.security import validate_storage_id
from benchmarks.runner import BenchmarkRunner

router = APIRouter()
_optional_bearer = HTTPBearer(auto_error=False)

_RESULTS_DIR = Path(__file__).resolve().parents[2] / "benchmarks" / "results"
_RESULTS_PATH = _RESULTS_DIR / "phase2_validation.json"
_LEGACY_ARTIFACT_RE = re.compile(r"[^a-zA-Z0-9._-]+")
_RUN_STATUS_VALUES = {"queued", "running", "completed", "failed"}

_background_benchmark_runs: dict[str, asyncio.Task[None]] = {}
_legacy_backfill_complete = False
_legacy_backfill_lock: asyncio.Lock | None = None


def _get_legacy_backfill_lock() -> asyncio.Lock:
    global _legacy_backfill_lock
    if _legacy_backfill_lock is None:
        _legacy_backfill_lock = asyncio.Lock()
    return _legacy_backfill_lock


def _load_json_payload(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        return payload
    return None


def _latest_demo_results_path() -> Path | None:
    candidates = sorted(
        _RESULTS_DIR.glob("phase2_demo*.json"),
        key=lambda candidate: candidate.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        return None

    local_candidates = [candidate for candidate in candidates if "_local_" in candidate.name]
    return local_candidates[0] if local_candidates else candidates[0]


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


def _has_non_empty_runs(value: Any) -> bool:
    return isinstance(value, list) and len(value) > 0


def _payload_has_any_runs(payload: dict[str, Any]) -> bool:
    if _has_non_empty_runs(payload.get("runs")):
        return True

    for stage_key in ("post_learning", "pre_learning", "learning_updates"):
        stage_payload = _as_dict(payload.get(stage_key))
        if _has_non_empty_runs(stage_payload.get("runs")):
            return True

    return False


def _build_demo_report(demo_payload: dict[str, Any], artifact_name: str) -> dict[str, Any]:
    sdk_flow = _as_dict(demo_payload.get("sdk_flow"))
    status_after_run = _as_dict(sdk_flow.get("status_after_run"))
    status_after_pay = _as_dict(sdk_flow.get("status_after_pay"))
    run_result = _as_dict(sdk_flow.get("run_result")) or _as_dict(status_after_run.get("result"))

    return {
        "artifact": artifact_name,
        "status": demo_payload.get("status"),
        "final_status": demo_payload.get("final_status"),
        "target": demo_payload.get("target"),
        "query": demo_payload.get("query"),
        "mechanism": demo_payload.get("mechanism"),
        "agent_count": demo_payload.get("agent_count"),
        "stakes": demo_payload.get("stakes"),
        "started_at": demo_payload.get("started_at"),
        "completed_at": demo_payload.get("completed_at"),
        "run_summary": _as_dict(demo_payload.get("run_summary")),
        "tx_summary": _as_dict(demo_payload.get("tx_summary")),
        "acceptance_checks": _as_dict(demo_payload.get("acceptance_checks")),
        "run_result": run_result,
        "status_after_run": status_after_run,
        "status_after_pay": status_after_pay,
    }


def _synthesize_demo_runs(demo_payload: dict[str, Any]) -> list[dict[str, Any]]:
    sdk_flow = _as_dict(demo_payload.get("sdk_flow"))
    status_after_run = _as_dict(sdk_flow.get("status_after_run"))
    status_after_pay = _as_dict(sdk_flow.get("status_after_pay"))
    run_result = _as_dict(sdk_flow.get("run_result")) or _as_dict(status_after_run.get("result"))
    tx_summary = _as_dict(demo_payload.get("tx_summary"))

    task_id = status_after_run.get("task_id") or status_after_pay.get("task_id")
    task_text = status_after_run.get("task_text") or demo_payload.get("query") or "Benchmark demo run"
    mode = run_result.get("mechanism") or status_after_run.get("mechanism") or demo_payload.get("mechanism")
    merkle_root = run_result.get("merkle_root") or status_after_run.get("merkle_root")
    explorer_url = status_after_run.get("explorer_url") or tx_summary.get("receipt_explorer_url")
    latency_ms = run_result.get("latency_ms")

    if not any([task_id, task_text, mode, merkle_root, explorer_url, latency_ms]):
        return []

    return [
        {
            "task_id": task_id,
            "task": task_text,
            "category": "demo",
            "mode": mode or "selector",
            "latency_ms": latency_ms,
            "merkle_root": merkle_root,
            "explorer_url": explorer_url,
            "confidence": run_result.get("confidence"),
            "final_answer": run_result.get("final_answer"),
            "status": status_after_pay.get("status")
            or status_after_run.get("status")
            or demo_payload.get("final_status"),
            "agent_models_used": run_result.get("agent_models_used"),
        }
    ]


def _run_status(value: str | None) -> Literal["queued", "running", "completed", "failed"]:
    candidate = (value or "").strip().lower()
    if candidate in _RUN_STATUS_VALUES:
        return candidate  # type: ignore[return-value]
    return "failed"


def _parse_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value.strip():
        candidate = value.strip().replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(candidate)
        except ValueError:
            pass
    return datetime.now(UTC)


def _extract_runs(payload: dict[str, Any]) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    direct_runs = payload.get("runs")
    if isinstance(direct_runs, list):
        runs.extend([run for run in direct_runs if isinstance(run, dict)])

    for stage_key in ("post_learning", "pre_learning", "learning_updates"):
        stage_payload = _as_dict(payload.get(stage_key))
        stage_runs = stage_payload.get("runs")
        if isinstance(stage_runs, list):
            runs.extend([run for run in stage_runs if isinstance(run, dict)])

    demo_report = _as_dict(payload.get("demo_report"))
    run_result = _as_dict(demo_report.get("run_result"))
    if run_result:
        runs.append(
            {
                "mechanism_used": run_result.get("mechanism") or demo_report.get("mechanism"),
                "model": run_result.get("model"),
                "agent_models_used": run_result.get("agent_models_used"),
            }
        )

    return runs


def _extract_model_names(run: dict[str, Any]) -> list[str]:
    discovered: list[str] = []

    for key in ("model", "agent_model"):
        value = run.get(key)
        if isinstance(value, str):
            candidate = value.strip()
            if candidate and candidate not in discovered:
                discovered.append(candidate)

    for key in ("agent_models_used", "models"):
        value = run.get(key)
        if isinstance(value, list):
            for item in value:
                if isinstance(item, str):
                    candidate = item.strip()
                    if candidate and candidate not in discovered:
                        discovered.append(candidate)

    return discovered


def _frequency_from_runs(runs: list[dict[str, Any]]) -> tuple[dict[str, int], dict[str, int], int]:
    mechanism_counter: Counter[str] = Counter()
    model_counter: Counter[str] = Counter()

    for run in runs:
        mechanism = (
            str(
                run.get("mechanism_used")
                or run.get("mechanism")
                or run.get("mode")
                or ""
            )
            .strip()
            .lower()
        )
        if mechanism:
            mechanism_counter[mechanism] += 1

        for model_name in _extract_model_names(run):
            model_counter[model_name] += 1

    mechanism_counts = dict(mechanism_counter)
    model_counts = dict(model_counter)
    frequency_score = sum(mechanism_counts.values()) + sum(model_counts.values())
    return mechanism_counts, model_counts, frequency_score


def _artifact_payload(artifact: dict[str, Any]) -> dict[str, Any]:
    payload = artifact.get("benchmark_payload")
    if isinstance(payload, dict):
        return payload

    legacy_payload = artifact.get("payload")
    if isinstance(legacy_payload, dict):
        return legacy_payload

    # Legacy artifacts may be raw benchmark payloads without wrappers.
    return artifact


def _to_catalog_entry(
    artifact: dict[str, Any],
    *,
    default_scope: Literal["global", "user"],
) -> BenchmarkCatalogEntry | None:
    artifact_id = str(artifact.get("artifact_id") or artifact.get("run_id") or "").strip()
    if not artifact_id:
        return None
    try:
        validate_storage_id(artifact_id, field_name="artifact_id")
    except ValueError:
        return None

    payload = _artifact_payload(artifact)
    runs = _extract_runs(payload)
    mechanism_counts, model_counts, frequency_score = _frequency_from_runs(runs)

    scope_value = str(artifact.get("scope") or default_scope).strip().lower()
    scope: Literal["global", "user"] = "user" if scope_value == "user" else "global"

    owner_user_id = artifact.get("owner_user_id")
    owner = str(owner_user_id).strip() if isinstance(owner_user_id, str) and owner_user_id.strip() else None

    return BenchmarkCatalogEntry(
        artifact_id=artifact_id,
        scope=scope,
        owner_user_id=owner,
        source=str(artifact.get("source") or "unknown"),
        created_at=_parse_timestamp(
            artifact.get("created_at")
            or payload.get("generated_at")
            or datetime.now(UTC).isoformat()
        ),
        run_count=len(runs),
        mechanism_counts=mechanism_counts,
        model_counts=model_counts,
        frequency_score=frequency_score,
        status=str(artifact.get("status")) if artifact.get("status") is not None else None,
    )


def _to_run_status(record: dict[str, Any], *, run_id_fallback: str | None = None) -> BenchmarkRunStatusResponse | None:
    run_id = str(record.get("run_id") or run_id_fallback or "").strip()
    if not run_id:
        return None

    artifact_id = record.get("artifact_id")
    artifact = str(artifact_id).strip() if isinstance(artifact_id, str) and artifact_id.strip() else None
    error = record.get("error")
    error_text = str(error).strip() if error is not None else None

    return BenchmarkRunStatusResponse(
        run_id=run_id,
        status=_run_status(str(record.get("status") or "failed")),
        created_at=_parse_timestamp(record.get("created_at")),
        updated_at=_parse_timestamp(record.get("updated_at") or record.get("created_at")),
        error=error_text,
        artifact_id=artifact,
    )


def _test_frequency_score(record: dict[str, Any]) -> int:
    raw_score = record.get("frequency_score")
    if isinstance(raw_score, int):
        return max(raw_score, 0)
    if isinstance(raw_score, float):
        return max(int(raw_score), 0)

    score = 0
    for key in ("mechanism_counts", "model_counts"):
        value = record.get(key)
        if not isinstance(value, dict):
            continue
        for count in value.values():
            if isinstance(count, int):
                score += max(count, 0)
            elif isinstance(count, float):
                score += max(int(count), 0)
    return score


def _legacy_artifact_id(path: Path) -> str:
    candidate = _LEGACY_ARTIFACT_RE.sub("-", path.stem.lower()).strip("-.")
    if not candidate:
        candidate = hashlib.sha256(path.name.encode("utf-8")).hexdigest()[:16]
    artifact_id = f"legacy-{candidate}"[:120]
    try:
        validate_storage_id(artifact_id, field_name="artifact_id")
    except ValueError:
        artifact_id = f"legacy-{hashlib.sha256(path.name.encode('utf-8')).hexdigest()[:24]}"
    return artifact_id


def _legacy_artifact_document(path: Path, payload: dict[str, Any], artifact_id: str) -> dict[str, Any]:
    created_at = payload.get("generated_at")
    if not isinstance(created_at, str) or not created_at.strip():
        created_at = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC).isoformat()

    return {
        "artifact_id": artifact_id,
        "scope": "global",
        "source": "legacy_backfill",
        "status": "completed",
        "created_at": created_at,
        "benchmark_payload": payload,
    }


async def _maybe_backfill_legacy_benchmarks() -> None:
    global _legacy_backfill_complete
    if _legacy_backfill_complete:
        return

    lock = _get_legacy_backfill_lock()
    async with lock:
        if _legacy_backfill_complete:
            return

        store = get_task_store()
        existing = await store.list_global_benchmark_artifacts(limit=500)
        existing_ids = {
            str(item.get("artifact_id"))
            for item in existing
            if isinstance(item, dict) and item.get("artifact_id")
        }

        for path in sorted(_RESULTS_DIR.glob("phase2*.json"), key=lambda candidate: candidate.stat().st_mtime):
            payload = _load_json_payload(path)
            if payload is None:
                continue

            artifact_id = _legacy_artifact_id(path)
            if artifact_id in existing_ids:
                continue

            await store.save_global_benchmark_artifact(
                artifact_id,
                _legacy_artifact_document(path, payload, artifact_id),
            )
            existing_ids.add(artifact_id)

        _legacy_backfill_complete = True


def _build_run_id(workspace_id: str) -> str:
    payload = f"{workspace_id}:{datetime.now(UTC).isoformat()}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


async def _offline_agent(system_prompt: str, user_prompt: str) -> dict[str, object]:
    """Deterministic fallback agent for reproducible benchmark triggers."""

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
        "reasoning": "Deterministic benchmark fallback agent.",
    }


async def _execute_benchmark_run(
    *,
    workspace_id: str,
    run_id: str,
    request: BenchmarkRunRequest,
) -> None:
    store = get_task_store()
    updated_at = datetime.now(UTC).isoformat()

    running_record = await store.get_user_test_result(workspace_id, run_id) or {}
    running_record.update(
        {
            "run_id": run_id,
            "workspace_id": workspace_id,
            "kind": "benchmark",
            "status": "running",
            "updated_at": updated_at,
        }
    )
    await store.save_user_test_result(workspace_id, run_id, running_record)

    try:
        training_tasks, holdout_tasks = BenchmarkRunner.build_phase2_task_split(
            training_per_category=request.training_per_category,
            holdout_per_category=request.holdout_per_category,
        )

        orchestrator = AgoraOrchestrator(agent_count=request.agent_count)
        agents = None if request.live_agents else [_offline_agent] * request.agent_count
        seed = None if request.live_agents else request.seed
        runner = BenchmarkRunner(orchestrator, agents=agents)

        output_path = _RESULTS_DIR / f"user_benchmark_{run_id}.json"
        payload = await runner.run_phase2_validation(
            training_tasks=training_tasks,
            holdout_tasks=holdout_tasks,
            output_path=str(output_path),
            seed=seed,
        )

        created_at = datetime.now(UTC).isoformat()
        artifact_document = {
            "artifact_id": run_id,
            "scope": "global",
            "source": "user_triggered",
            "status": "completed",
            "owner_user_id": workspace_id,
            "created_at": created_at,
            "benchmark_payload": payload,
        }

        user_artifact_document = dict(artifact_document)
        user_artifact_document["scope"] = "user"

        await store.save_global_benchmark_artifact(run_id, artifact_document)
        await store.save_user_benchmark_artifact(workspace_id, run_id, user_artifact_document)

        runs = _extract_runs(payload)
        mechanism_counts, model_counts, frequency_score = _frequency_from_runs(runs)

        completed_at = datetime.now(UTC).isoformat()
        completed_record = await store.get_user_test_result(workspace_id, run_id) or {}
        completed_record.update(
            {
                "run_id": run_id,
                "workspace_id": workspace_id,
                "kind": "benchmark",
                "status": "completed",
                "artifact_id": run_id,
                "mechanism_counts": mechanism_counts,
                "model_counts": model_counts,
                "frequency_score": frequency_score,
                "updated_at": completed_at,
            }
        )
        await store.save_user_test_result(workspace_id, run_id, completed_record)
    except Exception as exc:
        failed_at = datetime.now(UTC).isoformat()
        failed_record = await store.get_user_test_result(workspace_id, run_id) or {}
        failed_record.update(
            {
                "run_id": run_id,
                "workspace_id": workspace_id,
                "kind": "benchmark",
                "status": "failed",
                "error": str(exc)[:1000],
                "updated_at": failed_at,
            }
        )
        await store.save_user_test_result(workspace_id, run_id, failed_record)


async def _optional_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_optional_bearer),
) -> AuthenticatedUser | None:
    if credentials is None:
        return None
    return await get_current_user(credentials)


CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]


@router.get("/benchmarks")
async def get_benchmarks(
    user: AuthenticatedUser | None = Depends(_optional_current_user),
    x_agora_admin_token: str | None = Header(default=None),
    include_demo: bool = Query(default=False),
) -> dict[str, Any]:
    """Return the latest persisted benchmark summary."""

    has_admin_secret = bool(settings.benchmark_admin_token)
    admin_granted = has_admin_secret and x_agora_admin_token == settings.benchmark_admin_token

    if not admin_granted:
        if user is None:
            raise HTTPException(status_code=403, detail="Benchmark access denied")
        require_human_user(user)

    store = get_task_store()
    summary = await store.get_benchmark_summary()
    payload = summary if isinstance(summary, dict) else _load_json_payload(_RESULTS_PATH)
    if payload is None:
        raise HTTPException(status_code=404, detail="Benchmark summary is not available yet")

    if not include_demo:
        return payload

    demo_path = _latest_demo_results_path()
    if demo_path is None:
        return payload

    demo_payload = _load_json_payload(demo_path)
    if demo_payload is None:
        return payload

    enriched_payload = dict(payload)
    enriched_payload["demo_report"] = _build_demo_report(demo_payload, demo_path.name)

    if not _payload_has_any_runs(enriched_payload):
        demo_runs = _synthesize_demo_runs(demo_payload)
        if demo_runs:
            enriched_payload["runs"] = demo_runs

    if "summary" not in enriched_payload:
        run_summary = _as_dict(demo_payload.get("run_summary"))
        per_mode = run_summary.get("per_mode")
        per_category = run_summary.get("per_category")
        if isinstance(per_mode, dict) and isinstance(per_category, dict):
            enriched_payload["summary"] = {
                "per_mode": per_mode,
                "per_category": per_category,
            }

    return enriched_payload


@router.get("/benchmarks/catalog", response_model=BenchmarkCatalogResponse)
async def get_benchmark_catalog(
    user: CurrentUser,
    limit: int = Query(default=25, ge=1, le=100),
) -> BenchmarkCatalogResponse:
    """Return global and user benchmark catalog views sorted by recency and frequency."""

    await _maybe_backfill_legacy_benchmarks()
    store = get_task_store()

    global_artifacts = await store.list_global_benchmark_artifacts(limit=limit)
    global_entries = [
        entry
        for artifact in global_artifacts
        if isinstance(artifact, dict)
        for entry in [_to_catalog_entry(artifact, default_scope="global")]
        if entry is not None
    ]

    user_entries: list[BenchmarkCatalogEntry] = []
    tests_recent: list[BenchmarkRunStatusResponse] = []
    tests_frequency: list[BenchmarkRunStatusResponse] = []

    if user.auth_method == "jwt":
        require_human_user(user)
        user_artifacts = await store.list_user_benchmark_artifacts(user.workspace_id, limit=limit)
        user_entries = [
            entry
            for artifact in user_artifacts
            if isinstance(artifact, dict)
            for entry in [_to_catalog_entry(artifact, default_scope="user")]
            if entry is not None
        ]

        test_records = await store.list_user_test_results(user.workspace_id, limit=limit)
        status_pairs = [
            (status, _test_frequency_score(record))
            for record in test_records
            if isinstance(record, dict)
            for status in [_to_run_status(record)]
            if status is not None
        ]

        tests_recent = [
            status
            for status, _score in sorted(
                status_pairs,
                key=lambda pair: pair[0].updated_at,
                reverse=True,
            )
        ]
        tests_frequency = [
            status
            for status, score in sorted(
                status_pairs,
                key=lambda pair: (pair[1], pair[0].updated_at),
                reverse=True,
            )
            if score >= 0
        ]

    global_recent = sorted(global_entries, key=lambda entry: entry.created_at, reverse=True)
    global_frequency = sorted(
        global_entries,
        key=lambda entry: (entry.frequency_score, entry.run_count, entry.created_at),
        reverse=True,
    )
    user_recent = sorted(user_entries, key=lambda entry: entry.created_at, reverse=True)
    user_frequency = sorted(
        user_entries,
        key=lambda entry: (entry.frequency_score, entry.run_count, entry.created_at),
        reverse=True,
    )

    return BenchmarkCatalogResponse(
        global_recent=global_recent,
        global_frequency=global_frequency,
        user_recent=user_recent,
        user_frequency=user_frequency,
        user_tests_recent=tests_recent,
        user_tests_frequency=tests_frequency,
    )


@router.post("/benchmarks/run", response_model=BenchmarkRunResponse)
async def trigger_benchmark_run(
    request: BenchmarkRunRequest,
    user: CurrentUser,
) -> BenchmarkRunResponse:
    """Trigger an async benchmark run and persist status in user test records."""

    require_human_user(user)
    store = get_task_store()
    run_id = _build_run_id(user.workspace_id)
    created_at = datetime.now(UTC)

    await store.save_user_test_result(
        user.workspace_id,
        run_id,
        {
            "run_id": run_id,
            "workspace_id": user.workspace_id,
            "kind": "benchmark",
            "status": "queued",
            "created_at": created_at.isoformat(),
            "updated_at": created_at.isoformat(),
            "request": request.model_dump(mode="json"),
            "label": "User-triggered benchmark",
        },
    )

    task = asyncio.create_task(
        _execute_benchmark_run(
            workspace_id=user.workspace_id,
            run_id=run_id,
            request=request,
        )
    )
    _background_benchmark_runs[run_id] = task
    task.add_done_callback(lambda _finished: _background_benchmark_runs.pop(run_id, None))

    return BenchmarkRunResponse(
        run_id=run_id,
        status="queued",
        created_at=created_at,
    )


@router.get("/benchmarks/runs/{run_id}", response_model=BenchmarkRunStatusResponse)
async def get_benchmark_run_status(
    run_id: str,
    user: CurrentUser,
) -> BenchmarkRunStatusResponse:
    """Return status for a previously triggered user benchmark run."""

    require_human_user(user)
    store = get_task_store()
    record = await store.get_user_test_result(user.workspace_id, run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Benchmark run not found")

    status = _to_run_status(record, run_id_fallback=run_id)
    if status is None:
        raise HTTPException(status_code=404, detail="Benchmark run not found")
    return status
