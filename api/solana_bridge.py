"""Async Solana bridge helpers used by API routes."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import structlog
from solana.rpc.async_api import AsyncClient
from solana.rpc.types import TxOpts
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.transaction import Transaction

from api.config import settings

logger = structlog.get_logger(__name__)

LAMPORTS_PER_SOL = 1_000_000_000
SYSTEM_PROGRAM_ID = Pubkey.from_string("11111111111111111111111111111111")
MAX_MECHANISM_U8 = 4

MECHANISM_TO_U8: dict[str, int] = {
    "debate": 0,
    "vote": 1,
    "delphi": 2,
    "moa": 3,
    "hybrid": 4,
}
EXECUTABLE_MECHANISM_TO_U8: dict[str, int] = {
    "debate": MECHANISM_TO_U8["debate"],
    "vote": MECHANISM_TO_U8["vote"],
}
_EXECUTABLE_MECHANISMS_TEXT = ", ".join(sorted(EXECUTABLE_MECHANISM_TO_U8))


@dataclass(frozen=True)
class OnChainTaskAccount:
    selector_reasoning_hash: str
    transcript_merkle_root: str
    decision_hash: str
    quorum_reached: bool
    mechanism: str
    switched_to: str | None
    mechanism_switches: int
    payment_amount_lamports: int
    status: str


@dataclass
class SolanaBridge:
    rpc_url: str
    program_id: str
    network: str
    keypair_path: str
    keypair_secret_name: str = ""
    keypair_secret_project: str = ""
    keypair_secret_version: str = "latest"

    program_pubkey: Pubkey = field(init=False)
    _cached_signer: Keypair | None = field(init=False, default=None, repr=False)

    def __post_init__(self) -> None:
        self.program_pubkey = Pubkey.from_string(self.program_id)

    def _rpc_candidates(self) -> list[str]:
        configured = self.rpc_url.strip()
        if not configured or "YOUR_KEY" in configured:
            raise RuntimeError(
                "Helius RPC URL is not configured. Set HELIUS_RPC_URL with a real api-key."
            )
        if "helius-rpc.com" not in configured:
            raise RuntimeError("helius_rpc_url must point to a Helius RPC endpoint")
        return [configured]

    def _has_keypair_source(self) -> bool:
        keypair_file = Path(self.keypair_path).expanduser()
        if keypair_file.exists():
            return True

        secret_name = self.keypair_secret_name.strip()
        if not secret_name:
            return False

        secret_project = (
            self.keypair_secret_project.strip() or settings.google_cloud_project.strip()
        )
        return bool(secret_project)

    def is_configured(self) -> bool:
        configured = self.rpc_url.strip()
        return (
            bool(configured)
            and "YOUR_KEY" not in configured
            and "helius-rpc.com" in configured
            and self._has_keypair_source()
        )

    def _load_keypair(self) -> Keypair:
        if self._cached_signer is not None:
            return self._cached_signer

        keypair_file = Path(self.keypair_path).expanduser()
        if keypair_file.exists():
            secret_key = json.loads(keypair_file.read_text(encoding="utf-8"))
            signer = Keypair.from_bytes(bytes(secret_key))
            self._cached_signer = signer
            return signer

        if self.keypair_secret_name.strip():
            signer = self._load_keypair_from_secret()
            self._cached_signer = signer
            return signer

        raise RuntimeError(
            f"Solana keypair file not found: {keypair_file}, "
            "and no Secret Manager source configured"
        )

    def _keypair_secret_resource_name(self) -> str:
        secret_name = self.keypair_secret_name.strip()
        if not secret_name:
            raise RuntimeError("SOLANA_KEYPAIR_SECRET_NAME is not configured")

        secret_project = (
            self.keypair_secret_project.strip() or settings.google_cloud_project.strip()
        )
        if not secret_project:
            raise RuntimeError(
                "Set SOLANA_KEYPAIR_SECRET_PROJECT or GOOGLE_CLOUD_PROJECT to use keypair secrets"
            )

        secret_version = self.keypair_secret_version.strip() or "latest"
        return f"projects/{secret_project}/secrets/{secret_name}/versions/{secret_version}"

    @staticmethod
    def _parse_keypair_secret_payload(secret_payload: bytes) -> Keypair:
        raw = secret_payload.decode("utf-8").strip()

        def parse_bytes(value: str) -> bytes:
            candidate = value.strip()
            if candidate.startswith("0x"):
                candidate = candidate[2:]

            if candidate.startswith("["):
                parsed = json.loads(candidate)
                if isinstance(parsed, list):
                    return bytes(parsed)

            is_hex = len(candidate) % 2 == 0 and all(
                ch in "0123456789abcdefABCDEF" for ch in candidate
            )
            if is_hex:
                return bytes.fromhex(candidate)

            return base64.b64decode(candidate, validate=True)

        parsed: Any
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = raw

        material: bytes | None = None
        if isinstance(parsed, list):
            material = bytes(parsed)
        elif isinstance(parsed, dict):
            for key in ("secret_key", "keypair", "bytes"):
                value = parsed.get(key)
                if isinstance(value, list):
                    material = bytes(value)
                    break
                if isinstance(value, str):
                    material = parse_bytes(value)
                    break
        elif isinstance(parsed, str):
            material = parse_bytes(parsed)

        if material is None:
            raise RuntimeError("Unable to parse keypair bytes from secret payload")

        try:
            return Keypair.from_bytes(material)
        except ValueError as exc:
            raise RuntimeError("Secret payload is not a valid 64-byte Solana keypair") from exc

    def _load_keypair_from_secret(self) -> Keypair:
        resource_name = self._keypair_secret_resource_name()
        client_error: Exception | None = None
        try:
            payload = self._load_keypair_secret_payload_via_client(resource_name=resource_name)
            return self._parse_keypair_secret_payload(payload)
        except Exception as exc:  # pragma: no cover - network and auth dependent
            client_error = exc

        payload = self._load_keypair_secret_payload_via_gcloud()
        if payload is not None:
            return self._parse_keypair_secret_payload(payload)

        raise RuntimeError(f"Failed to read keypair secret: {resource_name}") from client_error

    def _load_keypair_secret_payload_via_client(self, *, resource_name: str) -> bytes:
        from google.cloud import secretmanager

        client = secretmanager.SecretManagerServiceClient()
        response = client.access_secret_version(request={"name": resource_name})
        return bytes(response.payload.data)

    def _load_keypair_secret_payload_via_gcloud(self) -> bytes | None:
        if shutil.which("gcloud") is None:
            return None

        secret_name = self.keypair_secret_name.strip()
        secret_project = (
            self.keypair_secret_project.strip() or settings.google_cloud_project.strip()
        )
        if not secret_name or not secret_project:
            return None

        secret_version = self.keypair_secret_version.strip() or "latest"
        env = os.environ.copy()
        env.setdefault("CLOUDSDK_PAGER", "")
        env.setdefault("CLOUDSDK_CORE_DISABLE_PROMPTS", "1")

        result = subprocess.run(
            [
                "gcloud",
                "secrets",
                "versions",
                "access",
                secret_version,
                "--secret",
                secret_name,
                "--project",
                secret_project,
            ],
            check=False,
            capture_output=True,
            text=True,
            env=env,
            timeout=20,
        )
        if result.returncode != 0:
            return None

        payload = result.stdout.strip()
        if not payload:
            return None

        return payload.encode("utf-8")

    def _build_explorer_url(self, signature: str) -> str:
        cluster = "mainnet" if self.network == "mainnet" else self.network
        return f"https://explorer.solana.com/tx/{signature}?cluster={cluster}"

    @staticmethod
    def _anchor_discriminator(instruction_name: str) -> bytes:
        payload = f"global:{instruction_name}".encode()
        return hashlib.sha256(payload).digest()[:8]

    @staticmethod
    def _account_discriminator(account_name: str) -> bytes:
        payload = f"account:{account_name}".encode()
        return hashlib.sha256(payload).digest()[:8]

    @staticmethod
    def _normalize_hex(value: str, *, field_name: str) -> str:
        normalized = value.strip().lower()
        if normalized.startswith("0x"):
            normalized = normalized[2:]
        if len(normalized) != 64:
            raise ValueError(f"{field_name} must be a 64-character hex string")
        try:
            bytes.fromhex(normalized)
        except ValueError as exc:
            raise ValueError(f"{field_name} is not valid hex") from exc
        return normalized

    def task_id_to_bytes(self, task_id: str) -> bytes:
        return bytes.fromhex(self._normalize_hex(task_id, field_name="task_id"))

    def derive_task_pda(self, task_id: str) -> Pubkey:
        task_id_bytes = self.task_id_to_bytes(task_id)
        pda, _ = Pubkey.find_program_address([b"task", task_id_bytes], self.program_pubkey)
        return pda

    def derive_vault_pda(self, task_id: str) -> Pubkey:
        task_id_bytes = self.task_id_to_bytes(task_id)
        pda, _ = Pubkey.find_program_address([b"vault", task_id_bytes], self.program_pubkey)
        return pda

    def derive_switch_pda(self, task_id: str, switch_index: int) -> Pubkey:
        task_id_bytes = self.task_id_to_bytes(task_id)
        if switch_index < 0 or switch_index > 255:
            raise ValueError("switch_index must be in range [0, 255]")
        seed = bytes([switch_index])
        pda, _ = Pubkey.find_program_address([b"switch", task_id_bytes, seed], self.program_pubkey)
        return pda

    def _mechanism_u8(self, mechanism: str | int) -> int:
        if isinstance(mechanism, int):
            if mechanism not in set(EXECUTABLE_MECHANISM_TO_U8.values()):
                raise ValueError(
                    "mechanism is not executable in this phase; "
                    f"supported mechanisms: {_EXECUTABLE_MECHANISMS_TEXT}"
                )
            return mechanism

        key = mechanism.strip().lower()
        if key not in MECHANISM_TO_U8:
            raise ValueError(f"unsupported mechanism: {mechanism}")
        if key not in EXECUTABLE_MECHANISM_TO_U8:
            raise ValueError(
                f"mechanism '{key}' is roadmap-only and not executable in this phase; "
                f"supported mechanisms: {_EXECUTABLE_MECHANISMS_TEXT}"
            )
        return EXECUTABLE_MECHANISM_TO_U8[key]

    def build_initialize_task_instruction(
        self,
        *,
        task_id: str,
        mechanism: str | int,
        task_hash: str,
        consensus_threshold: int,
        agent_count: int,
        payment_amount_lamports: int,
        payer: Pubkey,
        recipient: Pubkey,
    ) -> Instruction:
        if consensus_threshold <= 0 or consensus_threshold > 100:
            raise ValueError("consensus_threshold must be in range [1, 100]")
        if agent_count <= 0 or agent_count > 12:
            raise ValueError("agent_count must be in range [1, 12]")
        if payment_amount_lamports < 0:
            raise ValueError("payment_amount_lamports must be non-negative")
        if recipient == SYSTEM_PROGRAM_ID:
            raise ValueError("recipient must not be the default pubkey")

        task_id_bytes = self.task_id_to_bytes(task_id)
        task_hash_bytes = bytes.fromhex(self._normalize_hex(task_hash, field_name="task_hash"))
        mechanism_u8 = self._mechanism_u8(mechanism)

        payload = (
            self._anchor_discriminator("initialize_task")
            + task_id_bytes
            + bytes([mechanism_u8])
            + task_hash_bytes
            + bytes([consensus_threshold])
            + bytes([agent_count])
            + int(payment_amount_lamports).to_bytes(8, "little", signed=False)
            + bytes(recipient)
        )

        task_pda = self.derive_task_pda(task_id)
        vault_pda = self.derive_vault_pda(task_id)
        accounts = [
            AccountMeta(task_pda, False, True),
            AccountMeta(vault_pda, False, True),
            AccountMeta(payer, True, True),
            AccountMeta(SYSTEM_PROGRAM_ID, False, False),
        ]
        return Instruction(self.program_pubkey, payload, accounts)

    def build_record_selection_instruction(
        self,
        *,
        task_id: str,
        selector_reasoning_hash: str,
        authority: Pubkey,
    ) -> Instruction:
        task_id_bytes = self.task_id_to_bytes(task_id)
        selector_hash_bytes = bytes.fromhex(
            self._normalize_hex(selector_reasoning_hash, field_name="selector_reasoning_hash")
        )

        payload = (
            self._anchor_discriminator("record_selection")
            + task_id_bytes
            + selector_hash_bytes
        )

        task_pda = self.derive_task_pda(task_id)
        accounts = [
            AccountMeta(task_pda, False, True),
            AccountMeta(authority, True, False),
        ]
        return Instruction(self.program_pubkey, payload, accounts)

    def build_submit_receipt_instruction(
        self,
        *,
        task_id: str,
        transcript_merkle_root: str,
        decision_hash: str,
        quorum_reached: bool,
        final_mechanism: str | int,
        authority: Pubkey,
    ) -> Instruction:
        task_id_bytes = self.task_id_to_bytes(task_id)
        merkle_bytes = bytes.fromhex(
            self._normalize_hex(transcript_merkle_root, field_name="transcript_merkle_root")
        )
        decision_bytes = bytes.fromhex(
            self._normalize_hex(decision_hash, field_name="decision_hash")
        )
        final_mechanism_u8 = self._mechanism_u8(final_mechanism)

        payload = (
            self._anchor_discriminator("submit_receipt")
            + task_id_bytes
            + merkle_bytes
            + decision_bytes
            + bytes([1 if quorum_reached else 0])
            + bytes([final_mechanism_u8])
        )

        task_pda = self.derive_task_pda(task_id)
        accounts = [
            AccountMeta(task_pda, False, True),
            AccountMeta(authority, True, False),
        ]
        return Instruction(self.program_pubkey, payload, accounts)

    def build_record_mechanism_switch_instruction(
        self,
        *,
        task_id: str,
        switch_index: int,
        from_mechanism: str | int,
        to_mechanism: str | int,
        reason_hash: str,
        round_number: int,
        authority: Pubkey,
    ) -> Instruction:
        if switch_index < 0 or switch_index > 255:
            raise ValueError("switch_index must be in range [0, 255]")
        if round_number < 0 or round_number > 255:
            raise ValueError("round_number must be in range [0, 255]")

        task_id_bytes = self.task_id_to_bytes(task_id)
        from_u8 = self._mechanism_u8(from_mechanism)
        to_u8 = self._mechanism_u8(to_mechanism)
        reason_bytes = bytes.fromhex(self._normalize_hex(reason_hash, field_name="reason_hash"))

        payload = (
            self._anchor_discriminator("record_mechanism_switch")
            + task_id_bytes
            + bytes([switch_index])
            + bytes([from_u8])
            + bytes([to_u8])
            + reason_bytes
            + bytes([round_number])
        )

        task_pda = self.derive_task_pda(task_id)
        switch_pda = self.derive_switch_pda(task_id, switch_index)
        accounts = [
            AccountMeta(task_pda, False, True),
            AccountMeta(switch_pda, False, True),
            AccountMeta(authority, True, True),
            AccountMeta(SYSTEM_PROGRAM_ID, False, False),
        ]
        return Instruction(self.program_pubkey, payload, accounts)

    def build_release_payment_instruction(
        self,
        *,
        task_id: str,
        recipient: Pubkey,
        authority: Pubkey,
    ) -> Instruction:
        task_id_bytes = self.task_id_to_bytes(task_id)
        payload = self._anchor_discriminator("release_payment") + task_id_bytes

        task_pda = self.derive_task_pda(task_id)
        vault_pda = self.derive_vault_pda(task_id)
        accounts = [
            AccountMeta(task_pda, False, True),
            AccountMeta(vault_pda, False, True),
            AccountMeta(recipient, False, True),
            AccountMeta(authority, True, True),
            AccountMeta(SYSTEM_PROGRAM_ID, False, False),
        ]
        return Instruction(self.program_pubkey, payload, accounts)

    async def get_latest_blockhash(self) -> str:
        last_error: Exception | None = None
        for rpc_url in self._rpc_candidates():
            try:
                async with AsyncClient(rpc_url, timeout=10) as client:
                    response = await client.get_latest_blockhash(commitment="confirmed")
                    return str(response.value.blockhash)
            except Exception as exc:  # pragma: no cover - network dependent
                logger.warning("solana_rpc_candidate_failed", rpc_url=rpc_url, error=str(exc))
                last_error = exc

        raise RuntimeError(
            "Failed to fetch blockhash from all configured RPC endpoints"
        ) from last_error

    async def account_exists(self, address: Pubkey) -> bool:
        """Return whether an on-chain account currently exists."""

        last_error: Exception | None = None
        for rpc_url in self._rpc_candidates():
            try:
                async with AsyncClient(rpc_url, timeout=10) as client:
                    response = await client.get_account_info(address, commitment="confirmed")
                    return response.value is not None
            except Exception as exc:  # pragma: no cover - network dependent
                logger.warning("solana_rpc_candidate_failed", rpc_url=rpc_url, error=str(exc))
                last_error = exc

        raise RuntimeError(
            f"Failed to fetch account info for {address} from all configured RPC endpoints"
        ) from last_error

    @staticmethod
    def _decode_account_data(raw_data: Any) -> bytes | None:
        if raw_data is None:
            return None
        if isinstance(raw_data, bytes):
            return raw_data
        if isinstance(raw_data, bytearray):
            return bytes(raw_data)
        if isinstance(raw_data, str):
            return base64.b64decode(raw_data)
        if isinstance(raw_data, (list, tuple)) and raw_data:
            encoded = raw_data[0]
            if isinstance(encoded, str):
                return base64.b64decode(encoded)
        return None

    async def fetch_account_data(self, address: Pubkey) -> bytes | None:
        """Fetch raw account bytes for an on-chain account."""

        last_error: Exception | None = None
        for rpc_url in self._rpc_candidates():
            try:
                async with AsyncClient(rpc_url, timeout=10) as client:
                    response = await client.get_account_info(address, commitment="confirmed")
                    value = response.value
                    if value is None:
                        return None
                    decoded = self._decode_account_data(getattr(value, "data", None))
                    if decoded is None:
                        raise RuntimeError(f"Unsupported account data encoding for {address}")
                    return decoded
            except Exception as exc:  # pragma: no cover - network dependent
                logger.warning("solana_rpc_candidate_failed", rpc_url=rpc_url, error=str(exc))
                last_error = exc

        raise RuntimeError(
            f"Failed to fetch account data for {address} from all configured RPC endpoints"
        ) from last_error

    @staticmethod
    def _read_u8(payload: bytes, offset: int) -> tuple[int, int]:
        return payload[offset], offset + 1

    @staticmethod
    def _read_bool(payload: bytes, offset: int) -> tuple[bool, int]:
        value, offset = SolanaBridge._read_u8(payload, offset)
        return bool(value), offset

    @staticmethod
    def _read_bytes(payload: bytes, offset: int, size: int) -> tuple[bytes, int]:
        return payload[offset : offset + size], offset + size

    @staticmethod
    def _read_option_u8(payload: bytes, offset: int) -> tuple[int | None, int]:
        tag, offset = SolanaBridge._read_u8(payload, offset)
        if tag == 0:
            return None, offset
        value, offset = SolanaBridge._read_u8(payload, offset)
        return value, offset

    @staticmethod
    def _read_i64(payload: bytes, offset: int) -> tuple[int, int]:
        chunk, offset = SolanaBridge._read_bytes(payload, offset, 8)
        return int.from_bytes(chunk, "little", signed=True), offset

    @staticmethod
    def _read_u64(payload: bytes, offset: int) -> tuple[int, int]:
        chunk, offset = SolanaBridge._read_bytes(payload, offset, 8)
        return int.from_bytes(chunk, "little"), offset

    @staticmethod
    def _parse_onchain_mechanism(value: int) -> str:
        mapping = {
            0: "debate",
            1: "vote",
            2: "delphi",
            3: "moa",
            4: "hybrid",
        }
        mechanism = mapping.get(value)
        if mechanism is None:
            raise RuntimeError(f"Unsupported on-chain mechanism value: {value}")
        return mechanism

    @staticmethod
    def _parse_onchain_task_status(value: int) -> str:
        mapping = {
            0: "pending",
            1: "in_progress",
            2: "completed",
            3: "failed",
            4: "paid",
        }
        status = mapping.get(value)
        if status is None:
            raise RuntimeError(f"Unsupported on-chain task status value: {value}")
        return status

    def parse_task_account(self, payload: bytes) -> OnChainTaskAccount:
        """Decode an on-chain TaskAccount payload into a typed summary."""

        if payload[:8] != self._account_discriminator("TaskAccount"):
            raise RuntimeError("Unexpected TaskAccount discriminator")

        offset = 8
        _, offset = self._read_bytes(payload, offset, 32)
        _, offset = self._read_bytes(payload, offset, 32)
        mechanism_value, offset = self._read_u8(payload, offset)
        switched_to_value, offset = self._read_option_u8(payload, offset)
        selector_reasoning_hash, offset = self._read_bytes(payload, offset, 32)
        transcript_merkle_root, offset = self._read_bytes(payload, offset, 32)
        decision_hash, offset = self._read_bytes(payload, offset, 32)
        quorum_reached, offset = self._read_bool(payload, offset)
        _, offset = self._read_u8(payload, offset)
        _, offset = self._read_u8(payload, offset)
        payment_amount_lamports, offset = self._read_u64(payload, offset)
        _, offset = self._read_bytes(payload, offset, 32)
        _, offset = self._read_bytes(payload, offset, 32)
        mechanism_switches, offset = self._read_u8(payload, offset)
        status_value, offset = self._read_u8(payload, offset)
        _, offset = self._read_i64(payload, offset)
        completed_tag, offset = self._read_u8(payload, offset)
        if completed_tag == 1:
            _, offset = self._read_i64(payload, offset)
        _, offset = self._read_u8(payload, offset)
        _, offset = self._read_u8(payload, offset)

        return OnChainTaskAccount(
            selector_reasoning_hash=selector_reasoning_hash.hex(),
            transcript_merkle_root=transcript_merkle_root.hex(),
            decision_hash=decision_hash.hex(),
            quorum_reached=quorum_reached,
            mechanism=self._parse_onchain_mechanism(mechanism_value),
            switched_to=(
                self._parse_onchain_mechanism(switched_to_value)
                if switched_to_value is not None
                else None
            ),
            mechanism_switches=mechanism_switches,
            payment_amount_lamports=payment_amount_lamports,
            status=self._parse_onchain_task_status(status_value),
        )

    async def task_account_exists(self, task_id: str) -> bool:
        """Return whether the task PDA already exists on chain."""

        return await self.account_exists(self.derive_task_pda(task_id))

    async def fetch_task_account(self, task_id: str) -> OnChainTaskAccount | None:
        """Fetch and decode the task PDA when it exists."""

        payload = await self.fetch_account_data(self.derive_task_pda(task_id))
        if payload is None:
            return None
        return self.parse_task_account(payload)

    async def switch_account_exists(self, task_id: str, switch_index: int) -> bool:
        """Return whether the switch PDA already exists on chain."""

        return await self.account_exists(self.derive_switch_pda(task_id, switch_index))

    async def vault_account_exists(self, task_id: str) -> bool:
        """Return whether the vault PDA still exists on chain."""

        return await self.account_exists(self.derive_vault_pda(task_id))

    async def _send_instruction(
        self,
        *,
        instruction: Instruction,
        signer: Keypair,
        context: dict[str, Any],
    ) -> dict[str, Any]:
        signer_pubkey = signer.pubkey()

        signature: str | None = None
        selected_rpc: str | None = None
        last_error: Exception | None = None

        for rpc_url in self._rpc_candidates():
            try:
                async with AsyncClient(rpc_url, timeout=20) as client:
                    blockhash_response = await client.get_latest_blockhash(commitment="confirmed")
                    blockhash = Hash.from_string(str(blockhash_response.value.blockhash))
                    tx = Transaction.new_signed_with_payer(
                        [instruction],
                        signer_pubkey,
                        [signer],
                        blockhash,
                    )

                    send_response = await client.send_raw_transaction(
                        bytes(tx),
                        opts=TxOpts(
                            skip_confirmation=True,
                            skip_preflight=False,
                            preflight_commitment="confirmed",
                            last_valid_block_height=blockhash_response.value.last_valid_block_height,
                        ),
                    )

                    signature = str(send_response.value)
                    await client.confirm_transaction(
                        send_response.value,
                        commitment="confirmed",
                        last_valid_block_height=blockhash_response.value.last_valid_block_height,
                    )
                    selected_rpc = rpc_url
                    break
            except Exception as exc:  # pragma: no cover - network dependent
                logger.warning("solana_rpc_candidate_failed", rpc_url=rpc_url, error=str(exc))
                last_error = exc

        if signature is None:
            raise RuntimeError("Failed to submit transaction to all RPC candidates") from last_error

        logger.info(
            "solana_bridge_transaction_submitted",
            signature=signature,
            network=self.network,
            program_id=self.program_id,
            rpc_url=selected_rpc,
            payload_type=context.get("event", "instruction"),
        )

        return {
            "tx_hash": signature,
            "explorer_url": self._build_explorer_url(signature),
            **context,
        }

    async def initialize_task(
        self,
        *,
        task_id: str,
        mechanism: str,
        task_hash: str,
        consensus_threshold: int,
        agent_count: int,
        payment_amount_lamports: int,
        recipient: str | None = None,
    ) -> dict[str, Any]:
        signer = self._load_keypair()
        payer = signer.pubkey()
        recipient_pubkey = Pubkey.from_string(recipient) if recipient else payer

        instruction = self.build_initialize_task_instruction(
            task_id=task_id,
            mechanism=mechanism,
            task_hash=task_hash,
            consensus_threshold=consensus_threshold,
            agent_count=agent_count,
            payment_amount_lamports=payment_amount_lamports,
            payer=payer,
            recipient=recipient_pubkey,
        )

        result = await self._send_instruction(
            instruction=instruction,
            signer=signer,
            context={
                "event": "initialize_task",
                "task_id": task_id,
                "program_id": self.program_id,
                "task_pda": str(self.derive_task_pda(task_id)),
                "vault_pda": str(self.derive_vault_pda(task_id)),
            },
        )
        return result

    async def record_selection(
        self,
        *,
        task_id: str,
        selector_reasoning_hash: str,
    ) -> dict[str, Any]:
        signer = self._load_keypair()
        instruction = self.build_record_selection_instruction(
            task_id=task_id,
            selector_reasoning_hash=selector_reasoning_hash,
            authority=signer.pubkey(),
        )
        return await self._send_instruction(
            instruction=instruction,
            signer=signer,
            context={
                "event": "record_selection",
                "task_id": task_id,
                "program_id": self.program_id,
            },
        )

    async def submit_receipt(
        self,
        task_id: str,
        merkle_root: str,
        decision_hash: str,
        quorum_reached: bool,
        final_mechanism: str | int,
    ) -> dict[str, Any]:
        signer = self._load_keypair()
        instruction = self.build_submit_receipt_instruction(
            task_id=task_id,
            transcript_merkle_root=merkle_root,
            decision_hash=decision_hash,
            quorum_reached=quorum_reached,
            final_mechanism=final_mechanism,
            authority=signer.pubkey(),
        )
        return await self._send_instruction(
            instruction=instruction,
            signer=signer,
            context={
                "event": "submit_receipt",
                "task_id": task_id,
                "program_id": self.program_id,
            },
        )

    async def record_mechanism_switch(
        self,
        *,
        task_id: str,
        switch_index: int,
        from_mechanism: str | int,
        to_mechanism: str | int,
        reason_hash: str,
        round_number: int,
    ) -> dict[str, Any]:
        signer = self._load_keypair()
        instruction = self.build_record_mechanism_switch_instruction(
            task_id=task_id,
            switch_index=switch_index,
            from_mechanism=from_mechanism,
            to_mechanism=to_mechanism,
            reason_hash=reason_hash,
            round_number=round_number,
            authority=signer.pubkey(),
        )
        return await self._send_instruction(
            instruction=instruction,
            signer=signer,
            context={
                "event": "record_mechanism_switch",
                "task_id": task_id,
                "switch_index": switch_index,
                "program_id": self.program_id,
            },
        )

    async def release_payment(
        self,
        *,
        task_id: str,
        recipient: str | None = None,
    ) -> dict[str, Any]:
        signer = self._load_keypair()
        recipient_pubkey = Pubkey.from_string(recipient) if recipient else signer.pubkey()
        instruction = self.build_release_payment_instruction(
            task_id=task_id,
            recipient=recipient_pubkey,
            authority=signer.pubkey(),
        )
        return await self._send_instruction(
            instruction=instruction,
            signer=signer,
            context={
                "event": "release_payment",
                "task_id": task_id,
                "program_id": self.program_id,
            },
        )

    async def record_payment_release(
        self,
        task_id: str,
        payment_amount_lamports: int,
    ) -> dict[str, Any]:
        del payment_amount_lamports
        return await self.release_payment(task_id=task_id)

    async def rpc_health(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getHealth",
        }

        last_error: Exception | None = None
        for rpc_url in self._rpc_candidates():
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.post(rpc_url, json=payload)
                    response.raise_for_status()
                    return response.json()
            except Exception as exc:  # pragma: no cover - network dependent
                logger.warning("solana_rpc_candidate_failed", rpc_url=rpc_url, error=str(exc))
                last_error = exc

        raise RuntimeError(
            "Unable to query Solana RPC health from configured endpoints"
        ) from last_error


bridge = SolanaBridge(
    rpc_url=settings.helius_rpc_url,
    program_id=settings.program_id,
    network=settings.solana_network,
    keypair_path=settings.solana_keypair_path,
    keypair_secret_name=settings.solana_keypair_secret_name,
    keypair_secret_project=settings.solana_keypair_secret_project,
    keypair_secret_version=settings.solana_keypair_secret_version,
)
