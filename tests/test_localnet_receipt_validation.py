from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import time
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from solders.keypair import Keypair

from agora.runtime.hasher import TranscriptHasher
from agora.sdk import AgoraArbitrator
from agora.types import DeliberationResult, MechanismSelection, MechanismType, TaskFeatures
from api.solana_bridge import SolanaBridge

_SOLANA_BIN_DIR = Path.home() / ".local" / "share" / "solana" / "install" / "active_release" / "bin"
_SOLANA_VALIDATOR = _SOLANA_BIN_DIR / "solana-test-validator"
_PROGRAM_SO = (
    Path(__file__).resolve().parents[1] / "contract" / "target" / "deploy" / "agora.so"
)
_PROGRAM_KEYPAIR = (
    Path(__file__).resolve().parents[1]
    / "contract"
    / "target"
    / "deploy"
    / "agora-keypair.json"
)


@dataclass(frozen=True)
class _LocalnetEnvironment:
    rpc_url: str
    program_id: str
    wallet_path: Path


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _program_id() -> str:
    secret = json.loads(_PROGRAM_KEYPAIR.read_text(encoding="utf-8"))
    return str(Keypair.from_bytes(bytes(secret)).pubkey())


def _wait_for_rpc(rpc_url: str, *, timeout_seconds: float = 30.0) -> None:
    deadline = time.time() + timeout_seconds
    payload = {"jsonrpc": "2.0", "id": 1, "method": "getHealth"}

    while time.time() < deadline:
        try:
            response = httpx.post(rpc_url, json=payload, timeout=1.0)
            response.raise_for_status()
            body = response.json()
            if body.get("result") == "ok":
                return
        except Exception:
            time.sleep(0.25)
            continue
        time.sleep(0.25)

    raise RuntimeError(f"Local validator did not become healthy at {rpc_url}")


