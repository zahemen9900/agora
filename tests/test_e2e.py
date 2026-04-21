from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from agora.runtime.hasher import TranscriptHasher
from agora.types import DeliberationResult, MechanismType
from api.auth import AuthenticatedUser
from api.auth_keys import DEFAULT_API_KEY_SCOPES
from api.models import TaskCreateRequest
from api.routes import tasks as task_routes
from api.store_local import LocalTaskStore
from tests.helpers import make_selection

_DEFAULT_HOSTED_API_URL = "https://agora-api-dcro4pg6ca-uc.a.run.app"


def _override_user() -> AuthenticatedUser:
    return AuthenticatedUser(
        auth_method="jwt",
        workspace_id="user-1",
        user_id="user-1",
        email="user1@example.com",
        display_name="User One",
        scopes=list(DEFAULT_API_KEY_SCOPES),
    )


@pytest.mark.asyncio
async def test_local_api_e2e_flow(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    hasher = TranscriptHasher()
    selection = make_selection(mechanism=MechanismType.VOTE, topic_category="math")
    transcript_hashes = [
        hasher.hash_content("agent-1: 345"),
        hasher.hash_content("agent-2: 345"),
        hasher.hash_content("agent-3: 345"),
    ]
    merkle_root = hasher.build_merkle_tree(transcript_hashes)

    class _FakeSelector:
        async def select(self, task_text: str, agent_count: int, stakes: float):
            del task_text, agent_count, stakes
            return selection

    class _FakeOrchestrator:
        def __init__(self, agent_count: int, reasoning_presets=None):
            self.agent_count = agent_count
            self.reasoning_presets = reasoning_presets
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
                    "agent_output",
                    {
                        "agent_id": "agent-1",
                        "role": "voter",
                        "faction": "vote",
                        "content": "345",
                    },
                )

            return DeliberationResult(
                task=task,
                mechanism_used=MechanismType.VOTE,
                mechanism_selection=selection,
                final_answer="345",
                confidence=0.94,
                quorum_reached=True,
                round_count=1,
                agent_count=self.agent_count,
                mechanism_switches=0,
                merkle_root=merkle_root,
                transcript_hashes=transcript_hashes,
                agent_models_used=[
                    "gemini-3-flash-preview",
                    "moonshotai/kimi-k2-thinking",
                    "gemini-3.1-flash-lite-preview",
                ],
                convergence_history=[],
                locked_claims=[],
                total_tokens_used=24,
                total_latency_ms=12.0,
                timestamp=datetime.now(UTC),
            )

    async def init_ok(**_kwargs: object) -> dict[str, str]:
        return {
            "tx_hash": "init_tx",
            "explorer_url": "https://explorer.solana.com/tx/init_tx?cluster=devnet",
        }

    async def selection_ok(**_kwargs: object) -> dict[str, str]:
        return {
            "tx_hash": "selection_tx",
            "explorer_url": "https://explorer.solana.com/tx/selection_tx?cluster=devnet",
        }

    async def receipt_ok(
        *,
        task_id: str,
        merkle_root: str,
        decision_hash: str,
        quorum_reached: bool,
        final_mechanism: str | int,
    ) -> dict[str, str]:
        del task_id, decision_hash, quorum_reached, final_mechanism
        assert merkle_root == hasher.build_merkle_tree(transcript_hashes)
        return {
            "tx_hash": "receipt_tx",
            "explorer_url": "https://explorer.solana.com/tx/receipt_tx?cluster=devnet",
        }

    async def pay_ok(**_kwargs: object) -> dict[str, str]:
        return {
            "tx_hash": "pay_tx",
            "explorer_url": "https://explorer.solana.com/tx/pay_tx?cluster=devnet",
        }

    task_routes._store = LocalTaskStore(data_dir=str(tmp_path / "e2e-data"))
    monkeypatch.setattr(task_routes, "AgoraOrchestrator", _FakeOrchestrator)
    monkeypatch.setattr(task_routes.bridge, "is_configured", lambda: True)
    monkeypatch.setattr(task_routes.bridge, "initialize_task", init_ok)
    monkeypatch.setattr(task_routes.bridge, "record_selection", selection_ok)
    monkeypatch.setattr(task_routes.bridge, "submit_receipt", receipt_ok)
    monkeypatch.setattr(task_routes.bridge, "release_payment", pay_ok)
    user = _override_user()

    create = await task_routes.create_task(
        TaskCreateRequest(task="What is 15 * 23?", agent_count=3, stakes=0.01),
        user,
    )
    task_id = create.task_id

    run_response = await task_routes.run_task(task_id, user)
    assert run_response.merkle_root == merkle_root
    assert run_response.quorum_reached is True
    assert run_response.agent_count == 3
    assert run_response.agent_models_used == [
        "gemini-3-flash-preview",
        "moonshotai/kimi-k2-thinking",
        "gemini-3.1-flash-lite-preview",
    ]

    status_response = await task_routes.get_task_status(task_id, user, detailed=True)
    assert status_response.solana_tx_hash == "receipt_tx"
    assert str(status_response.explorer_url).endswith("cluster=devnet")
    assert status_response.result is not None
    assert status_response.result.transcript_hashes == transcript_hashes
    assert hasher.build_merkle_tree(status_response.result.transcript_hashes) == merkle_root

    pay_response = await task_routes.release_payment(task_id, user)
    assert pay_response["released"] is True
    assert pay_response["tx_hash"] == "pay_tx"
    task_routes._store = None


