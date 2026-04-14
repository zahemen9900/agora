from __future__ import annotations

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

from agora.types import DeliberationResult, MechanismType
from api import auth
from api.auth import AuthenticatedUser
from api.main import app
from api.models import TaskCreateRequest
from api.routes import tasks as task_routes
from api.store_local import LocalTaskStore
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
    app.dependency_overrides[auth.get_current_user] = _override_user

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client

    app.dependency_overrides.clear()
    task_routes._store = None


@pytest.mark.asyncio
async def test_jwt_auth_extracts_claims(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_decode(*_args: object, **_kwargs: object) -> dict[str, str]:
        return {
            "sub": "user-123",
            "email": "josh@example.com",
            "name": "Josh",
        }

    monkeypatch.setattr(auth.jwt, "decode", fake_decode)

    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="dummy")
    user = await auth.get_current_user(creds)

    assert user.id == "user-123"
    assert user.email == "josh@example.com"
    assert user.display_name == "Josh"


@pytest.mark.asyncio
async def test_health_route_is_public(client: httpx.AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["service"] == "agora-api"


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
