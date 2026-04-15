from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
import sys
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import ValidationError

from agora.types import DeliberationResult, MechanismType
from api import auth
from api.auth import AuthenticatedUser
from api.main import app
from api.models import TaskCreateRequest
from api.routes import tasks as task_routes
from api.routes import webhooks as webhook_routes
from api.store_local import LocalTaskStore
from api.streaming import DeliberationStream, get_stream_manager
from tests.helpers import make_selection


def _override_user() -> AuthenticatedUser:
    return AuthenticatedUser(id="user-1", email="user1@example.com", display_name="User One")


class _FakeSelectionOnlyOrchestrator:
    def __init__(self, agent_count: int):
        self.agent_count = agent_count
        self.selector = self

    async def select(self, task_text: str, agent_count: int, stakes: float):
        del task_text, agent_count, stakes
        return make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")


@pytest.fixture
async def client(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> AsyncIterator[httpx.AsyncClient]:
    data_dir = str(tmp_path / "data")
    task_routes._store = LocalTaskStore(data_dir=data_dir)
    task_routes._stream_tickets.clear()
    task_routes._running_task_keys.clear()
    app.dependency_overrides[auth.get_current_user] = _override_user

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client

    app.dependency_overrides.clear()
    task_routes._store = None
    task_routes._stream_tickets.clear()
    task_routes._running_task_keys.clear()


@pytest.mark.asyncio
async def test_jwt_auth_extracts_claims(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_decode(_raw_token: str) -> dict[str, str]:
        return {
            "sub": "user-123",
            "email": "josh@example.com",
            "name": "Josh",
        }

    monkeypatch.setattr(auth, "_decode_verified_token", fake_decode)

    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="dummy")
    user = await auth.get_current_user(creds)

    assert user.id == "user-123"
    assert user.email == "josh@example.com"
    assert user.display_name == "Josh"


@pytest.mark.asyncio
async def test_auth_allows_demo_fallback_when_auth_not_required(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "auth_required", False)
    monkeypatch.setattr(auth.settings, "demo_mode", True)
    monkeypatch.setattr(auth.settings, "environment", "development")

    user = await auth.get_current_user(None)

    assert user.id == "demo-user"
    assert user.email == "demo@example.com"


@pytest.mark.asyncio
async def test_auth_requires_token_when_auth_required(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "auth_required", True)
    monkeypatch.setattr(auth.settings, "demo_mode", False)

    with pytest.raises(HTTPException) as exc_info:
        await auth.get_current_user(None)

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "Missing bearer token"


@pytest.mark.asyncio
async def test_auth_surfaces_misconfiguration_when_required(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth.settings, "auth_required", True)
    monkeypatch.setattr(auth.settings, "demo_mode", False)

    def fail_decode(_raw_token: str) -> dict[str, str]:
        raise RuntimeError("Auth verification is not configured")

    monkeypatch.setattr(auth, "_decode_verified_token", fail_decode)

    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="dummy")
    with pytest.raises(HTTPException) as exc_info:
        await auth.get_current_user(creds)

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == "Authentication error"


@pytest.mark.asyncio
async def test_auth_rejects_unsafe_sub_claim(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(auth.settings, "auth_required", True)
    monkeypatch.setattr(auth.settings, "demo_mode", False)

    def fake_decode(_raw_token: str) -> dict[str, str]:
        return {
            "sub": "../user-123",
            "email": "josh@example.com",
            "name": "Josh",
        }

    monkeypatch.setattr(auth, "_decode_verified_token", fake_decode)

    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="dummy")
    with pytest.raises(HTTPException) as exc_info:
        await auth.get_current_user(creds)

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "Token has invalid sub claim"


