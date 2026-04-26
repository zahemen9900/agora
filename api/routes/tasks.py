"""Task API endpoints for persisted orchestration, streaming, and receipts."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Awaitable, Callable
from contextlib import suppress
from datetime import UTC, datetime
from typing import Annotated, Any, cast

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query
from sse_starlette.sse import EventSourceResponse

from agora.runtime.costing import build_model_telemetry, estimate_cost_for_models
from agora.runtime.task_execution import (
    build_pinned_selection,
    execute_task_like_run,
    resolve_task_like_selection,
)
from agora.runtime.model_policy import normalize_tier_model_overrides, resolve_reasoning_presets
from agora.runtime.orchestrator import AgoraOrchestrator
from agora.selector.features import extract_features
from agora.types import (
    SUPPORTED_MECHANISMS,
    CostEstimate,
    DeliberationResult,
    MechanismSelection,
    MechanismType,
    ModelTelemetry,
    mechanism_is_supported,
)
from api.auth import AuthenticatedUser, get_current_user, require_scope
from api.config import settings
from api.coordination import (
    ConcurrencySlotLease,
    RunLockLease,
    StreamTicketRecord,
    get_coordination_backend,
    reset_coordination_state_for_tests,
)
from api.models import (
    BenchmarkCostEstimateResponse,
    ChainOperationRecord,
    DeliberationResultResponse,
    MechanismName,
    ModelTelemetryResponse,
    PaymentStatusName,
    TaskCreateRequest,
    TaskCreateResponse,
    TaskEvent,
    TaskStatusResponse,
)
from api.live_journal import BufferedEventJournal
from api.solana_bridge import LAMPORTS_PER_SOL, bridge
from api.store import TaskStore, get_store
from api.store_local import LocalTaskStore
from api.streaming import DeliberationStream, get_stream_manager

router = APIRouter()
logger = structlog.get_logger(__name__)

_store: TaskStore | LocalTaskStore | None = None
CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]
_SUPPORTED_MECHANISMS_TEXT = ", ".join(
    sorted(mechanism.value for mechanism in SUPPORTED_MECHANISMS)
)
_STREAM_POLL_INTERVAL_SECONDS = 0.15
_STREAM_BUFFER_FLUSH_INTERVAL_SECONDS = 0.1
_STREAM_BUFFER_MAX_EVENTS = 8
_RATE_LIMIT_WINDOW_SECONDS = 60
_INITIALIZE_TASK_OPERATION = "initialize_task"
_RECORD_SELECTION_OPERATION = "record_selection"
_SUBMIT_RECEIPT_OPERATION = "submit_receipt"
_RELEASE_PAYMENT_OPERATION = "release_payment"
_SELECTOR_BANDIT_STATE_KEY = "selector_bandit_state"
_background_task_runs: dict[str, asyncio.Task[None]] = {}
_BUFFERED_TASK_EVENT_TYPES = {
    "agent_output_delta",
    "thinking_delta",
    "usage_delta",
    "cross_examination_delta",
}
_TERMINAL_TASK_EVENT_TYPES = {"complete", "error"}


def get_task_store() -> TaskStore | LocalTaskStore:
    """Resolve task storage lazily so imports do not require cloud credentials."""

    global _store
    if _store is None:
        _store = get_store(
            settings.gcs_bucket if settings.gcs_bucket and settings.google_cloud_project else None,
            local_data_dir=settings.local_data_dir,
        )
    return _store


def _build_task_id(task_text: str) -> str:
    """Build a unique task identifier from content and creation time."""

    payload = f"{task_text}\n{datetime.now(UTC).isoformat()}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _stream_key(workspace_id: str, task_id: str) -> str:
    """Namespace live streams by workspace and task to avoid cross-tenant fan-out."""

    return f"{workspace_id}:{task_id}"


def _task_run_key(workspace_id: str, task_id: str) -> str:
    return _stream_key(workspace_id, task_id)


def _task_payment_key(workspace_id: str, task_id: str) -> str:
    return f"payment-release:{_stream_key(workspace_id, task_id)}"


def _workspace_run_bucket_key(workspace_id: str) -> str:
    """Namespace concurrent execution slots by workspace."""

    return f"workspace-run:{workspace_id}"


def _mechanism_name(mechanism: MechanismType) -> MechanismName:
    """Convert a supported runtime mechanism enum into the public API literal."""

    return cast(MechanismName, mechanism.value)


def _assert_task_owner(raw_task: dict[str, Any], workspace_id: str) -> None:
    """Reject task records that are explicitly owned by another workspace."""

    task_workspace_id = raw_task.get("workspace_id")
    if task_workspace_id and task_workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="Task not found")
    created_by = raw_task.get("created_by")
    if not task_workspace_id and created_by and created_by != workspace_id:
        raise HTTPException(status_code=404, detail="Task not found")


async def _load_task_for_user(
    store: TaskStore | LocalTaskStore,
    workspace_id: str,
    task_id: str,
) -> dict[str, Any]:
    """Load a task while hiding unsafe IDs and cross-tenant records as not-found."""

    try:
        raw_task = await store.get_task(workspace_id, task_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Task not found") from exc
    if raw_task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    _assert_task_owner(raw_task, workspace_id)
    return raw_task


async def _issue_stream_ticket(workspace_id: str, task_id: str) -> dict[str, str]:
    """Create a short-lived one-use ticket for EventSource auth."""

    ticket, expires_at = await get_coordination_backend().issue_stream_ticket(
        workspace_id,
        task_id,
        settings.stream_ticket_ttl_seconds,
    )
    return {"ticket": ticket, "expires_at": expires_at.isoformat()}


async def _consume_stream_ticket(ticket: str, *, task_id: str) -> StreamTicketRecord:
    entry = await get_coordination_backend().consume_stream_ticket(ticket, task_id=task_id)
    if entry is None:
        raise HTTPException(status_code=401, detail="Invalid stream ticket")
    return entry


def _track_background_task(run_key: str, task: asyncio.Task[None]) -> None:
    """Register a background run and drop it when the task finishes."""

    _background_task_runs[run_key] = task

    def _cleanup(finished: asyncio.Task[None]) -> None:
        current = _background_task_runs.get(run_key)
        if current is finished:
            _background_task_runs.pop(run_key, None)

    task.add_done_callback(_cleanup)


def _launch_background_task_run(*, task_id: str, workspace_id: str) -> None:
    """Start a task run in the background when one is not already active locally."""

    run_key = _task_run_key(workspace_id, task_id)
    existing = _background_task_runs.get(run_key)
    if existing is not None and not existing.done():
        return

    async def _runner() -> None:
        try:
            await _execute_task_run(task_id=task_id, workspace_id=workspace_id)
        except HTTPException as exc:
            logger.warning(
                "background_task_run_rejected",
                task_id=task_id,
                workspace_id=workspace_id,
                status_code=exc.status_code,
                detail=str(exc.detail),
            )
        except Exception:
            logger.exception(
                "background_task_run_failed",
                task_id=task_id,
                workspace_id=workspace_id,
            )

    _track_background_task(run_key, asyncio.create_task(_runner()))


async def _acquire_task_run_lock(run_key: str) -> RunLockLease | None:
    return await get_coordination_backend().acquire_run_lock(
        run_key,
        ttl_seconds=settings.task_run_lock_ttl_seconds,
    )


async def _refresh_task_run_lock(
    run_key: str,
    *,
    lease_id: str,
) -> RunLockLease | None:
    return await get_coordination_backend().refresh_run_lock(
        run_key,
        lease_id=lease_id,
        ttl_seconds=settings.task_run_lock_ttl_seconds,
    )


async def _release_task_run_lock(run_key: str, *, lease_id: str) -> bool:
    return await get_coordination_backend().release_run_lock(run_key, lease_id=lease_id)


async def _acquire_workspace_run_slot(
    workspace_id: str,
    *,
    run_key: str,
    lease_id: str,
) -> ConcurrencySlotLease | None:
    limit = settings.workspace_concurrent_task_runs
    if limit <= 0:
        return None
    return await get_coordination_backend().acquire_concurrency_slot(
        _workspace_run_bucket_key(workspace_id),
        holder_key=run_key,
        lease_id=lease_id,
        limit=limit,
        ttl_seconds=settings.task_run_lock_ttl_seconds,
    )


async def _refresh_workspace_run_slot(
    workspace_id: str,
    *,
    run_key: str,
    lease_id: str,
) -> ConcurrencySlotLease | None:
    limit = settings.workspace_concurrent_task_runs
    if limit <= 0:
        return None
    return await get_coordination_backend().refresh_concurrency_slot(
        _workspace_run_bucket_key(workspace_id),
        holder_key=run_key,
        lease_id=lease_id,
        ttl_seconds=settings.task_run_lock_ttl_seconds,
    )


async def _release_workspace_run_slot(
    workspace_id: str,
    *,
    run_key: str,
    lease_id: str,
) -> bool:
    limit = settings.workspace_concurrent_task_runs
    if limit <= 0:
        return False
    return await get_coordination_backend().release_concurrency_slot(
        _workspace_run_bucket_key(workspace_id),
        holder_key=run_key,
        lease_id=lease_id,
    )


async def _reset_coordination_state_for_tests() -> None:
    """Clear coordination state for deterministic tests."""

    await reset_coordination_state_for_tests()


async def _enforce_rate_limit(
    *,
    workspace_id: str,
    key_prefix: str,
    limit: int,
    detail: str,
) -> None:
    """Apply a fixed-window per-workspace rate limit when configured."""

    if limit <= 0:
        return
    state = await get_coordination_backend().hit_rate_limit(
        f"{key_prefix}:{workspace_id}",
        limit=limit,
        window_seconds=_RATE_LIMIT_WINDOW_SECONDS,
    )
    if state.count <= state.limit:
        return
    raise HTTPException(
        status_code=429,
        detail=detail,
        headers={"Retry-After": str(state.retry_after_seconds)},
    )


async def _enforce_task_create_rate_limit(workspace_id: str) -> None:
    await _enforce_rate_limit(
        workspace_id=workspace_id,
        key_prefix="task-create",
        limit=settings.task_create_rate_limit_per_minute,
        detail="Task creation rate limit exceeded",
    )


async def _enforce_task_run_rate_limit(workspace_id: str) -> None:
    await _enforce_rate_limit(
        workspace_id=workspace_id,
        key_prefix="task-run",
        limit=settings.task_run_rate_limit_per_minute,
        detail="Task run rate limit exceeded",
    )


def _derive_informational_payouts(
    *,
    payment_amount: float,
    model_token_usage: dict[str, int],
    agent_models_used: list[str],
) -> dict[str, float]:
    """Derive display-only per-model payout allocations for UI telemetry panels."""

    if payment_amount <= 0.0:
        return {}

    normalized_tokens = {
        model: max(0, int(tokens)) for model, tokens in model_token_usage.items() if model
    }
    token_total = sum(normalized_tokens.values())
    if token_total > 0:
        return {
            model: (payment_amount * tokens) / token_total
            for model, tokens in normalized_tokens.items()
        }

    unique_models = [model for model in dict.fromkeys(agent_models_used) if model]
    if not unique_models:
        return {}

    even_split = payment_amount / len(unique_models)
    return {model: even_split for model in unique_models}


def _cost_payload_from_model_telemetry(
    model_telemetry: dict[str, ModelTelemetry],
) -> BenchmarkCostEstimateResponse | None:
    payload = estimate_cost_for_models(model_telemetry)
    if payload.estimation_mode == "unavailable":
        return None
    return BenchmarkCostEstimateResponse(
        estimated_cost_usd=payload.estimated_cost_usd,
        model_estimated_costs_usd=payload.model_estimated_costs_usd,
        pricing_version=payload.pricing_version,
        estimated_at=payload.estimated_at,
        estimation_mode=payload.estimation_mode,
        pricing_sources=payload.pricing_sources,
    )


def _cost_payload_from_runtime(cost: CostEstimate | None) -> BenchmarkCostEstimateResponse | None:
    """Normalize a runtime cost payload into API response shape."""

    if cost is None or cost.estimation_mode == "unavailable":
        return None
    return BenchmarkCostEstimateResponse(
        estimated_cost_usd=cost.estimated_cost_usd,
        model_estimated_costs_usd=cost.model_estimated_costs_usd,
        pricing_version=cost.pricing_version,
        estimated_at=cost.estimated_at,
        estimation_mode=cost.estimation_mode,
        pricing_sources=cost.pricing_sources,
    )


def _result_to_response(
    task_id: str,
    result: DeliberationResult,
    *,
    payment_amount: float = 0.0,
    payment_status: PaymentStatusName = "none",
) -> DeliberationResultResponse:
    """Convert runtime result into API response shape."""

    def _optional_int(value: Any) -> int | None:
        if value is None:
            return None
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return None

    model_token_usage = {model: int(tokens) for model, tokens in result.model_token_usage.items()}
    model_latency_ms = {model: float(latency) for model, latency in result.model_latency_ms.items()}
    model_telemetry_raw = (
        {model: telemetry for model, telemetry in result.model_telemetry.items()}
        if result.model_telemetry
        else build_model_telemetry(
            models=result.agent_models_used,
            model_token_usage=model_token_usage,
            model_latency_ms=model_latency_ms,
            model_input_tokens=getattr(result, "model_input_token_usage", {}),
            model_output_tokens=getattr(result, "model_output_token_usage", {}),
            model_thinking_tokens=getattr(result, "model_thinking_token_usage", {}),
            fallback_total_tokens=result.total_tokens_used,
        )
    )
    cost_payload = _cost_payload_from_runtime(result.cost) or _cost_payload_from_model_telemetry(
        model_telemetry_raw
    )
    informational_model_payouts = _derive_informational_payouts(
        payment_amount=payment_amount,
        model_token_usage=model_token_usage,
        agent_models_used=result.agent_models_used,
    )

    return DeliberationResultResponse(
        task_id=task_id,
        mechanism=_mechanism_name(result.mechanism_used),
        final_answer=result.final_answer,
        confidence=result.confidence,
        quorum_reached=result.quorum_reached,
        merkle_root=result.merkle_root,
        decision_hash=_hash_text(result.final_answer),
        agent_count=result.agent_count,
        agent_models_used=result.agent_models_used,
        model_token_usage=model_token_usage,
        model_latency_ms=model_latency_ms,
        model_telemetry={
            model: ModelTelemetryResponse.model_validate(telemetry.model_dump(mode="json"))
            for model, telemetry in model_telemetry_raw.items()
        },
        total_tokens_used=result.total_tokens_used,
        reasoning_presets=result.reasoning_presets,
        input_tokens_used=_optional_int(getattr(result, "input_tokens_used", None)),
        output_tokens_used=_optional_int(getattr(result, "output_tokens_used", None)),
        thinking_tokens_used=_optional_int(getattr(result, "thinking_tokens_used", None)),
        latency_ms=result.total_latency_ms,
        cost=cost_payload,
        payment_amount=max(0.0, payment_amount),
        payment_status=payment_status,
        informational_model_payouts=informational_model_payouts,
        round_count=result.round_count,
        mechanism_switches=result.mechanism_switches,
        transcript_hashes=result.transcript_hashes,
        convergence_history=[
            metric.model_dump(mode="json") for metric in result.convergence_history
        ],
        locked_claims=[claim.model_dump(mode="json") for claim in result.locked_claims],
        mechanism_trace=[
            segment.model_dump(mode="json") for segment in result.mechanism_trace
        ],
        execution_mode=result.execution_mode,
        selector_source=result.selector_source,
        selector_fallback_path=list(result.mechanism_selection.selector_fallback_path),
        fallback_count=result.fallback_count,
        fallback_events=[event.model_dump(mode="json") for event in result.fallback_events],
        mechanism_override_source=result.mechanism_override_source,
    )


def _switch_operation_key(switch_index: int) -> str:
    return f"record_switch:{switch_index}"


def _chain_operation(task: TaskStatusResponse, operation_key: str) -> ChainOperationRecord | None:
    record = task.chain_operations.get(operation_key)
    if record is None:
        return None
    if isinstance(record, ChainOperationRecord):
        return record
    return ChainOperationRecord.model_validate(record)


def _set_chain_operation(
    task: TaskStatusResponse,
    operation_key: str,
    record: ChainOperationRecord,
) -> None:
    task.chain_operations[operation_key] = record


def _ensure_chain_operation(
    task: TaskStatusResponse,
    operation_key: str,
) -> ChainOperationRecord:
    record = _chain_operation(task, operation_key)
    if record is not None:
        return record
    record = ChainOperationRecord(status="pending")
    _set_chain_operation(task, operation_key, record)
    return record


def _mark_chain_operation_pending(
    task: TaskStatusResponse,
    operation_key: str,
) -> None:
    current = _ensure_chain_operation(task, operation_key)
    if current.status == "succeeded":
        return
    _set_chain_operation(
        task,
        operation_key,
        ChainOperationRecord(
            status="pending",
            tx_hash=current.tx_hash,
            explorer_url=current.explorer_url,
            attempts=current.attempts,
            updated_at=datetime.now(UTC),
        ),
    )


def _mark_chain_operation_succeeded(
    task: TaskStatusResponse,
    operation_key: str,
    result: dict[str, Any],
) -> None:
    current = _ensure_chain_operation(task, operation_key)
    tx_hash = str(result.get("tx_hash", "")) or current.tx_hash
    explorer_url = str(result.get("explorer_url", "")) or current.explorer_url
    _set_chain_operation(
        task,
        operation_key,
        ChainOperationRecord(
            status="succeeded",
            tx_hash=tx_hash,
            explorer_url=explorer_url,
            attempts=current.attempts + 1,
            updated_at=datetime.now(UTC),
        ),
    )


def _mark_chain_operation_failed(
    task: TaskStatusResponse,
    operation_key: str,
    exc: Exception,
) -> None:
    current = _ensure_chain_operation(task, operation_key)
    _set_chain_operation(
        task,
        operation_key,
        ChainOperationRecord(
            status="failed",
            tx_hash=current.tx_hash,
            explorer_url=current.explorer_url,
            error=str(exc),
            attempts=current.attempts + 1,
            updated_at=datetime.now(UTC),
        ),
    )


def _chain_operation_succeeded(task: TaskStatusResponse, operation_key: str) -> bool:
    record = _chain_operation(task, operation_key)
    return record is not None and record.status == "succeeded"


def _apply_chain_tx(task: TaskStatusResponse, result: dict[str, Any]) -> None:
    task.solana_tx_hash = str(result.get("tx_hash", "")) or task.solana_tx_hash
    task.explorer_url = str(result.get("explorer_url", "")) or task.explorer_url


async def _save_task_status(
    *,
    store: TaskStore | LocalTaskStore,
    workspace_id: str,
    task_id: str,
    task: TaskStatusResponse,
) -> None:
    await store.save_task(workspace_id, task_id, task.model_dump(mode="json"))


async def _load_selector_state(
    store: TaskStore | LocalTaskStore,
    orchestrator: AgoraOrchestrator,
) -> None:
    """Load durable selector bandit state when available."""

    state_payload = await store.get_runtime_state(_SELECTOR_BANDIT_STATE_KEY)
    if state_payload is None:
        return
    if not hasattr(orchestrator.selector, "bandit"):
        return
    orchestrator.selector.bandit.load_state_payload(state_payload)


async def _save_selector_state(
    store: TaskStore | LocalTaskStore,
    orchestrator: AgoraOrchestrator,
) -> None:
    """Persist selector bandit state for future orchestrators."""

    await store.save_runtime_state(
        _SELECTOR_BANDIT_STATE_KEY,
        cast(dict[str, Any], orchestrator.selector.bandit.to_state()),
    )


async def _attempt_chain_operation(
    *,
    store: TaskStore | LocalTaskStore,
    workspace_id: str,
    task_id: str,
    task: TaskStatusResponse,
    operation_key: str,
    call: Callable[[], Awaitable[dict[str, Any]]],
    strict_failure_detail: str,
    on_success: Callable[[dict[str, Any]], None] | None = None,
    reconcile: Callable[[ChainOperationRecord | None], Awaitable[dict[str, Any] | None]] | None = None,
) -> dict[str, Any] | None:
    """Run one Solana side effect with a persisted write-ahead operation record."""

    current = _chain_operation(task, operation_key)
    if current is not None and current.status == "succeeded":
        return None

    if (
        reconcile is not None
        and current is not None
        and (current.attempts > 0 or current.status == "failed")
    ):
        try:
            reconciled = await reconcile(current)
        except Exception as exc:
            logger.warning(
                "task_chain_reconciliation_failed",
                task_id=task_id,
                operation=operation_key,
                error=str(exc),
            )
            reconciled = None
        if reconciled is not None:
            _mark_chain_operation_succeeded(task, operation_key, reconciled)
            if on_success is not None:
                on_success(reconciled)
            await _save_task_status(
                store=store,
                workspace_id=workspace_id,
                task_id=task_id,
                task=task,
            )
            logger.info(
                "task_chain_operation_reconciled",
                task_id=task_id,
                operation=operation_key,
            )
            return reconciled

    _mark_chain_operation_pending(task, operation_key)
    await _save_task_status(
        store=store,
        workspace_id=workspace_id,
        task_id=task_id,
        task=task,
    )

    try:
        result = await call()
    except Exception as exc:
        _mark_chain_operation_failed(task, operation_key, exc)
        await _save_task_status(
            store=store,
            workspace_id=workspace_id,
            task_id=task_id,
            task=task,
        )
        logger.error(
            "task_chain_operation_failed",
            task_id=task_id,
            operation=operation_key,
            error=str(exc),
        )
        if settings.strict_chain_writes:
            raise HTTPException(status_code=502, detail=strict_failure_detail) from exc
        logger.warning(
            "task_chain_operation_soft_failed",
            task_id=task_id,
            operation=operation_key,
            error=str(exc),
        )
        return None

    _mark_chain_operation_succeeded(task, operation_key, result)
    if on_success is not None:
        on_success(result)
    await _save_task_status(
        store=store,
        workspace_id=workspace_id,
        task_id=task_id,
        task=task,
    )
    return result


def _has_chain_setup_operations(task: TaskStatusResponse) -> bool:
    return (
        _INITIALIZE_TASK_OPERATION in task.chain_operations
        or _RECORD_SELECTION_OPERATION in task.chain_operations
    )


def _chain_setup_needs_retry(task: TaskStatusResponse) -> bool:
    return _has_chain_setup_operations(task) and (
        not _chain_operation_succeeded(task, _INITIALIZE_TASK_OPERATION)
        or not _chain_operation_succeeded(task, _RECORD_SELECTION_OPERATION)
    )


def _chain_setup_ready(task: TaskStatusResponse) -> bool:
    return not _has_chain_setup_operations(task) or (
        _chain_operation_succeeded(task, _INITIALIZE_TASK_OPERATION)
        and _chain_operation_succeeded(task, _RECORD_SELECTION_OPERATION)
    )


def _chain_finalization_needs_retry(task: TaskStatusResponse) -> bool:
    for operation_key, record in task.chain_operations.items():
        if operation_key != _SUBMIT_RECEIPT_OPERATION and not operation_key.startswith(
            "record_switch:"
        ):
            continue
        parsed = (
            record
            if isinstance(record, ChainOperationRecord)
            else ChainOperationRecord.model_validate(record)
        )
        if parsed.status != "succeeded":
            return True
    return False


async def _finalize_chain_setup_operations(
    *,
    store: TaskStore | LocalTaskStore,
    workspace_id: str,
    task_id: str,
    task: TaskStatusResponse,
) -> None:
    if not bridge.is_configured():
        logger.warning("solana_bridge_not_configured", task_id=task_id)
        return

    _ensure_chain_operation(task, _INITIALIZE_TASK_OPERATION)
    _ensure_chain_operation(task, _RECORD_SELECTION_OPERATION)

    payment_amount_lamports = int(task.payment_amount * LAMPORTS_PER_SOL)

    def on_initialize_success(result: dict[str, Any]) -> None:
        _apply_chain_tx(task, result)
        if task.payment_amount > 0:
            task.payment_status = "locked"

    onchain_task: Any | None = None
    onchain_task_loaded = False

    async def load_onchain_task() -> Any | None:
        nonlocal onchain_task, onchain_task_loaded
        if not onchain_task_loaded:
            onchain_task = await bridge.fetch_task_account(task_id)
            onchain_task_loaded = True
        return onchain_task

    async def reconcile_initialize(
        current: ChainOperationRecord | None,
    ) -> dict[str, Any] | None:
        if current is None or current.status == "succeeded":
            return None
        if not await bridge.task_account_exists(task_id):
            return None
        return {
            "tx_hash": current.tx_hash or "",
            "explorer_url": current.explorer_url or "",
            "task_pda": str(bridge.derive_task_pda(task_id)),
        }

    async def reconcile_selection(
        current: ChainOperationRecord | None,
    ) -> dict[str, Any] | None:
        if current is None or current.status == "succeeded":
            return None
        onchain = await load_onchain_task()
        if onchain is None:
            return None
        if onchain.selector_reasoning_hash != task.selector_reasoning_hash:
            return None
        if onchain.status not in {"in_progress", "completed", "paid"}:
            return None
        return {
            "tx_hash": current.tx_hash or "",
            "explorer_url": current.explorer_url or "",
            "task_pda": str(bridge.derive_task_pda(task_id)),
            "selector_reasoning_hash": onchain.selector_reasoning_hash,
        }

    await _attempt_chain_operation(
        store=store,
        workspace_id=workspace_id,
        task_id=task_id,
        task=task,
        operation_key=_INITIALIZE_TASK_OPERATION,
        call=lambda: bridge.initialize_task(
            task_id=task_id,
            mechanism=task.mechanism,
            task_hash=_hash_text(task.task_text),
            consensus_threshold=60,
            agent_count=task.agent_count,
            payment_amount_lamports=payment_amount_lamports,
        ),
        strict_failure_detail="Failed to initialize task on Solana",
        on_success=on_initialize_success,
        reconcile=reconcile_initialize,
    )

    if not _chain_operation_succeeded(task, _INITIALIZE_TASK_OPERATION):
        return

    await _attempt_chain_operation(
        store=store,
        workspace_id=workspace_id,
        task_id=task_id,
        task=task,
        operation_key=_RECORD_SELECTION_OPERATION,
        call=lambda: bridge.record_selection(
            task_id=task_id,
            selector_reasoning_hash=task.selector_reasoning_hash,
        ),
        strict_failure_detail="Failed to record task selection on Solana",
        reconcile=reconcile_selection,
    )


async def _finalize_result_chain_operations(
    *,
    store: TaskStore | LocalTaskStore,
    workspace_id: str,
    task_id: str,
    task: TaskStatusResponse,
    result_response: DeliberationResultResponse,
    switch_events: list[TaskEvent],
    ensure_missing: bool,
) -> None:
    if not bridge.is_configured():
        logger.warning("solana_bridge_not_configured", task_id=task_id)
        return
    if not _chain_setup_ready(task):
        logger.warning(
            "task_chain_finalization_waiting_for_setup",
            task_id=task_id,
        )
        return

    onchain_task: Any | None = None
    onchain_task_loaded = False

    async def load_onchain_task() -> Any | None:
        nonlocal onchain_task, onchain_task_loaded
        if not onchain_task_loaded:
            onchain_task = await bridge.fetch_task_account(task_id)
            onchain_task_loaded = True
        return onchain_task

    for switch_index, switch_event in enumerate(switch_events):
        operation_key = _switch_operation_key(switch_index)
        if ensure_missing:
            _ensure_chain_operation(task, operation_key)
        if operation_key not in task.chain_operations:
            continue

        data = switch_event.data
        async def reconcile_switch(
            current: ChainOperationRecord | None,
            *,
            switch_index: int = switch_index,
        ) -> dict[str, Any] | None:
            if current is None or current.status == "succeeded":
                return None
            if not await bridge.switch_account_exists(task_id, switch_index):
                return None
            return {
                "tx_hash": current.tx_hash or "",
                "explorer_url": current.explorer_url or "",
                "switch_pda": str(bridge.derive_switch_pda(task_id, switch_index)),
            }

        await _attempt_chain_operation(
            store=store,
            workspace_id=workspace_id,
            task_id=task_id,
            task=task,
            operation_key=operation_key,
            call=lambda data=data, switch_index=switch_index: bridge.record_mechanism_switch(
                task_id=task_id,
                switch_index=switch_index,
                from_mechanism=str(data.get("from_mechanism", task.mechanism)),
                to_mechanism=str(data.get("to_mechanism", result_response.mechanism)),
                reason_hash=_hash_text(str(data.get("reason", "mechanism switch"))),
                round_number=int(data.get("round_number", result_response.round_count)),
            ),
            strict_failure_detail="Failed to record mechanism switch on Solana",
            reconcile=reconcile_switch,
        )

    if any(
        not _chain_operation_succeeded(task, _switch_operation_key(switch_index))
        for switch_index, _switch_event in enumerate(switch_events)
    ):
        return

    if ensure_missing:
        _ensure_chain_operation(task, _SUBMIT_RECEIPT_OPERATION)
    if _SUBMIT_RECEIPT_OPERATION in task.chain_operations:
        async def reconcile_receipt(
            current: ChainOperationRecord | None,
        ) -> dict[str, Any] | None:
            if current is None or current.status == "succeeded":
                return None
            onchain = await load_onchain_task()
            if onchain is None:
                return None
            if onchain.transcript_merkle_root != (result_response.merkle_root or ""):
                return None
            if onchain.decision_hash != (result_response.decision_hash or ""):
                return None
            if onchain.quorum_reached != result_response.quorum_reached:
                return None
            if onchain.mechanism != result_response.mechanism:
                return None
            if onchain.mechanism_switches != result_response.mechanism_switches:
                return None
            if onchain.status not in {"completed", "paid"}:
                return None
            return {
                "tx_hash": current.tx_hash or "",
                "explorer_url": current.explorer_url or "",
                "task_pda": str(bridge.derive_task_pda(task_id)),
                "decision_hash": onchain.decision_hash,
                "transcript_merkle_root": onchain.transcript_merkle_root,
            }

        await _attempt_chain_operation(
            store=store,
            workspace_id=workspace_id,
            task_id=task_id,
            task=task,
            operation_key=_SUBMIT_RECEIPT_OPERATION,
            call=lambda: bridge.submit_receipt(
                task_id=task_id,
                merkle_root=result_response.merkle_root or "",
                decision_hash=result_response.decision_hash or "",
                quorum_reached=result_response.quorum_reached,
                final_mechanism=result_response.mechanism,
            ),
            strict_failure_detail="Failed to submit receipt on Solana",
            on_success=lambda result: _apply_chain_tx(task, result),
            reconcile=reconcile_receipt,
        )


def _to_status_response(raw_task: dict[str, Any], *, detailed: bool = False) -> TaskStatusResponse:
    """Normalize stored task payload into API response shape."""

    normalized = dict(raw_task)
    mechanism = normalized.get("mechanism")
    if isinstance(mechanism, str):
        normalized["mechanism"] = _parse_mechanism(
            mechanism,
            status_code=409,
            source="stored task mechanism",
        ).value

    mechanism_override = normalized.get("mechanism_override")
    if mechanism_override is not None:
        if not isinstance(mechanism_override, str):
            raise HTTPException(status_code=409, detail="Invalid mechanism override in stored task")
        normalized["mechanism_override"] = _parse_mechanism(
            mechanism_override,
            status_code=409,
            source="stored task mechanism_override",
        ).value

    normalized["reasoning_presets"] = resolve_reasoning_presets(
        normalized.get("reasoning_presets")
        if isinstance(normalized.get("reasoning_presets"), dict)
        else None
    ).model_dump(mode="json")
    if isinstance(normalized.get("tier_model_overrides"), dict):
        normalized["tier_model_overrides"] = normalize_tier_model_overrides(
            normalized["tier_model_overrides"]
        )

    if not detailed:
        normalized["events"] = []
        normalized["chain_operations"] = {}
    task = TaskStatusResponse.model_validate(normalized)
    resolved_quorum = _resolved_task_quorum(task)
    if resolved_quorum is not None:
        task.quorum_reached = resolved_quorum
        if task.result is not None:
            task.result.quorum_reached = resolved_quorum
    return task


def _computed_result_quorum(task: TaskStatusResponse) -> bool | None:
    """Recompute quorum from persisted confidence when a result payload exists."""

    if task.result is None:
        return None
    return task.result.confidence >= task.quorum_threshold


def _resolved_task_quorum(task: TaskStatusResponse) -> bool | None:
    """Return the best available quorum signal, recomputing from confidence when possible."""

    computed_quorum = _computed_result_quorum(task)
    if computed_quorum is not None:
        return computed_quorum
    return task.quorum_reached


def _event_payload(event_type: str, event_data: dict[str, Any]) -> dict[str, Any]:
    """Build a persisted event envelope."""

    return TaskEvent(
        event=event_type,
        data=event_data,
        timestamp=datetime.now(UTC),
    ).model_dump(mode="json")


def _append_task_event_snapshot(
    task: TaskStatusResponse,
    *,
    event_type: str,
    event_data: dict[str, Any],
) -> None:
    """Keep the in-memory task event snapshot aligned with persisted event writes."""

    task.events.append(
        TaskEvent.model_validate(_event_payload(event_type, event_data))
    )


def _to_sse_message(event: dict[str, Any]) -> dict[str, Any]:
    """Normalize stored/live envelopes to SSE messages with explicit timestamps."""

    return {
        "event": str(event.get("event", "update")),
        "data": json.dumps({
            "payload": event.get("data", {}),
            "timestamp": event.get("timestamp"),
        }),
    }


def _forced_mechanism() -> MechanismType | None:
    """Return an env-pinned mechanism for hosted demo validation when configured."""

    configured = settings.api_force_mechanism.strip().lower()
    if not configured:
        return None
    try:
        mechanism = MechanismType(configured)
    except ValueError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Unsupported AGORA_API_FORCE_MECHANISM={settings.api_force_mechanism!r}",
        ) from exc
    return _require_supported_mechanism(
        mechanism,
        status_code=500,
        source="AGORA_API_FORCE_MECHANISM",
    )


def _require_supported_mechanism(
    mechanism: MechanismType,
    *,
    status_code: int,
    source: str,
) -> MechanismType:
    """Require a mechanism to be executable in current runtime paths."""

    if not mechanism_is_supported(mechanism):
        raise HTTPException(
            status_code=status_code,
            detail=(
                f"Mechanism '{mechanism.value}' from {source} is not currently supported. "
                f"Supported mechanisms: {_SUPPORTED_MECHANISMS_TEXT}."
            ),
        )
    return mechanism


def _parse_mechanism(
    raw_mechanism: str,
    *,
    status_code: int,
    source: str,
) -> MechanismType:
    """Parse and validate mechanism strings stored in persisted task records."""

    try:
        mechanism = MechanismType(raw_mechanism)
    except ValueError as exc:
        raise HTTPException(
            status_code=status_code,
            detail=f"Invalid mechanism '{raw_mechanism}' in {source}.",
        ) from exc
    return _require_supported_mechanism(mechanism, status_code=status_code, source=source)


def _request_mechanism_override(request: TaskCreateRequest) -> MechanismType | None:
    """Resolve optional request-level mechanism override from task create payload."""

    if request.mechanism_override is None:
        return None
    return _require_supported_mechanism(
        MechanismType(request.mechanism_override),
        status_code=400,
        source="mechanism_override",
    )


def _selector_source(
    *,
    selection: MechanismSelection,
    forced_override: MechanismType | None,
    requested_override: MechanismType | None,
) -> str:
    """Classify how the mechanism selection was produced."""

    if forced_override is not None:
        return "env_pin"
    if requested_override is not None:
        return "forced_override"
    return selection.selector_source


def _mechanism_override_source(
    *,
    forced_override: MechanismType | None,
    requested_override: MechanismType | None,
) -> str | None:
    """Expose the source of a pinned mechanism when present."""

    if forced_override is not None:
        return "env_pin"
    if requested_override is not None:
        return "request"
    return None


async def _pinned_selection(
    *,
    task_text: str,
    agent_count: int,
    stakes: float,
    mechanism: MechanismType,
) -> MechanismSelection:
    """Build deterministic selector metadata for an explicit mechanism override."""
    return await build_pinned_selection(
        task_text=task_text,
        agent_count=agent_count,
        stakes=stakes,
        mechanism=mechanism,
        reasoning_hash=_hash_text,
        selector_source="forced_override",
        mechanism_override_source="request",
    )


async def _stored_selection(task: TaskStatusResponse) -> MechanismSelection:
    """Rebuild selector metadata from persisted task state without re-running selection."""

    mechanism = MechanismType(task.mechanism)
    features = await extract_features(
        task_text=task.task_text,
        agent_count=task.agent_count,
        stakes=task.payment_amount,
    )
    return MechanismSelection(
        mechanism=mechanism,
        confidence=task.selector_confidence,
        reasoning=task.selector_reasoning,
        reasoning_hash=task.selector_reasoning_hash,
        bandit_recommendation=mechanism,
        bandit_confidence=task.selector_confidence,
        task_features=features,
        selector_source=cast(str, task.selector_source),
        selector_fallback_path=list(task.selector_fallback_path),
    )


async def persist_and_emit(
    *,
    store: TaskStore | LocalTaskStore,
    stream: DeliberationStream,
    workspace_id: str,
    task_id: str,
    event_type: str,
    event_data: dict[str, Any],
    journal: BufferedEventJournal | None = None,
) -> None:
    """Persist an event and emit it to live SSE listeners."""

    payload = _event_payload(event_type, event_data)
    if journal is not None:
        await journal.publish(
            payload,
            buffered=event_type in _BUFFERED_TASK_EVENT_TYPES,
        )
        return

    await stream.emit(_stream_key(workspace_id, task_id), payload)
    await store.append_event(workspace_id, task_id, payload)


async def _mark_task_failed(
    *,
    store: TaskStore | LocalTaskStore,
    stream: DeliberationStream,
    workspace_id: str,
    task_id: str,
    task: TaskStatusResponse,
    message: str,
) -> None:
    """Persist failed task state while preserving events emitted before failure."""

    task.status = "failed"
    task.failure_reason = message
    task.events = [
        TaskEvent.model_validate(event) for event in await store.get_events(workspace_id, task_id)
    ]
    error_event = TaskEvent(
        event="error",
        data={"message": message},
        timestamp=datetime.now(UTC),
    )
    task.latest_error_event = error_event
    await store.save_task(workspace_id, task_id, task.model_dump(mode="json"))
    await persist_and_emit(
        store=store,
        stream=stream,
        workspace_id=workspace_id,
        task_id=task_id,
        event_type=error_event.event,
        event_data=error_event.data,
    )
    await stream.close(_stream_key(workspace_id, task_id))


def _build_orchestrator(
    *,
    agent_count: int,
    allow_offline_fallback: bool,
    reasoning_presets: Any,
    tier_model_overrides: dict[str, str] | None = None,
) -> AgoraOrchestrator:
    """Build orchestrator while tolerating older test doubles without fallback kwargs."""

    try:
        return AgoraOrchestrator(
            agent_count=agent_count,
            allow_offline_fallback=allow_offline_fallback,
            reasoning_presets=reasoning_presets,
            tier_model_overrides=normalize_tier_model_overrides(tier_model_overrides),
        )
    except TypeError as exc:
        if "allow_offline_fallback" not in str(exc) and "tier_model_overrides" not in str(exc):
            raise
        try:
            return AgoraOrchestrator(
                agent_count=agent_count,
                reasoning_presets=reasoning_presets,
                tier_model_overrides=normalize_tier_model_overrides(tier_model_overrides),
            )
        except TypeError as nested_exc:
            if "tier_model_overrides" not in str(nested_exc):
                raise
            return AgoraOrchestrator(
                agent_count=agent_count,
                reasoning_presets=reasoning_presets,
            )


@router.post("", response_model=TaskCreateResponse)
@router.post("/", response_model=TaskCreateResponse, include_in_schema=False)
async def create_task(
    request: TaskCreateRequest,
    user: CurrentUser,
) -> TaskCreateResponse:
    """Create a task, run selector, and initialize its on-chain metadata."""

    require_scope(user, "tasks:write")
    await _enforce_task_create_rate_limit(user.workspace_id)
    store = get_task_store()
    task_id = _build_task_id(request.task)

    requested_override = _request_mechanism_override(request)
    forced_override = _forced_mechanism()
    effective_override = forced_override or requested_override
    reasoning_presets = resolve_reasoning_presets(request.reasoning_presets)
    try:
        tier_model_overrides = normalize_tier_model_overrides(
            request.tier_model_overrides.present() if request.tier_model_overrides else None
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    orchestrator = _build_orchestrator(
        agent_count=request.agent_count,
        allow_offline_fallback=request.allow_offline_fallback,
        reasoning_presets=reasoning_presets,
        tier_model_overrides=tier_model_overrides,
    )
    await _load_selector_state(store, orchestrator)
    selection, selector_source, selector_fallback_path, mechanism_override_source = (
        await resolve_task_like_selection(
            orchestrator=orchestrator,
            task_text=request.task,
            agent_count=request.agent_count,
            stakes=request.stakes,
            forced_override=forced_override,
            requested_override=requested_override,
        )
    )
    _require_supported_mechanism(
        selection.mechanism,
        status_code=500,
        source="selector",
    )
    if selector_source in {"heuristic_fallback", "bandit_fallback"} and not request.allow_offline_fallback:
        raise HTTPException(
            status_code=503,
            detail="Selector provider fallback occurred but allow_offline_fallback=false",
        )

    task_status = TaskStatusResponse(
        task_id=task_id,
        task_text=request.task,
        workspace_id=user.workspace_id,
        created_by=user.user_id or f"api_key:{user.api_key_id}",
        mechanism=_mechanism_name(selection.mechanism),
        mechanism_override=(
            _mechanism_name(effective_override) if effective_override is not None else None
        ),
        allow_mechanism_switch=request.allow_mechanism_switch,
        allow_offline_fallback=request.allow_offline_fallback,
        quorum_threshold=request.quorum_threshold,
        selector_source=selector_source,
        selector_fallback_path=selector_fallback_path,
        mechanism_override_source=mechanism_override_source,
        status="pending",
        selector_reasoning=selection.reasoning,
        selector_reasoning_hash=selection.reasoning_hash,
        selector_confidence=selection.confidence,
        agent_count=request.agent_count,
        reasoning_presets=reasoning_presets,
        tier_model_overrides=(
            request.tier_model_overrides.model_validate(tier_model_overrides)
            if tier_model_overrides
            else None
        ),
        payment_amount=request.stakes,
        payment_status="none",
    )
    if bridge.is_configured():
        _ensure_chain_operation(task_status, _INITIALIZE_TASK_OPERATION)
        _ensure_chain_operation(task_status, _RECORD_SELECTION_OPERATION)
    else:
        logger.warning("solana_bridge_not_configured", task_id=task_id)
    await store.save_task(user.workspace_id, task_id, task_status.model_dump(mode="json"))

    if bridge.is_configured():
        try:
            await _finalize_chain_setup_operations(
                store=store,
                workspace_id=user.workspace_id,
                task_id=task_id,
                task=task_status,
            )
        except HTTPException:
            task_status.status = "failed"
            await _save_task_status(
                store=store,
                workspace_id=user.workspace_id,
                task_id=task_id,
                task=task_status,
            )
            raise

    await persist_and_emit(
        store=store,
        stream=get_stream_manager(),
        workspace_id=user.workspace_id,
        task_id=task_id,
        event_type="mechanism_selected",
        event_data={
            "task_id": task_id,
            "mechanism": selection.mechanism.value,
            "mechanism_override": (
                effective_override.value if effective_override is not None else None
            ),
            "mechanism_override_source": mechanism_override_source,
            "confidence": selection.confidence,
            "reasoning": selection.reasoning,
            "selector_reasoning_hash": selection.reasoning_hash,
            "selector_source": selector_source,
            "selector_fallback_path": selector_fallback_path,
        },
    )

    return TaskCreateResponse(
        task_id=task_id,
        mechanism=_mechanism_name(selection.mechanism),
        confidence=selection.confidence,
        reasoning=selection.reasoning,
        selector_reasoning_hash=selection.reasoning_hash,
        status="pending",
        selector_source=selector_source,
        selector_fallback_path=selector_fallback_path,
        mechanism_override_source=mechanism_override_source,
    )


async def _execute_task_run(
    *,
    task_id: str,
    workspace_id: str,
) -> DeliberationResultResponse:
    """Execute the stored mechanism and persist the resulting receipt."""

    store = get_task_store()
    stream = get_stream_manager()
    raw_task = await _load_task_for_user(store, workspace_id, task_id)

    task = _to_status_response(raw_task, detailed=True)
    run_key = _task_run_key(workspace_id, task_id)
    recovering_stale_in_progress = False
    if task.status in {"completed", "paid"} and task.result is not None:
        if bridge.is_configured() and (
            _chain_setup_needs_retry(task) or _chain_finalization_needs_retry(task)
        ):
            await _enforce_task_run_rate_limit(workspace_id)
            retry_lease = await _acquire_task_run_lock(run_key)
            if retry_lease is None:
                raise HTTPException(status_code=409, detail="Task is already in progress")
            try:
                if _chain_setup_needs_retry(task):
                    await _finalize_chain_setup_operations(
                        store=store,
                        workspace_id=workspace_id,
                        task_id=task_id,
                        task=task,
                    )
                switch_events = [
                    TaskEvent.model_validate(event)
                    for event in await store.get_events(workspace_id, task_id)
                    if event.get("event") == "mechanism_switch"
                ]
                await _finalize_result_chain_operations(
                    store=store,
                    workspace_id=workspace_id,
                    task_id=task_id,
                    task=task,
                    result_response=task.result,
                    switch_events=switch_events,
                    ensure_missing=False,
                )
            finally:
                await _release_task_run_lock(run_key, lease_id=retry_lease.lease_id)
        return task.result
    if task.status != "pending":
        if task.status != "in_progress":
            raise HTTPException(status_code=409, detail=f"Task cannot run from status={task.status}")

    lease: RunLockLease | None
    if task.status == "in_progress":
        lease = await _acquire_task_run_lock(run_key)
        if lease is None:
            raise HTTPException(status_code=409, detail="Task is already in progress")
        try:
            await _enforce_task_run_rate_limit(workspace_id)
        except Exception:
            await _release_task_run_lock(run_key, lease_id=lease.lease_id)
            raise
        recovering_stale_in_progress = True
    else:
        await _enforce_task_run_rate_limit(workspace_id)
        lease = await _acquire_task_run_lock(run_key)
        if lease is None:
            raise HTTPException(status_code=409, detail="Task is already in progress")

    forced_mechanism = _forced_mechanism()
    stored_override: MechanismType | None = None
    if task.mechanism_override is not None:
        stored_override = _parse_mechanism(
            task.mechanism_override,
            status_code=409,
            source="stored mechanism_override",
        )
    effective_override = forced_mechanism or stored_override
    if effective_override is None:
        _parse_mechanism(
            task.mechanism,
            status_code=409,
            source="stored task mechanism",
        )

    workspace_slot = await _acquire_workspace_run_slot(
        workspace_id,
        run_key=run_key,
        lease_id=lease.lease_id,
    )
    if settings.workspace_concurrent_task_runs > 0 and workspace_slot is None:
        await _release_task_run_lock(run_key, lease_id=lease.lease_id)
        raise HTTPException(
            status_code=429,
            detail="Workspace concurrent task run limit exceeded",
            headers={"Retry-After": "1"},
        )

    run_lock_released = False
    workspace_slot_released = False
    lease_lost = False
    heartbeat_stop = asyncio.Event()
    current_lease = lease

    async def _run_lock_heartbeat() -> None:
        nonlocal current_lease, lease_lost
        interval_seconds = max(
            1.0,
            min(30.0, settings.task_run_lock_ttl_seconds / 3),
        )
        while True:
            try:
                await asyncio.wait_for(heartbeat_stop.wait(), timeout=interval_seconds)
                return
            except TimeoutError:
                try:
                    refreshed = await _refresh_task_run_lock(
                        run_key,
                        lease_id=current_lease.lease_id,
                    )
                except Exception:
                    lease_lost = True
                    logger.exception(
                        "task_run_lock_refresh_failed",
                        task_id=task_id,
                        run_key=run_key,
                    )
                    heartbeat_stop.set()
                    return
                if refreshed is None:
                    lease_lost = True
                    logger.error("task_run_lock_lost", task_id=task_id, run_key=run_key)
                    heartbeat_stop.set()
                    return
                if settings.workspace_concurrent_task_runs > 0:
                    slot = await _refresh_workspace_run_slot(
                        workspace_id,
                        run_key=run_key,
                        lease_id=current_lease.lease_id,
                    )
                    if slot is None:
                        lease_lost = True
                        logger.error(
                            "task_run_workspace_slot_lost",
                            task_id=task_id,
                            run_key=run_key,
                            workspace_id=workspace_id,
                        )
                        heartbeat_stop.set()
                        return
                current_lease = refreshed

    heartbeat_task = asyncio.create_task(_run_lock_heartbeat())

    async def _release_run_lock_once() -> None:
        nonlocal run_lock_released, workspace_slot_released
        if run_lock_released:
            return
        heartbeat_stop.set()
        with suppress(asyncio.CancelledError, Exception):
            await heartbeat_task
        if settings.workspace_concurrent_task_runs > 0 and not workspace_slot_released:
            await _release_workspace_run_slot(
                workspace_id,
                run_key=run_key,
                lease_id=current_lease.lease_id,
            )
            workspace_slot_released = True
        await _release_task_run_lock(run_key, lease_id=current_lease.lease_id)
        run_lock_released = True

    async def runtime_event_sink(event_type: str, data: dict[str, Any]) -> None:
        if lease_lost:
            raise RuntimeError("Task execution lease lost")
        await persist_and_emit(
            store=store,
            stream=stream,
            workspace_id=workspace_id,
            task_id=task_id,
            event_type=event_type,
            event_data=data,
            journal=journal,
        )

    journal = BufferedEventJournal(
        emit=lambda payload: stream.emit(_stream_key(workspace_id, task_id), payload),
        append_many=lambda payloads: store.append_events(workspace_id, task_id, payloads),
        flush_interval_seconds=_STREAM_BUFFER_FLUSH_INTERVAL_SECONDS,
        max_buffered_events=_STREAM_BUFFER_MAX_EVENTS,
    )

    orchestrator = _build_orchestrator(
        agent_count=task.agent_count,
        allow_offline_fallback=task.allow_offline_fallback,
        reasoning_presets=task.reasoning_presets,
        tier_model_overrides=(
            task.tier_model_overrides.present()
            if task.tier_model_overrides is not None
            else None
        ),
    )
    await _load_selector_state(store, orchestrator)
    if hasattr(orchestrator, "build_vote_engine"):
        orchestrator.vote_engine = orchestrator.build_vote_engine(
            quorum_threshold=task.quorum_threshold,
    )
    try:
        if recovering_stale_in_progress:
            recovery_event = {
                "task_id": task_id,
                "from_status": "in_progress",
                "reason": "Recovered stale in-progress task after acquiring a fresh run lease.",
            }
            await persist_and_emit(
                store=store,
                stream=stream,
                workspace_id=workspace_id,
                task_id=task_id,
                event_type="task_recovered",
                event_data=recovery_event,
                journal=journal,
            )
            _append_task_event_snapshot(
                task,
                event_type="task_recovered",
                event_data=recovery_event,
            )
        task.status = "in_progress"
        await store.save_task(workspace_id, task_id, task.model_dump(mode="json"))

        if bridge.is_configured() and _chain_setup_needs_retry(task):
            await _finalize_chain_setup_operations(
                store=store,
                workspace_id=workspace_id,
                task_id=task_id,
                task=task,
            )

        if effective_override is not None:
            selection = await build_pinned_selection(
                task_text=task.task_text,
                agent_count=task.agent_count,
                stakes=task.payment_amount,
                mechanism=effective_override,
                reasoning_hash=_hash_text,
                selector_source="env_pin" if forced_mechanism is not None else "forced_override",
                mechanism_override_source=(
                    "env_pin" if forced_mechanism is not None else "request"
                ),
            )
        else:
            selection = await _stored_selection(task)

        execution = await execute_task_like_run(
            orchestrator=orchestrator,
            task_text=task.task_text,
            selection=selection,
            selector_source=cast(Any, task.selector_source),
            selector_fallback_path=list(task.selector_fallback_path),
            mechanism_override_source=cast(Any, "env_pin" if forced_mechanism is not None else task.mechanism_override_source),
            event_sink=runtime_event_sink,
            allow_switch=task.allow_mechanism_switch if effective_override is None else False,
        )
        if lease_lost:
            raise RuntimeError("Task execution lease lost")
        if execution.status != "completed" or execution.result is None:
            raise RuntimeError(execution.failure_reason or "Task execution failed")
        result = execution.result
    except HTTPException as exc:
        try:
            await journal.close()
            await _mark_task_failed(
                store=store,
                stream=stream,
                workspace_id=workspace_id,
                task_id=task_id,
                task=task,
                message=str(exc.detail),
            )
        finally:
            await _release_run_lock_once()
        raise
    except Exception as exc:
        try:
            await journal.close()
            await _mark_task_failed(
                store=store,
                stream=stream,
                workspace_id=workspace_id,
                task_id=task_id,
                task=task,
                message=str(exc),
            )
        finally:
            logger.exception("task_execution_failed", task_id=task_id)
            await _release_run_lock_once()
        raise HTTPException(status_code=500, detail="Task execution failed") from exc

    await journal.flush()
    result_response = _result_to_response(
        task_id,
        result,
        payment_amount=task.payment_amount,
        payment_status=task.payment_status,
    )

    task.mechanism = result_response.mechanism
    task.quorum_reached = result_response.quorum_reached
    task.merkle_root = result_response.merkle_root
    task.decision_hash = result_response.decision_hash
    task.round_count = result_response.round_count
    task.mechanism_switches = result_response.mechanism_switches
    task.transcript_hashes = result_response.transcript_hashes
    task.result = result_response
    task.events = [
        TaskEvent.model_validate(event)
        for event in await store.get_events(workspace_id, task_id)
    ]
    switch_events = [event for event in task.events if event.event == "mechanism_switch"]
    if bridge.is_configured():
        for switch_index, _switch_event in enumerate(switch_events):
            _ensure_chain_operation(task, _switch_operation_key(switch_index))
        _ensure_chain_operation(task, _SUBMIT_RECEIPT_OPERATION)

    await store.save_task(workspace_id, task_id, task.model_dump(mode="json"))

    if bridge.is_configured():
        try:
            await _finalize_result_chain_operations(
                store=store,
                workspace_id=workspace_id,
                task_id=task_id,
                task=task,
                result_response=result_response,
                switch_events=switch_events,
                ensure_missing=False,
            )
        except HTTPException as exc:
            try:
                await _mark_task_failed(
                    store=store,
                    stream=stream,
                    workspace_id=workspace_id,
                    task_id=task_id,
                    task=task,
                    message=str(exc.detail),
                )
            finally:
                await _release_run_lock_once()
            raise

    task.status = "completed"
    task.completed_at = datetime.now(UTC)
    await store.save_task(workspace_id, task_id, task.model_dump(mode="json"))

    await persist_and_emit(
        store=store,
        stream=stream,
        workspace_id=workspace_id,
        task_id=task_id,
        event_type="quorum_reached",
        event_data={
            "task_id": task_id,
            "final_answer": result_response.final_answer,
            "confidence": result_response.confidence,
            "mechanism": result_response.mechanism,
            "quorum_reached": result_response.quorum_reached,
        },
        journal=journal,
    )
    receipt_record = _chain_operation(task, _SUBMIT_RECEIPT_OPERATION)
    if (
        receipt_record is not None
        and receipt_record.status == "succeeded"
        and receipt_record.tx_hash
    ):
        await persist_and_emit(
            store=store,
            stream=stream,
            workspace_id=workspace_id,
            task_id=task_id,
            event_type="receipt_committed",
            event_data={
                "task_id": task_id,
                "merkle_root": task.merkle_root,
                "solana_tx_hash": receipt_record.tx_hash,
                "explorer_url": receipt_record.explorer_url,
            },
            journal=journal,
        )

    await persist_and_emit(
        store=store,
        stream=stream,
        workspace_id=workspace_id,
        task_id=task_id,
        event_type="complete",
        event_data={"task_id": task_id, "status": task.status},
        journal=journal,
    )
    await journal.close()
    await stream.close(_stream_key(workspace_id, task_id))
    await _release_run_lock_once()
    return result_response


@router.post("/{task_id}/run", response_model=DeliberationResultResponse)
async def run_task(
    task_id: str,
    user: CurrentUser,
) -> DeliberationResultResponse:
    """Execute the stored mechanism synchronously and return the final receipt."""

    require_scope(user, "tasks:write")
    return await _execute_task_run(task_id=task_id, workspace_id=user.workspace_id)


@router.post("/{task_id}/run-async", response_model=TaskStatusResponse)
async def start_task_run(
    task_id: str,
    user: CurrentUser,
) -> TaskStatusResponse:
    """Start task execution in the background and return the current persisted status."""

    require_scope(user, "tasks:write")
    store = get_task_store()
    raw_task = await _load_task_for_user(store, user.workspace_id, task_id)
    task = _to_status_response(raw_task, detailed=True)

    if task.status not in {"pending", "in_progress", "completed", "paid"}:
        raise HTTPException(status_code=409, detail=f"Task cannot run from status={task.status}")
    if task.status == "pending":
        _launch_background_task_run(task_id=task_id, workspace_id=user.workspace_id)

    refreshed = await _load_task_for_user(store, user.workspace_id, task_id)
    return _to_status_response(refreshed, detailed=True)


@router.get("", response_model=list[TaskStatusResponse])
@router.get("/", response_model=list[TaskStatusResponse], include_in_schema=False)
async def list_tasks(
    user: CurrentUser,
) -> list[TaskStatusResponse]:
    """List recent tasks for the current user."""

    require_scope(user, "tasks:read")
    store = get_task_store()
    rows = await store.list_user_tasks(user.workspace_id)
    visible_rows: list[TaskStatusResponse] = []
    for row in rows:
        try:
            _assert_task_owner(row, user.workspace_id)
            visible_rows.append(_to_status_response(row, detailed=False))
        except HTTPException:
            logger.warning(
                "task_list_filtered_invalid_or_foreign_owner",
                workspace_id=user.workspace_id,
                task_id=row.get("task_id"),
            )
            continue
    return visible_rows


@router.get("/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(
    task_id: str,
    user: CurrentUser,
    detailed: bool = Query(default=False),
) -> TaskStatusResponse:
    """Fetch one task by id."""

    require_scope(user, "tasks:read")
    store = get_task_store()
    raw_task = await _load_task_for_user(store, user.workspace_id, task_id)
    return _to_status_response(raw_task, detailed=detailed)


@router.post("/{task_id}/stream-ticket")
async def create_stream_ticket(
    task_id: str,
    user: CurrentUser,
) -> dict[str, str]:
    """Issue a short-lived ticket for browser EventSource authentication."""

    require_scope(user, "tasks:read")
    store = get_task_store()
    await _load_task_for_user(store, user.workspace_id, task_id)
    return await _issue_stream_ticket(user.workspace_id, task_id)


@router.get("/{task_id}/stream")
async def stream_task(
    task_id: str,
    ticket: str = Query(...),
) -> EventSourceResponse:
    """Replay persisted events, then continue with live SSE updates."""

    stream_ticket = await _consume_stream_ticket(ticket, task_id=task_id)
    workspace_id = stream_ticket.workspace_id
    store = get_task_store()
    stream = get_stream_manager()
    await _load_task_for_user(store, workspace_id, task_id)

    async def event_generator() -> Any:
        events = await store.get_events(workspace_id, task_id)
        for event in events:
            yield _to_sse_message(event)

        if any(event.get("event") in _TERMINAL_TASK_EVENT_TYPES for event in events):
            return

        stream_id = _stream_key(workspace_id, task_id)
        queue = stream.subscribe(stream_id)
        next_event_index = len(events)

        try:
            while True:
                try:
                    item = await asyncio.wait_for(
                        queue.get(),
                        timeout=_STREAM_POLL_INTERVAL_SECONDS,
                    )
                except TimeoutError:
                    latest = await store.get_events(workspace_id, task_id)
                    if next_event_index >= len(latest):
                        continue

                    for event in latest[next_event_index:]:
                        payload = _to_sse_message(event)
                        next_event_index += 1
                        yield payload
                        if payload["event"] in _TERMINAL_TASK_EVENT_TYPES:
                            return
                    continue

                if item is None:
                    break
                payload = _to_sse_message(item)
                yield payload
                next_event_index += 1
                if payload["event"] in _TERMINAL_TASK_EVENT_TYPES:
                    break
        finally:
            stream.unsubscribe(stream_id, queue)

    return EventSourceResponse(
        event_generator(),
        ping=10,
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{task_id}/pay")
async def release_payment(
    task_id: str,
    user: CurrentUser,
) -> dict[str, str | bool]:
    """Release escrow payment for a completed task."""

    require_scope(user, "tasks:write")
    store = get_task_store()
    stream = get_stream_manager()
    payment_key = _task_payment_key(user.workspace_id, task_id)
    lease = await _acquire_task_run_lock(payment_key)
    if lease is None:
        raise HTTPException(status_code=409, detail="Payment release already in progress")

    try:
        raw_task = await _load_task_for_user(store, user.workspace_id, task_id)

        task = _to_status_response(raw_task, detailed=True)
        if task.status not in {"completed", "paid"}:
            raise HTTPException(
                status_code=409,
                detail=f"Task status is {task.status}; expected completed",
            )
        if task.status == "paid" or task.payment_status == "released":
            raise HTTPException(status_code=409, detail="Payment already released")
        resolved_quorum = _resolved_task_quorum(task)
        task.quorum_reached = resolved_quorum
        if not resolved_quorum:
            confidence = task.result.confidence if task.result is not None else None
            confidence_detail = (
                f" Final confidence was {confidence:.2f} against quorum threshold "
                f"{task.quorum_threshold:.2f}."
                if confidence is not None
                else ""
            )
            raise HTTPException(
                status_code=409,
                detail=(
                    "Payment can only be released after quorum is reached."
                    f"{confidence_detail}"
                ),
            )
        if not bridge.is_configured():
            raise HTTPException(status_code=503, detail="Solana bridge is not configured")

        _ensure_chain_operation(task, _RELEASE_PAYMENT_OPERATION)

        def on_payment_success(result: dict[str, Any]) -> None:
            task.status = "paid"
            task.payment_status = "released"
            _apply_chain_tx(task, result)

        async def reconcile_payment(
            current: ChainOperationRecord | None,
        ) -> dict[str, Any] | None:
            if current is None or current.status == "succeeded":
                return None
            onchain = await bridge.fetch_task_account(task_id)
            if onchain is None:
                return None
            if onchain.status != "paid":
                return None
            if onchain.payment_amount_lamports != 0:
                return None
            if await bridge.vault_account_exists(task_id):
                return None
            return {
                "tx_hash": current.tx_hash or "",
                "explorer_url": current.explorer_url or "",
                "task_pda": str(bridge.derive_task_pda(task_id)),
                "vault_pda": str(bridge.derive_vault_pda(task_id)),
            }

        if not _chain_operation_succeeded(task, _RELEASE_PAYMENT_OPERATION):
            await _attempt_chain_operation(
                store=store,
                workspace_id=user.workspace_id,
                task_id=task_id,
                task=task,
                operation_key=_RELEASE_PAYMENT_OPERATION,
                call=lambda: bridge.release_payment(task_id=task_id),
                strict_failure_detail="Failed to record payment on Solana",
                on_success=on_payment_success,
                reconcile=reconcile_payment,
            )
        else:
            payment_record = _chain_operation(task, _RELEASE_PAYMENT_OPERATION)
            if payment_record is not None:
                task.solana_tx_hash = payment_record.tx_hash or task.solana_tx_hash
                task.explorer_url = payment_record.explorer_url or task.explorer_url
            task.status = "paid"
            task.payment_status = "released"
            await _save_task_status(
                store=store,
                workspace_id=user.workspace_id,
                task_id=task_id,
                task=task,
            )

        payment_record = _chain_operation(task, _RELEASE_PAYMENT_OPERATION)
        if payment_record is None or payment_record.status != "succeeded":
            return {"released": False, "tx_hash": ""}

        await persist_and_emit(
            store=store,
            stream=stream,
            workspace_id=user.workspace_id,
            task_id=task_id,
            event_type="payment_released",
            event_data={
                "task_id": task_id,
                "tx_hash": payment_record.tx_hash or task.solana_tx_hash,
                "explorer_url": payment_record.explorer_url or task.explorer_url,
            },
        )

        return {"released": True, "tx_hash": payment_record.tx_hash or task.solana_tx_hash or ""}
    finally:
        await _release_task_run_lock(payment_key, lease_id=lease.lease_id)
