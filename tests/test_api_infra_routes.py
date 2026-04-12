from __future__ import annotations

import asyncio
import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient

from api import auth
from api.auth import AuthenticatedUser
from api.main import app
from api.routes import tasks as task_routes
from api.store_local import LocalTaskStore


def _override_user() -> AuthenticatedUser:
    return AuthenticatedUser(id="user-1", email="user1@example.com", display_name="User One")


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: pytest.TempPathFactory) -> TestClient:
    data_dir = str(tmp_path / "data")
    task_routes._store = LocalTaskStore(data_dir=data_dir)
    app.dependency_overrides[auth.get_current_user] = _override_user

    yield TestClient(app)

    app.dependency_overrides.clear()


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


def test_health_route_is_public(client: TestClient) -> None:
    response = client.get("/health")

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


def test_create_list_get_task_with_local_store(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)

    create = client.post(
        "/tasks/",
        json={"task": "Is this deterministic?", "agent_count": 3, "stakes": 0.0},
    )
    assert create.status_code == 200
    task_id = create.json()["task_id"]
    assert len(task_id) == 64

    listing = client.get("/tasks/")
    assert listing.status_code == 200
    assert len(listing.json()) == 1
    assert listing.json()[0]["task_id"] == task_id

    fetched = client.get(f"/tasks/{task_id}")
    assert fetched.status_code == 200
    assert fetched.json()["status"] == "pending"


def test_run_and_pay_use_bridge_and_surface_errors(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def init_ok(**_kwargs: object) -> dict[str, str]:
        return {"tx_hash": "init_tx", "explorer_url": "https://explorer/init_tx"}

    async def selection_ok(**_kwargs: object) -> dict[str, str]:
        return {"tx_hash": "selection_tx", "explorer_url": "https://explorer/selection_tx"}

    async def receipt_ok(**_kwargs: object) -> dict[str, str]:
        return {"tx_hash": "receipt_tx", "explorer_url": "https://explorer/receipt_tx"}

    async def pay_ok(**_kwargs: object) -> dict[str, str]:
        return {"tx_hash": "pay_tx", "explorer_url": "https://explorer/pay_tx"}

    monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: True)
    monkeypatch.setattr(task_routes.bridge, "initialize_task", init_ok)
    monkeypatch.setattr(task_routes.bridge, "record_selection", selection_ok)
    monkeypatch.setattr(task_routes.bridge, "submit_receipt", receipt_ok)
    monkeypatch.setattr(task_routes.bridge, "release_payment", pay_ok)

    create = client.post(
        "/tasks/",
        json={"task": "run me", "agent_count": 5, "stakes": 0.5},
    )
    assert create.status_code == 200
    task_id = create.json()["task_id"]

    run_resp = client.post(f"/tasks/{task_id}/run")
    assert run_resp.status_code == 200

    status_resp = client.get(f"/tasks/{task_id}")
    assert status_resp.status_code == 200
    assert status_resp.json()["status"] == "completed"
    assert status_resp.json()["solana_tx_hash"] == "receipt_tx"

    pay_resp = client.post(f"/tasks/{task_id}/pay")
    assert pay_resp.status_code == 200
    assert pay_resp.json()["released"] is True
    assert pay_resp.json()["tx_hash"] == "pay_tx"

    async def receipt_fail(**_kwargs: object) -> dict[str, str]:
        raise RuntimeError("bridge down")

    create2 = client.post(
        "/tasks/",
        json={"task": "fails on run", "agent_count": 3, "stakes": 0.0},
    )
    assert create2.status_code == 200
    task_id_fail = create2.json()["task_id"]

    monkeypatch.setattr(task_routes.bridge, "submit_receipt", receipt_fail)
    run_fail = client.post(f"/tasks/{task_id_fail}/run")
    assert run_fail.status_code == 502


def test_pay_validates_quorum_and_status(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: False)

    create = client.post(
        "/tasks/",
        json={"task": "no quorum", "agent_count": 3, "stakes": 0.3},
    )
    assert create.status_code == 200
    task_id = create.json()["task_id"]

    task = asyncio.run(task_routes._store.get_task("user-1", task_id))
    assert task is not None
    task["status"] = "completed"
    task["quorum_reached"] = False
    task["payment_status"] = "locked"
    asyncio.run(task_routes._store.save_task("user-1", task_id, task))

    pay_resp = client.post(f"/tasks/{task_id}/pay")
    assert pay_resp.status_code == 409


def test_task_id_to_bytes_is_32_bytes() -> None:
    task_id = task_routes._build_task_id("A long enough task")
    task_bytes = bytes.fromhex(task_id)

    assert len(task_id) == 64
    assert len(task_bytes) == 32
    assert task_id == hashlib.sha256(b"A long enough task").hexdigest()