@pytest.mark.asyncio
async def test_health_route_is_public(client: httpx.AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["service"] == "agora-api"


@pytest.mark.asyncio
async def test_cors_allows_vercel_and_localhost_origins(client: httpx.AsyncClient) -> None:
    for origin in (
        "https://agora-bay-seven.vercel.app",
        "http://localhost:4173",
    ):
        response = await client.options(
            "/tasks/",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )

        assert response.status_code == 200
        assert response.headers.get("access-control-allow-origin") == origin


@pytest.mark.asyncio
async def test_cors_denies_unlisted_origin(client: httpx.AsyncClient) -> None:
    response = await client.options(
        "/tasks/",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_task_routes_import_without_gcs_credentials() -> None:
    env = os.environ.copy()
    env["GOOGLE_CLOUD_PROJECT"] = "test-project"
    env["GOOGLE_APPLICATION_CREDENTIALS"] = "/tmp/nonexistent-agora-creds.json"
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from api.routes import tasks; print(tasks._store is None)",
        ],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "True"


@pytest.mark.asyncio
async def test_create_list_get_task_with_local_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "data"))
    try:
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeSelectionOnlyOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(
                task="Is this deterministic?",
                agent_count=3,
                stakes=0.0,
            ),
            _override_user(),
        )
        task_id = create.task_id
        assert len(task_id) == 64

        listing = await task_routes.list_tasks(_override_user())
        assert len(listing) == 1
        assert listing[0].task_id == task_id

        fetched = await task_routes.get_task_status(task_id, _override_user())
        assert fetched.status == "pending"
    finally:
        task_routes._store = None


def test_task_create_request_rejects_oversized_task() -> None:
    with pytest.raises(ValidationError):
        TaskCreateRequest(task="x" * 12_001, agent_count=3, stakes=0.0)


@pytest.mark.asyncio
async def test_run_rejects_task_already_in_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "in-progress-data"))
    try:
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeSelectionOnlyOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(task="already running", agent_count=3, stakes=0.0),
            _override_user(),
        )
        store = task_routes._store
        assert store is not None
        task = await store.get_task("user-1", create.task_id)
        assert task is not None
        task["status"] = "in_progress"
        await store.save_task("user-1", create.task_id, task)

        with pytest.raises(HTTPException) as exc_info:
            await task_routes.run_task(create.task_id, _override_user())
    finally:
        task_routes._store = None

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == "Task is already in progress"


