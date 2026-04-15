"""Public SDK client for local or hosted Agora arbitration."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict

from agora.runtime.hasher import TranscriptHasher
from agora.runtime.orchestrator import AgoraOrchestrator
from agora.selector.features import extract_features
from agora.types import DeliberationResult, MechanismSelection, MechanismType


class ArbitratorConfig(BaseModel):
    """SDK configuration for the public arbitrator interface."""

    model_config = ConfigDict(frozen=True)

    api_url: str = "http://localhost:8000"
    solana_wallet: str | None = None
    mechanism: str | None = None
    agent_count: int = 3
    auth_token: str | None = None


class AgoraArbitrator:
    """High-level SDK facade over the Agora API or local runtime."""

    def __init__(
        self,
        api_url: str = "http://localhost:8000",
        solana_wallet: str | None = None,
        mechanism: str | None = None,
        agent_count: int = 3,
        auth_token: str | None = None,
    ) -> None:
        self.config = ArbitratorConfig(
            api_url=api_url,
            solana_wallet=solana_wallet,
            mechanism=mechanism,
            agent_count=agent_count,
            auth_token=auth_token,
        )
        self._client = httpx.AsyncClient(base_url=api_url, timeout=120.0)
        self._hasher = TranscriptHasher()
        self._result_task_ids: dict[str, str] = {}

    async def arbitrate(
        self,
        task: str,
        agents: list[Callable[..., Any]] | None = None,
        stakes: float = 0.0,
    ) -> DeliberationResult:
        """Run arbitration remotely through the API or locally with custom agents."""

        if agents is not None:
            local_agent_count = len(agents) if agents else self.config.agent_count
            orchestrator = AgoraOrchestrator(agent_count=local_agent_count)
            return await orchestrator.run(
                task=task,
                stakes=stakes,
                mechanism_override=self.config.mechanism,
                agents=agents,
            )

        create_response = await self._client.post(
            "/tasks/",
            json={
                "task": task,
                "agent_count": self.config.agent_count,
                "stakes": stakes,
            },
            headers=self._headers(),
        )
        create_response.raise_for_status()
        task_payload = create_response.json()
        task_id = str(task_payload["task_id"])

        run_response = await self._client.post(
            f"/tasks/{task_id}/run",
            headers=self._headers(),
        )
        run_response.raise_for_status()

        status_response = await self._client.get(
            f"/tasks/{task_id}",
            params={"detailed": "true"},
            headers=self._headers(),
        )
        status_response.raise_for_status()
        status_payload = status_response.json()
        result = await self._status_to_result(status_payload)
        self._result_task_ids[result.merkle_root] = task_id
        return result

    async def verify_receipt(self, result: DeliberationResult) -> dict[str, bool | None]:
        """Verify the receipt root locally and optionally against stored task metadata."""

        recomputed_root = self._hasher.build_merkle_tree(result.transcript_hashes)
        merkle_match = recomputed_root == result.merkle_root

        on_chain_match: bool | None = None
        if self.config.solana_wallet and self.config.api_url:
            try:
                task_id = self._result_task_ids.get(result.merkle_root)
                if not task_id:
                    raise ValueError("Task id for result is not available")
                status_response = await self._client.get(
                    f"/tasks/{task_id}",
                    params={"detailed": "true"},
                    headers=self._headers(),
                )
                status_response.raise_for_status()
                payload = status_response.json()
                on_chain_match = (
                    payload.get("merkle_root") == result.merkle_root
                    and bool(payload.get("solana_tx_hash"))
                )
            except Exception:
                on_chain_match = None

        return {
            "valid": merkle_match and (on_chain_match in {True, None}),
            "merkle_match": merkle_match,
            "on_chain_match": on_chain_match,
        }

    async def aclose(self) -> None:
        """Close the shared HTTP client."""

        await self._client.aclose()

    async def _status_to_result(self, status_payload: dict[str, Any]) -> DeliberationResult:
        """Convert API task status payload into the core deliberation result model."""

        result_payload = status_payload.get("result")
        if not isinstance(result_payload, dict):
            raise ValueError("Task status did not include a result payload")

        mechanism = MechanismType(str(status_payload["mechanism"]).lower())
        features = await extract_features(
            task_text=str(status_payload["task_text"]),
            agent_count=int(status_payload.get("agent_count", self.config.agent_count)),
            stakes=float(status_payload.get("payment_amount", 0.0)),
        )
        selection = MechanismSelection(
            mechanism=mechanism,
            confidence=float(status_payload.get("selector_confidence", 1.0)),
            reasoning=str(status_payload.get("selector_reasoning", "")),
            reasoning_hash=str(status_payload.get("selector_reasoning_hash", "")),
            bandit_recommendation=mechanism,
            bandit_confidence=float(status_payload.get("selector_confidence", 1.0)),
            task_features=features,
        )
        return DeliberationResult(
            task=str(status_payload["task_text"]),
            mechanism_used=MechanismType(str(result_payload["mechanism"]).lower()),
            mechanism_selection=selection,
            final_answer=str(result_payload["final_answer"]),
            confidence=float(result_payload["confidence"]),
            quorum_reached=bool(result_payload["quorum_reached"]),
            round_count=int(result_payload.get("round_count", 1)),
            agent_count=int(status_payload.get("agent_count", self.config.agent_count)),
            mechanism_switches=int(result_payload.get("mechanism_switches", 0)),
            merkle_root=str(result_payload["merkle_root"]),
            transcript_hashes=list(result_payload.get("transcript_hashes", [])),
            convergence_history=list(result_payload.get("convergence_history", [])),
            locked_claims=list(result_payload.get("locked_claims", [])),
            total_tokens_used=int(result_payload.get("total_tokens_used", 0)),
            total_latency_ms=float(result_payload.get("latency_ms", 0.0)),
        )

    def _headers(self) -> dict[str, str]:
        """Build request headers for the hosted API."""

        if self.config.auth_token:
            return {"Authorization": f"Bearer {self.config.auth_token}"}
        return {}

class AgoraNode:
    """LangGraph-compatible node wrapper that writes Agora results into state."""

    def __init__(
        self,
        api_url: str = "http://localhost:8000",
        mechanism: str | None = None,
        agent_count: int = 3,
        auth_token: str | None = None,
    ) -> None:
        self.arbitrator = AgoraArbitrator(
            api_url=api_url,
            mechanism=mechanism,
            agent_count=agent_count,
            auth_token=auth_token,
        )

    async def __call__(self, state: dict[str, Any]) -> dict[str, Any]:
        """Read a task from state, arbitrate it, and attach `agora_result`."""

        task = state.get("task")
        if not isinstance(task, str) or not task.strip():
            raise ValueError("AgoraNode expects state['task'] to contain a non-empty string")

        result = await self.arbitrator.arbitrate(task)
        return {
            **state,
            "agora_result": result.model_dump(mode="json"),
        }