@pytest.mark.skipif(
    os.getenv("RUN_HOSTED_E2E", "").lower() not in {"1", "true", "yes", "on"},
    reason="Hosted Cloud Run + devnet smoke is opt-in.",
)
def test_hosted_cloud_run_devnet_e2e() -> None:
    api_url = os.getenv("AGORA_API_URL", _DEFAULT_HOSTED_API_URL).rstrip("/")
    token = os.getenv("AGORA_TEST_API_KEY")
    if not token:
        pytest.skip("Set AGORA_TEST_API_KEY to run hosted E2E against the deployed API.")
    unique_task = f"What is 15 * 23? run={datetime.now(UTC).isoformat()}"
    headers = {"Authorization": f"Bearer {token}"}
    hasher = TranscriptHasher()

    with httpx.Client(base_url=api_url, headers=headers, timeout=240.0) as client:
        create = client.post(
            "/tasks/",
            json={"task": unique_task, "agent_count": 3, "stakes": 0.01},
        )
        create.raise_for_status()
        task_id = create.json()["task_id"]

        run = client.post(f"/tasks/{task_id}/run")
        run.raise_for_status()

        status = client.get(f"/tasks/{task_id}", params={"detailed": "true"})
        status.raise_for_status()
        payload = status.json()
        result = payload["result"]

        assert result["final_answer"]
        assert result["confidence"] > 0.5
        assert result["merkle_root"]
        transcript_hashes = result.get("transcript_hashes") or payload.get("transcript_hashes")
        if transcript_hashes:
            assert hasher.build_merkle_tree(transcript_hashes) == result["merkle_root"]
        else:
            assert payload.get("merkle_root") == result["merkle_root"]
        assert payload["solana_tx_hash"]
        assert "cluster=devnet" in str(payload.get("explorer_url"))

        pay = client.post(f"/tasks/{task_id}/pay")
        pay.raise_for_status()
        pay_payload = pay.json()
        assert pay_payload["released"] is True


def test_phase2_demo_rejects_unsafe_overrides_without_flag(tmp_path: Path) -> None:
    output_path = tmp_path / "phase2_demo_override_rejected.json"
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")

    result = subprocess.run(
        [
            sys.executable,
            "scripts/phase2_demo.py",
            "--output",
            str(output_path),
            "--stakes",
            "0.02",
        ],
        check=False,
        text=True,
        capture_output=True,
        env=env,
    )

    assert result.returncode != 0
    assert output_path.exists()
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert "Strict phase 2 demo defaults are enforced" in payload["error"]


@pytest.mark.skipif(
    os.getenv("RUN_PHASE2_DEMO", "").lower() not in {"1", "true", "yes", "on"},
    reason="Strict phase 2 live demo smoke is opt-in.",
)
def test_phase2_demo_script_live(tmp_path: Path) -> None:
    output_path = tmp_path / "phase2_demo_live.json"
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    subprocess.run(
        [
            sys.executable,
            "scripts/phase2_demo.py",
            "--output",
            str(output_path),
            "--target",
            "local",
        ],
        check=True,
        env=env,
    )
    assert output_path.exists()

    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["status"] == "passed"
    assert payload["selected_mechanism"] == "vote"
    assert payload["final_status"] == "paid"
    assert payload["payment_status"] == "released"
    assert payload["revoked_key_reuse_status"] == 401
    assert payload["initialize_tx_hash"]
    assert payload["receipt_tx_hash"]
    assert payload["payment_tx_hash"]
    assert len(payload["agent_models_used"]) == 4
    assert payload["receipt_verification"]["merkle_match"] is True
    assert payload["receipt_verification"]["hosted_metadata_match"] is True