@pytest.mark.asyncio
async def test_run_and_pay_use_bridge_and_surface_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "data"))
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")
    completed_result = DeliberationResult(
        task="run me",
        mechanism_used=MechanismType.DEBATE,
        mechanism_selection=selection,
        final_answer="Ship it.",
        confidence=0.88,
        quorum_reached=True,
        round_count=2,
        agent_count=5,
        mechanism_switches=0,
        merkle_root="receipt-root",
        transcript_hashes=["leaf-1", "leaf-2"],
        agent_models_used=[
            "gemini-3.1-pro-preview",
            "moonshotai/kimi-k2-thinking",
            "gemini-3-flash-preview",
            "claude-sonnet-4-6",
        ],
        convergence_history=[],
        locked_claims=[],
        total_tokens_used=42,
        total_latency_ms=12.5,
        timestamp=datetime.now(UTC),
    )

    class _FakeSelector:
        async def select(self, task_text: str, agent_count: int, stakes: float):
            del task_text, agent_count, stakes
            return selection

    class _FakeOrchestrator:
        def __init__(self, agent_count: int):
            self.agent_count = agent_count
            self.selector = _FakeSelector()

        async def run(
            self,
            task: str,
            stakes: float = 0.0,
            mechanism_override: str | None = None,
            event_sink=None,
        ) -> DeliberationResult:
            del stakes, mechanism_override
            if event_sink is not None:
                await event_sink(
                    "complete",
                    {
                        "task": task,
                        "mechanism": completed_result.mechanism_used.value,
                    },
                )
            return completed_result.model_copy(update={"task": task})

    async def init_ok(**_kwargs: object) -> dict[str, str]:
        return {"tx_hash": "init_tx", "explorer_url": "https://explorer/init_tx"}

    async def selection_ok(**_kwargs: object) -> dict[str, str]:
        return {"tx_hash": "selection_tx", "explorer_url": "https://explorer/selection_tx"}

    async def receipt_ok(
        *,
        task_id: str,
        merkle_root: str,
        decision_hash: str,
        quorum_reached: bool,
        final_mechanism: str | int,
    ) -> dict[str, str]:
        del task_id, decision_hash, quorum_reached, final_mechanism
        assert merkle_root == completed_result.merkle_root
        return {"tx_hash": "receipt_tx", "explorer_url": "https://explorer/receipt_tx"}

    async def pay_ok(**_kwargs: object) -> dict[str, str]:
        return {"tx_hash": "pay_tx", "explorer_url": "https://explorer/pay_tx"}

    try:
        monkeypatch.setattr(task_routes.settings, "strict_chain_writes", True)
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: True)
        monkeypatch.setattr(task_routes.bridge, "initialize_task", init_ok)
        monkeypatch.setattr(task_routes.bridge, "record_selection", selection_ok)
        monkeypatch.setattr(task_routes.bridge, "submit_receipt", receipt_ok)
        monkeypatch.setattr(task_routes.bridge, "release_payment", pay_ok)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(task="run me", agent_count=5, stakes=0.5),
            _override_user(),
        )
        task_id = create.task_id

        run_resp = await task_routes.run_task(task_id, _override_user())
        assert run_resp.final_answer == "Ship it."
        assert run_resp.agent_count == 5
        assert run_resp.agent_models_used == [
            "gemini-3.1-pro-preview",
            "moonshotai/kimi-k2-thinking",
            "gemini-3-flash-preview",
            "claude-sonnet-4-6",
        ]

        status_resp = await task_routes.get_task_status(task_id, _override_user())
        assert status_resp.status == "completed"
        assert status_resp.solana_tx_hash == "receipt_tx"

        pay_resp = await task_routes.release_payment(task_id, _override_user())
        assert pay_resp["released"] is True
        assert pay_resp["tx_hash"] == "pay_tx"

        async def receipt_fail(**_kwargs: object) -> dict[str, str]:
            raise RuntimeError("bridge down")

        create2 = await task_routes.create_task(
            TaskCreateRequest(task="fails on run", agent_count=3, stakes=0.0),
            _override_user(),
        )
        task_id_fail = create2.task_id

        monkeypatch.setattr(task_routes.bridge, "submit_receipt", receipt_fail)
        with pytest.raises(HTTPException) as exc_info:
            await task_routes.run_task(task_id_fail, _override_user())
        assert exc_info.value.status_code == 502
        failed_status = await task_routes.get_task_status(
            task_id_fail,
            _override_user(),
            detailed=True,
        )
        assert failed_status.status == "failed"
        assert any(event.event == "error" for event in failed_status.events)
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_persist_and_emit_preserves_full_timestamped_envelope(
    tmp_path: Path,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "stream-data"))
    stream = DeliberationStream()
    user = _override_user()
    task_id = "task-stream-live"
    task_payload = {
        "task_id": task_id,
        "task_text": "Stream this task",
        "mechanism": "vote",
        "status": "pending",
        "selector_reasoning": "Use vote.",
        "selector_reasoning_hash": "selector-hash",
        "selector_confidence": 0.9,
        "agent_count": 3,
        "payment_amount": 0.0,
        "payment_status": "none",
        "created_at": datetime.now(UTC).isoformat(),
        "events": [],
    }
    await store.upsert_user(user.id, user.email, user.display_name)
    await store.save_task(user.id, task_id, task_payload)

    stream_id = task_routes._stream_key(user.id, task_id)
    queue = stream.subscribe(stream_id)
    try:
        await task_routes.persist_and_emit(
            store=store,
            stream=stream,
            user_id=user.id,
            task_id=task_id,
            event_type="agent_output",
            event_data={"agent_id": "agent-1", "content": "BTC"},
        )

        live_payload = await queue.get()
        stored_events = await store.get_events(user.id, task_id)
    finally:
        stream.unsubscribe(stream_id, queue)

    assert set(live_payload) == {"event", "data", "timestamp"}
    assert stored_events == [live_payload]
    assert live_payload["event"] == "agent_output"
    assert live_payload["data"]["content"] == "BTC"
    assert live_payload["timestamp"] is not None


