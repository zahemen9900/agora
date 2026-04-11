"""Async Solana bridge helpers used by API routes."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import structlog
from solana.rpc.async_api import AsyncClient
from solana.rpc.types import TxOpts
from solders.hash import Hash
from solders.instruction import Instruction
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer
from solders.transaction import Transaction

from api.config import settings

logger = structlog.get_logger(__name__)


@dataclass
class SolanaBridge:
    rpc_url: str
    program_id: str
    network: str
    keypair_path: str

    memo_program_id: Pubkey = Pubkey.from_string("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")

    def _fallback_rpc_url(self) -> str:
        if self.network == "mainnet":
            return "https://api.mainnet-beta.solana.com"
        if self.network == "testnet":
            return "https://api.testnet.solana.com"
        return "https://api.devnet.solana.com"

    def _rpc_candidates(self) -> list[str]:
        candidates: list[str] = []
        configured = self.rpc_url.strip()
        if configured:
            candidates.append(configured)

        fallback = self._fallback_rpc_url()
        if fallback not in candidates:
            candidates.append(fallback)

        return candidates

    def _load_keypair(self) -> Keypair:
        keypair_file = Path(self.keypair_path).expanduser()
        if not keypair_file.exists():
            raise RuntimeError(f"Solana keypair file not found: {keypair_file}")

        secret_key = json.loads(keypair_file.read_text(encoding="utf-8"))
        return Keypair.from_bytes(bytes(secret_key))

    def _build_explorer_url(self, signature: str) -> str:
        cluster = "mainnet" if self.network == "mainnet" else self.network
        return f"https://explorer.solana.com/tx/{signature}?cluster={cluster}"

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

    async def _send_memo_transaction(
        self,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        signer = self._load_keypair()
        signer_pubkey = signer.pubkey()

        memo_payload = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
        memo_instruction = Instruction(self.memo_program_id, memo_payload.encode("utf-8"), [])
        noop_transfer = transfer(
            TransferParams(
                from_pubkey=signer_pubkey,
                to_pubkey=signer_pubkey,
                lamports=0,
            )
        )

        signature: str | None = None
        selected_rpc: str | None = None
        last_error: Exception | None = None

        for rpc_url in self._rpc_candidates():
            try:
                async with AsyncClient(rpc_url, timeout=20) as client:
                    blockhash_response = await client.get_latest_blockhash(commitment="confirmed")
                    blockhash = Hash.from_string(str(blockhash_response.value.blockhash))
                    tx = Transaction.new_signed_with_payer(
                        [noop_transfer, memo_instruction],
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
            payload_type=payload.get("event", "receipt"),
        )

        return {
            "tx_hash": signature,
            "explorer_url": self._build_explorer_url(signature),
            "payload": payload,
        }

    async def submit_receipt(
        self,
        task_id: str,
        merkle_root: str,
        decision_hash: str,
    ) -> dict[str, Any]:
        return await self._send_memo_transaction(
            {
                "event": "submit_receipt",
                "task_id": task_id,
                "merkle_root": merkle_root,
                "decision_hash": decision_hash,
                "program_id": self.program_id,
            }
        )

    async def record_payment_release(
        self,
        task_id: str,
        payment_amount_lamports: int,
    ) -> dict[str, Any]:
        return await self._send_memo_transaction(
            {
                "event": "release_payment",
                "task_id": task_id,
                "payment_amount_lamports": payment_amount_lamports,
                "program_id": self.program_id,
            }
        )

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
)
