"""HTTP-backed Solana integration boundary for Agora runtime."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import httpx
import structlog
from pydantic import BaseModel, ConfigDict, Field

logger = structlog.get_logger(__name__)


def build_task_id(task: str) -> str:
    """Build a deterministic task identifier from raw task text."""

    import hashlib

    return hashlib.sha256(task.strip().encode("utf-8")).hexdigest()


def build_decision_hash(
    *,
    task_id: str,
    mechanism: str,
    merkle_root: str,
    final_answer_hash: str,
    round_count: int,
    mechanism_switches: int,
) -> str:
    """Build a deterministic decision hash for chain submission."""

    import hashlib

    payload = json.dumps(
        {
            "task_id": task_id,
            "mechanism": mechanism,
            "merkle_root": merkle_root,
            "final_answer_hash": final_answer_hash,
            "round_count": round_count,
            "mechanism_switches": mechanism_switches,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class SolanaReceipt(BaseModel):
    """Receipt payload shape expected by the API or contract bridge."""

    model_config = ConfigDict(frozen=True)

    task_id: str
    decision_hash: str
    mechanism: str
    merkle_root: str
    final_answer_hash: str
    quorum_reached: bool
    round_count: int = Field(ge=1)
    mechanism_switches: int = Field(ge=0)
    selector_reasoning_hash: str


class TaskStatus(BaseModel):
    """Normalized task status returned by the external bridge."""

    model_config = ConfigDict(frozen=True)

    task_id: str
    status: str
    tx_signature: str | None = None
    mechanism: str | None = None
    merkle_root: str | None = None
    decision_hash: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SolanaClient:
    """HTTP client for the Josh-owned settlement and task-status boundary."""

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout_seconds: float = 10.0,
        max_retries: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """Initialize the Solana bridge client."""

        self.base_url = (base_url or os.getenv("AGORA_SOLANA_API_URL") or "").rstrip("/")
        self.api_key = api_key or os.getenv("AGORA_SOLANA_API_KEY")
        self.timeout_seconds = max(0.1, timeout_seconds)
        self.max_retries = max(1, max_retries)
        self._transport = transport

    async def submit_receipt(self, receipt: SolanaReceipt) -> str:
        """Submit a completed deliberation receipt and return transaction signature."""

        payload = receipt.model_dump(mode="json")
        response = await self._request(
            "POST",
            f"/tasks/{receipt.task_id}/receipt",
            json_payload=payload,
        )
        tx_signature = response.get("tx_signature")
        if not isinstance(tx_signature, str) or not tx_signature.strip():
            raise RuntimeError("Solana bridge receipt response did not include tx_signature")
        return tx_signature

    async def record_mechanism_switch(
        self, task_id: str, from_mechanism: str, to_mechanism: str
    ) -> str:
        """Record a mechanism switch event and return transaction signature."""

        response = await self._request(
            "POST",
            f"/tasks/{task_id}/mechanism-switch",
            json_payload={
                "task_id": task_id,
                "from_mechanism": from_mechanism,
                "to_mechanism": to_mechanism,
            },
        )
        tx_signature = response.get("tx_signature")
        if not isinstance(tx_signature, str) or not tx_signature.strip():
            raise RuntimeError("Mechanism switch response did not include tx_signature")
        return tx_signature

    async def get_task_status(self, task_id: str) -> dict[str, Any]:
        """Query task status from the external bridge and normalize the payload."""

        response = await self._request("GET", f"/tasks/{task_id}")
        return TaskStatus.model_validate(response).model_dump(mode="json")

    async def _request(
        self,
        method: str,
        path: str,
        json_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Execute a retrying JSON request against the configured bridge."""

        if not self.base_url:
            raise RuntimeError("AGORA_SOLANA_API_URL is not configured for SolanaClient")

        headers = {"Accept": "application/json"}
        if json_payload is not None:
            headers["Content-Type"] = "application/json"
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        retryable_statuses = {408, 409, 425, 429, 500, 502, 503, 504}
        backoff_seconds = 0.5

        for attempt in range(1, self.max_retries + 1):
            try:
                async with httpx.AsyncClient(
                    base_url=self.base_url,
                    timeout=self.timeout_seconds,
                    transport=self._transport,
                ) as client:
                    response = await client.request(
                        method=method,
                        url=path,
                        headers=headers,
                        json=json_payload,
                    )

                if response.status_code in retryable_statuses and attempt < self.max_retries:
                    logger.warning(
                        "solana_client_retrying",
                        method=method,
                        path=path,
                        attempt=attempt,
                        status_code=response.status_code,
                        backoff_seconds=backoff_seconds,
                    )
                    await asyncio.sleep(backoff_seconds)
                    backoff_seconds *= 2.0
                    continue

                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise RuntimeError("Solana bridge response was not a JSON object")
                return payload
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                if attempt >= self.max_retries:
                    raise RuntimeError("Solana bridge request failed after retries") from exc
                logger.warning(
                    "solana_client_retrying",
                    method=method,
                    path=path,
                    attempt=attempt,
                    error=str(exc),
                    backoff_seconds=backoff_seconds,
                )
                await asyncio.sleep(backoff_seconds)
                backoff_seconds *= 2.0
            except httpx.HTTPStatusError as exc:
                status_code = exc.response.status_code
                if status_code in retryable_statuses and attempt < self.max_retries:
                    logger.warning(
                        "solana_client_retrying",
                        method=method,
                        path=path,
                        attempt=attempt,
                        status_code=status_code,
                        backoff_seconds=backoff_seconds,
                    )
                    await asyncio.sleep(backoff_seconds)
                    backoff_seconds *= 2.0
                    continue
                raise RuntimeError(
                    f"Solana bridge request failed with status {status_code}"
                ) from exc

        raise RuntimeError("Unexpected retry loop termination in SolanaClient")