@pytest.mark.asyncio
async def test_stream_task_replays_timestamped_event_envelopes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "stream-replay"))
    user = _override_user()
    task_id = "task-stream-replay"
    task_payload = {
        "task_id": task_id,
        "task_text": "Replay this task",
        "mechanism": "vote",
        "status": "completed",
        "selector_reasoning": "Use vote.",
        "selector_reasoning_hash": "selector-hash",
        "selector_confidence": 0.9,
        "agent_count": 3,
        "payment_amount": 0.0,
        "payment_status": "none",
        "created_at": datetime.now(UTC).isoformat(),
        "events": [],
    }

    class _CapturedEventSourceResponse:
        def __init__(self, content):
            self.content = content

    task_routes._store = store
    await store.upsert_user(user.id, user.email, user.display_name)
    await store.save_task(user.id, task_id, task_payload)
    first_event = {
        "event": "agent_output",
        "data": {"agent_id": "agent-1", "content": "BTC"},
        "timestamp": "2026-04-14T13:00:00+00:00",
    }
    second_event = {
        "event": "complete",
        "data": {"task_id": task_id, "status": "completed"},
        "timestamp": "2026-04-14T13:00:01+00:00",
    }
    await store.append_event(user.id, task_id, first_event)
    await store.append_event(user.id, task_id, second_event)
    monkeypatch.setattr(task_routes, "EventSourceResponse", _CapturedEventSourceResponse)

    try:
        ticket = task_routes._issue_stream_ticket(user.id, task_id)["ticket"]
        response = await task_routes.stream_task(task_id, ticket=ticket)
        replayed_events = [item async for item in response.content]
    finally:
        task_routes._store = None
        task_routes._stream_tickets.clear()

    assert replayed_events == [first_event, second_event]
    assert all(set(item) == {"event", "data", "timestamp"} for item in replayed_events)


@pytest.mark.asyncio
async def test_stream_ticket_is_one_use_and_namespaced(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "stream-ticket"))
    user = _override_user()
    task_id = "task-stream-ticket"
    task_payload = {
        "task_id": task_id,
        "task_text": "Ticket this task",
        "created_by": user.id,
        "mechanism": "vote",
        "status": "completed",
        "selector_reasoning": "Use vote.",
        "selector_reasoning_hash": "selector-hash",
        "selector_confidence": 0.9,
        "agent_count": 3,
        "payment_amount": 0.0,
        "payment_status": "none",
        "created_at": datetime.now(UTC).isoformat(),
        "events": [
            {
                "event": "complete",
                "data": {"task_id": task_id, "status": "completed"},
                "timestamp": "2026-04-14T13:00:00+00:00",
            }
        ],
    }

    class _CapturedEventSourceResponse:
        def __init__(self, content):
            self.content = content

    task_routes._store = store
    await store.upsert_user(user.id, user.email, user.display_name)
    await store.save_task(user.id, task_id, task_payload)
    ticket = await task_routes.create_stream_ticket(task_id, user)

    try:
        assert "ticket" in ticket
        monkeypatch.setattr(task_routes, "EventSourceResponse", _CapturedEventSourceResponse)
        first = await task_routes.stream_task(task_id, ticket=ticket["ticket"])
        assert [item async for item in first.content] == task_payload["events"]
        with pytest.raises(HTTPException) as exc_info:
            await task_routes.stream_task(task_id, ticket=ticket["ticket"])
    finally:
        task_routes._store = None
        task_routes._stream_tickets.clear()

    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_task_routes_hide_cross_user_and_malformed_ids(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "tenant-data"))
    owner = _override_user()
    other = AuthenticatedUser(id="user-2", email="user2@example.com", display_name="User Two")
    task_payload = {
        "task_id": "task-owned",
        "task_text": "Owned task",
        "created_by": owner.id,
        "mechanism": "vote",
        "status": "pending",
        "selector_reasoning": "Use vote.",
        "selector_reasoning_hash": "selector-hash",
        "selector_confidence": 0.9,
        "agent_count": 3,
        "payment_amount": 0.0,
        "payment_status": "none",
        "created_at": datetime.now(UTC).isoformat(),
        "events": [],
    }

    task_routes._store = store
    await store.upsert_user(owner.id, owner.email, owner.display_name)
    await store.save_task(owner.id, "task-owned", task_payload)
    try:
        with pytest.raises(HTTPException) as cross_user:
            await task_routes.get_task_status("task-owned", other)
        with pytest.raises(HTTPException) as malformed:
            await task_routes.get_task_status("../task-owned", owner)
    finally:
        task_routes._store = None

    assert cross_user.value.status_code == 404
    assert malformed.value.status_code == 404


