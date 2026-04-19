from __future__ import annotations

import hashlib
import json

import pytest
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from api.solana_bridge import SYSTEM_PROGRAM_ID, SolanaBridge


def _bridge(*, rpc_url: str = "https://devnet.helius-rpc.com/?api-key=test") -> SolanaBridge:
    return SolanaBridge(
        rpc_url=rpc_url,
        program_id="82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd",
        network="devnet",
        keypair_path="/tmp/does-not-exist-keypair.json",
    )


def test_task_id_bytes_are_32() -> None:
    bridge = _bridge()
    task_id = hashlib.sha256(b"task").hexdigest()

    task_bytes = bridge.task_id_to_bytes(task_id)
    assert len(task_bytes) == 32


def test_derives_task_and_vault_and_switch_pdas_deterministically() -> None:
    bridge = _bridge()
    task_id = hashlib.sha256(b"deterministic").hexdigest()
    task_bytes = bytes.fromhex(task_id)

    expected_task, _ = Pubkey.find_program_address(
        [b"task", task_bytes],
        bridge.program_pubkey,
    )
    expected_vault, _ = Pubkey.find_program_address(
        [b"vault", task_bytes],
        bridge.program_pubkey,
    )
    expected_switch, _ = Pubkey.find_program_address(
        [b"switch", task_bytes, bytes([3])],
        bridge.program_pubkey,
    )

    assert bridge.derive_task_pda(task_id) == expected_task
    assert bridge.derive_vault_pda(task_id) == expected_vault
    assert bridge.derive_switch_pda(task_id, 3) == expected_switch


def test_builds_anchor_instruction_payloads_for_all_week1_calls() -> None:
    bridge = _bridge()
    payer = Keypair().pubkey()
    recipient = Keypair().pubkey()
    task_id = hashlib.sha256(b"task-a").hexdigest()
    task_hash = hashlib.sha256(b"task-text").hexdigest()
    selector_hash = hashlib.sha256(b"reasoning").hexdigest()
    merkle_root = hashlib.sha256(b"merkle").hexdigest()
    decision_hash = hashlib.sha256(b"decision").hexdigest()
    reason_hash = hashlib.sha256(b"switch-reason").hexdigest()

    init_ix = bridge.build_initialize_task_instruction(
        task_id=task_id,
        mechanism="debate",
        task_hash=task_hash,
        consensus_threshold=60,
        agent_count=5,
        payment_amount_lamports=1234,
        payer=payer,
        recipient=recipient,
    )
    select_ix = bridge.build_record_selection_instruction(
        task_id=task_id,
        selector_reasoning_hash=selector_hash,
        authority=payer,
    )
    receipt_ix = bridge.build_submit_receipt_instruction(
        task_id=task_id,
        transcript_merkle_root=merkle_root,
        decision_hash=decision_hash,
        quorum_reached=True,
        final_mechanism="vote",
        authority=payer,
    )
    switch_ix = bridge.build_record_mechanism_switch_instruction(
        task_id=task_id,
        switch_index=0,
        from_mechanism="debate",
        to_mechanism="vote",
        reason_hash=reason_hash,
        round_number=2,
        authority=payer,
    )
    pay_ix = bridge.build_release_payment_instruction(
        task_id=task_id,
        recipient=recipient,
        authority=payer,
    )

    assert bytes(init_ix.data)[:8] == hashlib.sha256(b"global:initialize_task").digest()[:8]
    assert bytes(select_ix.data)[:8] == hashlib.sha256(b"global:record_selection").digest()[:8]
    assert bytes(receipt_ix.data)[:8] == hashlib.sha256(b"global:submit_receipt").digest()[:8]
    assert bytes(switch_ix.data)[:8] == hashlib.sha256(
        b"global:record_mechanism_switch"
    ).digest()[:8]
    assert bytes(pay_ix.data)[:8] == hashlib.sha256(b"global:release_payment").digest()[:8]

    assert len(init_ix.accounts) == 4
    assert len(select_ix.accounts) == 2
    assert len(receipt_ix.accounts) == 2
    assert len(switch_ix.accounts) == 4
    assert len(pay_ix.accounts) == 5


def test_bridge_rejects_invalid_mechanism_values() -> None:
    bridge = _bridge()

    with pytest.raises(ValueError, match="not executable in this phase"):
        bridge.build_submit_receipt_instruction(
            task_id=hashlib.sha256(b"task-invalid-mechanism").hexdigest(),
            transcript_merkle_root=hashlib.sha256(b"merkle").hexdigest(),
            decision_hash=hashlib.sha256(b"decision").hexdigest(),
            quorum_reached=True,
            final_mechanism=5,
            authority=Keypair().pubkey(),
        )


