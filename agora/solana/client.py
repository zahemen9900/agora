"""Internal Solana adapter interface for optional protocol integrations."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict


class SolanaReceipt(BaseModel):
    """Receipt payload shape expected by the on-chain API layer."""

    model_config = ConfigDict(frozen=True)

    merkle_root: str
    decision_hash: str
    mechanism: str
    task_id: str


class SolanaClient:
    """Interface for optional on-chain operations implemented by deployment adapters."""

    async def submit_receipt(self, receipt: SolanaReceipt) -> str:
        """Submit a receipt to Solana.

        Args:
            receipt: Receipt payload.

        Raises:
            NotImplementedError: No concrete Solana adapter is configured.
        """

        raise NotImplementedError("Solana receipt submission requires a configured adapter")

    async def record_mechanism_switch(
        self, task_id: str, from_mechanism: str, to_mechanism: str
    ) -> str:
        """Record an on-chain mechanism switch event.

        Args:
            task_id: Task identifier.
            from_mechanism: Previous mechanism.
            to_mechanism: New mechanism.

        Raises:
            NotImplementedError: No concrete Solana adapter is configured.
        """

        raise NotImplementedError("Mechanism switch recording requires a configured adapter")

    async def get_task_status(self, task_id: str) -> dict[str, Any]:
        """Query task status from chain/indexer.

        Args:
            task_id: Task identifier.

        Raises:
            NotImplementedError: No concrete Solana adapter is configured.
        """

        raise NotImplementedError("Task status retrieval requires a configured adapter")