@pytest.mark.asyncio
async def test_solana_webhook_requires_valid_signature(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(webhook_routes.settings, "webhook_secret", "webhook-secret")
    body = json.dumps(
        [{"task_id": "task-webhook", "user_id": "user-1", "signature": "tx-signature"}]
    ).encode("utf-8")

    response = await client.post(
        "/webhooks/solana",
        content=body,
        headers={
            "content-type": "application/json",
            "x-agora-signature": "sha256=bad-signature",
        },
    )

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_solana_webhook_emits_signed_namespaced_event(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "webhook-secret"
    monkeypatch.setattr(webhook_routes.settings, "webhook_secret", secret)
    body = json.dumps(
        [{"task_id": "task-webhook", "user_id": "user-1", "signature": "tx-signature"}]
    ).encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    manager = get_stream_manager()
    stream_id = task_routes._stream_key("user-1", "task-webhook")
    queue = manager.subscribe(stream_id)

    try:
        response = await client.post(
            "/webhooks/solana",
            content=body,
            headers={
                "content-type": "application/json",
                "x-agora-signature": f"sha256={signature}",
            },
        )
        event = await queue.get()
    finally:
        manager.unsubscribe(stream_id, queue)

    assert response.status_code == 200
    assert event is not None
    assert event["event"] == "receipt_confirmed"
    assert event["data"]["task_id"] == "task-webhook"
    assert event["data"]["signature"] == "tx-signature"


@pytest.mark.asyncio
async def test_create_task_continues_when_chain_init_fails_in_non_strict_mode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "data"))

    async def init_fail(**_kwargs: object) -> dict[str, str]:
        raise RuntimeError("bridge unavailable")

    async def record_selection_ok(**_kwargs: object) -> dict[str, str]:
        return {"tx_hash": "selection_tx", "explorer_url": "https://explorer/selection_tx"}

    try:
        monkeypatch.setattr(task_routes.settings, "strict_chain_writes", False)
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: True)
        monkeypatch.setattr(task_routes.bridge, "initialize_task", init_fail)
        monkeypatch.setattr(task_routes.bridge, "record_selection", record_selection_ok)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeSelectionOnlyOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(task="allow soft chain failure", agent_count=3, stakes=0.0),
            _override_user(),
        )

        fetched = await task_routes.get_task_status(create.task_id, _override_user())
        assert fetched.status == "pending"
        assert fetched.solana_tx_hash is None
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_run_task_honors_env_forced_mechanism_and_serializes_models(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "forced-mechanism-data"))
    selection = make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")
    captured: dict[str, object] = {}

    class _FakeSelector:
        async def select(self, task_text: str, agent_count: int, stakes: float):
            del task_text, agent_count, stakes
            return selection

    class _ForcedMechanismOrchestrator:
        def __init__(self, agent_count: int):
            captured["agent_count"] = agent_count
            self.agent_count = agent_count
            self.selector = _FakeSelector()

        async def run(
            self,
            task: str,
            stakes: float = 0.0,
            mechanism_override: str | MechanismType | None = None,
            event_sink=None,
        ) -> DeliberationResult:
            del stakes, event_sink
            captured["task"] = task
            captured["mechanism_override"] = mechanism_override
            return DeliberationResult(
                task=task,
                mechanism_used=MechanismType.VOTE,
                mechanism_selection=selection,
                final_answer="four-model answer",
                confidence=0.88,
                quorum_reached=True,
                round_count=1,
                agent_count=4,
                mechanism_switches=0,
                merkle_root="real-root",
                transcript_hashes=["h1", "h2", "h3", "h4"],
                agent_models_used=[
                    "gemini-3.1-pro-preview",
                    "moonshotai/kimi-k2-thinking",
                    "gemini-3-flash-preview",
                    "claude-sonnet-4-6",
                ],
                convergence_history=[],
                locked_claims=[],
                total_tokens_used=44,
                total_latency_ms=123.0,
                timestamp=datetime.now(UTC),
            )

    try:
        monkeypatch.setattr(task_routes.settings, "api_force_mechanism", "vote")
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _ForcedMechanismOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(task="run real mode", agent_count=4, stakes=0.0),
            _override_user(),
        )
        task_id = create.task_id

        run_resp = await task_routes.run_task(task_id, _override_user())

        assert captured["agent_count"] == 4
        assert captured["mechanism_override"] == MechanismType.VOTE
        assert run_resp.mechanism == "vote"
        assert run_resp.agent_count == 4
        assert run_resp.agent_models_used == [
            "gemini-3.1-pro-preview",
            "moonshotai/kimi-k2-thinking",
            "gemini-3-flash-preview",
            "claude-sonnet-4-6",
        ]
        assert run_resp.total_tokens_used == 44
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_run_task_honors_request_mechanism_override_without_env_force(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "request-override-data"))
    captured: dict[str, object] = {}

    class _FakeSelector:
        async def select(self, task_text: str, agent_count: int, stakes: float):
            del task_text, agent_count, stakes
            return make_selection(mechanism=MechanismType.DEBATE, topic_category="reasoning")

    class _RequestOverrideOrchestrator:
        def __init__(self, agent_count: int):
            captured["agent_count"] = agent_count
            self.agent_count = agent_count
            self.selector = _FakeSelector()

        async def run(
            self,
            task: str,
            stakes: float = 0.0,
            mechanism_override: str | MechanismType | None = None,
            event_sink=None,
        ) -> DeliberationResult:
            del stakes, event_sink
            captured["task"] = task
            captured["mechanism_override"] = mechanism_override
            selection = make_selection(mechanism=MechanismType.VOTE, topic_category="reasoning")
            return DeliberationResult(
                task=task,
                mechanism_used=MechanismType.VOTE,
                mechanism_selection=selection,
                final_answer="request override answer",
                confidence=0.91,
                quorum_reached=True,
                round_count=1,
                agent_count=4,
                mechanism_switches=0,
                merkle_root="request-override-root",
                transcript_hashes=["h1", "h2", "h3", "h4"],
                agent_models_used=[
                    "gemini-3.1-pro-preview",
                    "moonshotai/kimi-k2-thinking",
                    "gemini-3-flash-preview",
                    "claude-sonnet-4-6",
                ],
                convergence_history=[],
                locked_claims=[],
                total_tokens_used=45,
                total_latency_ms=111.0,
                timestamp=datetime.now(UTC),
            )

        async def execute_selection(self, **_kwargs):
            raise AssertionError("execute_selection should not be used when override is persisted")

    try:
        monkeypatch.setattr(task_routes.settings, "api_force_mechanism", "")
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _RequestOverrideOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(
                task="run request override",
                agent_count=4,
                stakes=0.0,
                mechanism_override="vote",
            ),
            _override_user(),
        )
        task_id = create.task_id

        assert create.mechanism == "vote"

        run_resp = await task_routes.run_task(task_id, _override_user())

        assert captured["agent_count"] == 4
        assert captured["mechanism_override"] == MechanismType.VOTE
        assert run_resp.mechanism == "vote"
        assert run_resp.agent_count == 4
        assert run_resp.agent_models_used == [
            "gemini-3.1-pro-preview",
            "moonshotai/kimi-k2-thinking",
            "gemini-3-flash-preview",
            "claude-sonnet-4-6",
        ]
    finally:
        task_routes._store = None


@pytest.mark.asyncio
async def test_pay_validates_quorum_and_status(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "data"))
    try:
        monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)
        monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeSelectionOnlyOrchestrator)

        create = await task_routes.create_task(
            TaskCreateRequest(task="no quorum", agent_count=3, stakes=0.3),
            _override_user(),
        )
        task_id = create.task_id

        store = task_routes._store
        assert store is not None
        task = await store.get_task("user-1", task_id)
        assert task is not None
        task["status"] = "completed"
        task["quorum_reached"] = False
        task["payment_status"] = "locked"
        await store.save_task("user-1", task_id, task)

        with pytest.raises(HTTPException) as exc_info:
            await task_routes.release_payment(task_id, _override_user())
        assert exc_info.value.status_code == 409
    finally:
        task_routes._store = None


def test_task_id_to_bytes_is_32_bytes() -> None:
    task_id = task_routes._build_task_id("A long enough task")
    task_bytes = bytes.fromhex(task_id)

    assert len(task_id) == 64
    assert len(task_bytes) == 32