@pytest.mark.parametrize("mechanism", ["delphi", "moa", "hybrid", 2, 3, 4, 5])
def test_bridge_rejects_roadmap_mechanisms_from_initialize_paths(
    mechanism: str | int,
) -> None:
    bridge = _bridge()

    with pytest.raises(ValueError, match="not executable in this phase"):
        bridge.build_initialize_task_instruction(
            task_id=hashlib.sha256(f"task-{mechanism}".encode()).hexdigest(),
            mechanism=mechanism,
            task_hash=hashlib.sha256(b"task-text").hexdigest(),
            consensus_threshold=60,
            agent_count=4,
            payment_amount_lamports=1,
            payer=Keypair().pubkey(),
            recipient=Keypair().pubkey(),
        )


def test_bridge_rejects_default_recipient() -> None:
    bridge = _bridge()

    with pytest.raises(ValueError, match="recipient must not be the default pubkey"):
        bridge.build_initialize_task_instruction(
            task_id=hashlib.sha256(b"task-default-recipient").hexdigest(),
            mechanism="vote",
            task_hash=hashlib.sha256(b"task-text").hexdigest(),
            consensus_threshold=60,
            agent_count=3,
            payment_amount_lamports=1,
            payer=Keypair().pubkey(),
            recipient=SYSTEM_PROGRAM_ID,
        )


def test_rejects_placeholder_helius_url() -> None:
    bridge = _bridge(rpc_url="https://devnet.helius-rpc.com/?api-key=YOUR_KEY")

    with pytest.raises(RuntimeError, match="HELIUS_RPC_URL"):
        bridge._rpc_candidates()


def test_missing_keypair_raises_clear_error() -> None:
    bridge = _bridge()

    with pytest.raises(RuntimeError, match="keypair file not found"):
        bridge._load_keypair()


def test_secret_keypair_source_counts_as_configured() -> None:
    bridge = SolanaBridge(
        rpc_url="https://devnet.helius-rpc.com/?api-key=test",
        program_id="82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd",
        network="devnet",
        keypair_path="/tmp/does-not-exist-keypair.json",
        keypair_secret_name="agora-devnet-keypair",
        keypair_secret_project="test-project",
    )

    assert bridge.is_configured() is True


def test_load_keypair_uses_secret_when_file_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = Keypair()
    bridge = SolanaBridge(
        rpc_url="https://devnet.helius-rpc.com/?api-key=test",
        program_id="82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd",
        network="devnet",
        keypair_path="/tmp/does-not-exist-keypair.json",
        keypair_secret_name="agora-devnet-keypair",
        keypair_secret_project="test-project",
    )

    monkeypatch.setattr(bridge, "_load_keypair_from_secret", lambda: expected)
    loaded = bridge._load_keypair()

    assert loaded.pubkey() == expected.pubkey()


def test_load_keypair_secret_falls_back_to_gcloud(monkeypatch: pytest.MonkeyPatch) -> None:
    keypair = Keypair()
    bridge = SolanaBridge(
        rpc_url="https://devnet.helius-rpc.com/?api-key=test",
        program_id="82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd",
        network="devnet",
        keypair_path="/tmp/does-not-exist-keypair.json",
        keypair_secret_name="agora-devnet-keypair",
        keypair_secret_project="test-project",
    )

    def _raise_client(*, resource_name: str) -> bytes:
        raise RuntimeError(f"client failed for {resource_name}")

    monkeypatch.setattr(bridge, "_load_keypair_secret_payload_via_client", _raise_client)
    monkeypatch.setattr(
        bridge,
        "_load_keypair_secret_payload_via_gcloud",
        lambda: json.dumps(list(bytes(keypair))).encode("utf-8"),
    )

    loaded = bridge._load_keypair_from_secret()
    assert loaded.pubkey() == keypair.pubkey()


def test_load_keypair_secret_raises_when_all_backends_fail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge = SolanaBridge(
        rpc_url="https://devnet.helius-rpc.com/?api-key=test",
        program_id="82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd",
        network="devnet",
        keypair_path="/tmp/does-not-exist-keypair.json",
        keypair_secret_name="agora-devnet-keypair",
        keypair_secret_project="test-project",
    )

    def _raise_client(*, resource_name: str) -> bytes:
        raise RuntimeError(f"client failed for {resource_name}")

    monkeypatch.setattr(bridge, "_load_keypair_secret_payload_via_client", _raise_client)
    monkeypatch.setattr(bridge, "_load_keypair_secret_payload_via_gcloud", lambda: None)

    with pytest.raises(RuntimeError, match="Failed to read keypair secret"):
        bridge._load_keypair_from_secret()


def test_parse_keypair_secret_payload_from_json_list() -> None:
    keypair = Keypair()
    payload = json.dumps(list(bytes(keypair))).encode("utf-8")

    loaded = SolanaBridge._parse_keypair_secret_payload(payload)
    assert loaded.pubkey() == keypair.pubkey()
