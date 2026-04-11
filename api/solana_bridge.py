"""Async Solana bridge helpers used by API routes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from api.config import settings


@dataclass
class SolanaBridge:
    rpc_url: str
    program_id: str

    async def get_latest_blockhash(self) -> str:
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getLatestBlockhash",
            "params": [{"commitment": "confirmed"}],
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(self.rpc_url, json=payload)
            response.raise_for_status()
            data = response.json()

        return data["result"]["value"]["blockhash"]

    async def submit_receipt(
        self,
        task_id: str,
        merkle_root: str,
        decision_hash: str,
    ) -> dict[str, Any]:
        # Week 1 scaffold: transaction wiring lands in Week 2.
        return {
            "task_id": task_id,
            "merkle_root": merkle_root,
            "decision_hash": decision_hash,
            "tx_hash": "mock_tx_hash",
            "program_id": self.program_id,
        }


bridge = SolanaBridge(rpc_url=settings.helius_rpc_url, program_id=settings.program_id)