def _deploy_program(rpc_url: str, wallet_path: Path, env: dict[str, str]) -> None:
    solana = _SOLANA_BIN_DIR / "solana"
    if not solana.exists():
        pytest.skip("solana CLI is not installed")

    subprocess.run(
        [
            str(solana),
            "--url",
            rpc_url,
            "--keypair",
            str(wallet_path),
            "program",
            "deploy",
            "--use-rpc",
            "--commitment",
            "finalized",
            "--program-id",
            str(_PROGRAM_KEYPAIR),
            str(_PROGRAM_SO),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )

    subprocess.run(
        [
            str(solana),
            "--url",
            rpc_url,
            "program",
            "show",
            "--commitment",
            "finalized",
            _program_id(),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getAccountInfo",
        "params": [_program_id(), {"encoding": "base64", "commitment": "finalized"}],
    }
    response = httpx.post(rpc_url, json=payload, timeout=5.0)
    response.raise_for_status()
    account = response.json()["result"]["value"]
    if account is None or account.get("executable") is not True:
        raise RuntimeError(f"Local validator did not expose executable program {_program_id()}")


@pytest.fixture
def localnet_environment(tmp_path: Path) -> _LocalnetEnvironment:
    if not _SOLANA_VALIDATOR.exists():
        pytest.skip("solana-test-validator is not installed")
    if not _PROGRAM_SO.exists() or not _PROGRAM_KEYPAIR.exists():
        pytest.skip("compiled Anchor program artifacts are missing")

    wallet = Keypair()
    wallet_path = tmp_path / "localnet-wallet.json"
    wallet_path.write_text(json.dumps(list(bytes(wallet))), encoding="utf-8")

    rpc_port = _pick_free_port()
    faucet_port = _pick_free_port()
    gossip_port = _pick_free_port()
    dynamic_port_min = _pick_free_port()
    dynamic_port_max = dynamic_port_min + 25
    ledger_dir = tmp_path / "ledger"
    log_path = tmp_path / "validator.log"
    rpc_url = f"http://127.0.0.1:{rpc_port}"
    env = os.environ.copy()
    env["PATH"] = f"{_SOLANA_BIN_DIR}:{env.get('PATH', '')}"

    with log_path.open("w", encoding="utf-8") as log_handle:
        process = subprocess.Popen(
            [
                str(_SOLANA_VALIDATOR),
                "--reset",
                "--ledger",
                str(ledger_dir),
                "--rpc-port",
                str(rpc_port),
                "--faucet-port",
                str(faucet_port),
                "--gossip-port",
                str(gossip_port),
                "--dynamic-port-range",
                f"{dynamic_port_min}-{dynamic_port_max}",
                "--mint",
                str(wallet.pubkey()),
            ],
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            env=env,
        )

    try:
        _wait_for_rpc(rpc_url)
        _deploy_program(rpc_url, wallet_path, env)
        yield _LocalnetEnvironment(
            rpc_url=rpc_url,
            program_id=_program_id(),
            wallet_path=wallet_path,
        )
    finally:
        process.terminate()
        with suppress(subprocess.TimeoutExpired):
            process.wait(timeout=10)
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)


@pytest.mark.asyncio
@pytest.mark.localnet_integration
async def test_sdk_verify_receipt_strict_succeeds_against_localnet(
    localnet_environment: _LocalnetEnvironment,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hasher = TranscriptHasher()
    task_text = "Should we switch from debate to vote for this task?"
    task_id = hashlib.sha256(task_text.encode("utf-8")).hexdigest()
    task_hash = hashlib.sha256(task_text.encode("utf-8")).hexdigest()
    selector_reasoning = "Initial routing prefers debate before switching to vote."
    selector_reasoning_hash = hashlib.sha256(selector_reasoning.encode("utf-8")).hexdigest()
    switch_reason = "Observed disagreement stayed low enough to finalize with vote."
    switch_reason_hash = hasher.hash_content(switch_reason)
    final_answer = "Use vote for the final decision."
    transcript_hashes = [
        hasher.hash_content("agent-1: Use vote for the final decision."),
        hasher.hash_content("agent-2: Use vote for the final decision."),
        hasher.hash_content("agent-3: Use vote for the final decision."),
    ]
    merkle_root = hasher.build_merkle_tree(transcript_hashes)
    decision_hash = hasher.hash_content(final_answer)

    bridge = SolanaBridge(
        rpc_url=localnet_environment.rpc_url,
        program_id=localnet_environment.program_id,
        network="localnet",
        keypair_path=str(localnet_environment.wallet_path),
    )
    monkeypatch.setattr(bridge, "_rpc_candidates", lambda: [localnet_environment.rpc_url])

    await bridge.initialize_task(
        task_id=task_id,
        mechanism="debate",
        task_hash=task_hash,
        consensus_threshold=60,
        agent_count=3,
        payment_amount_lamports=0,
    )
    await bridge.record_selection(
        task_id=task_id,
        selector_reasoning_hash=selector_reasoning_hash,
    )
    await bridge.record_mechanism_switch(
        task_id=task_id,
        switch_index=0,
        from_mechanism="debate",
        to_mechanism="vote",
        reason_hash=switch_reason_hash,
        round_number=1,
    )
    receipt = await bridge.submit_receipt(
        task_id=task_id,
        merkle_root=merkle_root,
        decision_hash=decision_hash,
        quorum_reached=True,
        final_mechanism="vote",
    )

    result = DeliberationResult(
        task=task_text,
        mechanism_used=MechanismType.VOTE,
        mechanism_selection=MechanismSelection(
            mechanism=MechanismType.DEBATE,
            confidence=0.78,
            reasoning=selector_reasoning,
            reasoning_hash=selector_reasoning_hash,
            bandit_recommendation=MechanismType.DEBATE,
            bandit_confidence=0.78,
            task_features=TaskFeatures(
                task_text=task_text,
                complexity_score=0.5,
                topic_category="reasoning",
                expected_disagreement=0.4,
                answer_space_size=2,
                time_sensitivity=0.3,
                agent_count=3,
                stakes=0.0,
            ),
        ),
        final_answer=final_answer,
        confidence=0.93,
        quorum_reached=True,
        round_count=2,
        agent_count=3,
        mechanism_switches=1,
        merkle_root=merkle_root,
        transcript_hashes=transcript_hashes,
        agent_models_used=[],
        convergence_history=[],
        locked_claims=[],
        total_tokens_used=24,
        total_latency_ms=12.0,
        timestamp=datetime.now(UTC),
    )

    status_payload: dict[str, Any] = {
        "task_id": task_id,
        "task_text": task_text,
        "mechanism": "vote",
        "status": "completed",
        "selector_reasoning": selector_reasoning,
        "selector_reasoning_hash": selector_reasoning_hash,
        "selector_confidence": 0.78,
        "merkle_root": merkle_root,
        "decision_hash": decision_hash,
        "solana_tx_hash": str(receipt["tx_hash"]),
        "payment_amount": 0.0,
        "payment_status": "none",
        "events": [
            {
                "event": "mechanism_switch",
                "data": {
                    "from_mechanism": "debate",
                    "to_mechanism": "vote",
                    "reason": switch_reason,
                    "round_number": 1,
                },
                "timestamp": datetime.now(UTC).isoformat(),
            }
        ],
        "result": {
            "task_id": task_id,
            "mechanism": "vote",
            "final_answer": final_answer,
            "confidence": 0.93,
            "quorum_reached": True,
            "round_count": 2,
            "mechanism_switches": 1,
            "merkle_root": merkle_root,
            "decision_hash": decision_hash,
            "transcript_hashes": transcript_hashes,
            "convergence_history": [],
            "locked_claims": [],
            "total_tokens_used": 24,
            "latency_ms": 12.0,
        },
    }

    arbitrator = AgoraArbitrator(
        mechanism="vote",
        agent_count=3,
        rpc_url=localnet_environment.rpc_url,
        program_id=localnet_environment.program_id,
    )

    async def fake_get(url: str, *_args: object, **_kwargs: object) -> _FakeResponse:
        if url != f"/tasks/{task_id}":
            raise AssertionError(f"Unexpected GET url: {url}")
        return _FakeResponse(status_payload)

    monkeypatch.setattr(arbitrator._client, "get", fake_get)

    verification = await arbitrator.verify_receipt(
        result,
        strict=True,
        task_id=task_id,
    )
    await arbitrator.aclose()

    assert verification == {
        "valid": True,
        "merkle_match": True,
        "hosted_metadata_match": True,
        "on_chain_match": True,
    }
