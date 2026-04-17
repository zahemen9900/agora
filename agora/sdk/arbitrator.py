"""Public SDK client for local or hosted Agora arbitration."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

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
    strict_verification: bool = True


class HostedTaskCreateResponse(BaseModel):
    """Task creation payload returned by the hosted API."""

    model_config = ConfigDict(extra="ignore")

    task_id: str = ""
    mechanism: str = ""
    confidence: float = 0.0
    reasoning: str = ""
    selector_reasoning_hash: str = ""
    status: str = "pending"


class HostedDeliberationResult(BaseModel):
    """Hosted deliberation result payload returned by run/status endpoints."""

    model_config = ConfigDict(extra="ignore")

    task_id: str = ""
    mechanism: str = ""
    final_answer: str = ""
    confidence: float = 0.0
    quorum_reached: bool = False
    merkle_root: str | None = None
    decision_hash: str | None = None
    agent_count: int = 1
    agent_models_used: list[str] = Field(default_factory=list)
    total_tokens_used: int = 0
    latency_ms: float = 0.0
    round_count: int = 1
    mechanism_switches: int = 0
    transcript_hashes: list[str] = Field(default_factory=list)
    convergence_history: list[dict[str, Any]] = Field(default_factory=list)
    locked_claims: list[dict[str, Any]] = Field(default_factory=list)


class HostedTaskStatus(BaseModel):
    """Detailed task status payload returned by the hosted API."""

    model_config = ConfigDict(extra="ignore")

    task_id: str = ""
    task_text: str = ""
    workspace_id: str = ""
    created_by: str = ""
    mechanism: str = ""
    mechanism_override: str | None = None
    status: str = ""
    selector_reasoning: str = ""
    selector_reasoning_hash: str = ""
    selector_confidence: float = 0.0
    merkle_root: str | None = None
    decision_hash: str | None = None
    quorum_reached: bool | None = None
    agent_count: int = 1
    round_count: int = 0
    mechanism_switches: int = 0
    transcript_hashes: list[str] = Field(default_factory=list)
    solana_tx_hash: str | None = None
    explorer_url: str | None = None
    payment_amount: float = 0.0
    payment_status: str = "none"
    created_at: str | None = None
    completed_at: str | None = None
    result: HostedDeliberationResult | None = None
    events: list[dict[str, Any]] = Field(default_factory=list)


class HostedPaymentReleaseResponse(BaseModel):
    """Hosted payment release payload."""

    model_config = ConfigDict(extra="ignore")

    released: bool
    tx_hash: str


class ReceiptVerificationError(RuntimeError):
    """Raised when strict receipt verification fails."""


class AgoraArbitrator:
    """High-level SDK facade over the Agora API or local runtime."""

    def __init__(
        self,
        api_url: str = "http://localhost:8000",
        solana_wallet: str | None = None,
        mechanism: str | None = None,
        agent_count: int = 3,
        auth_token: str | None = None,
        strict_verification: bool = True,
    ) -> None:
        self.config = ArbitratorConfig(
            api_url=api_url,
            solana_wallet=solana_wallet,
            mechanism=mechanism,
            agent_count=agent_count,
            auth_token=auth_token,
            strict_verification=strict_verification,
        )
        self._client = httpx.AsyncClient(base_url=api_url, timeout=120.0)
        self._hasher = TranscriptHasher()
        self._result_task_ids: dict[str, str] = {}
        self._latest_task_id: str | None = None

    @property
    def latest_task_id(self) -> str | None:
        """Most recent hosted task id created or fetched by this client."""

        return self._latest_task_id

    async def create_task(
        self,
        task: str,
        *,
        stakes: float = 0.0,
        mechanism: str | None = None,
        agent_count: int | None = None,
    ) -> HostedTaskCreateResponse:
        """Create a hosted task without executing it."""

        payload: dict[str, Any] = {
            "task": task,
            "agent_count": agent_count or self.config.agent_count,
            "stakes": stakes,
        }
        effective_mechanism = mechanism or self.config.mechanism
        if effective_mechanism is not None:
            payload["mechanism_override"] = effective_mechanism

        response = await self._client.post(
            "/tasks/",
            json=payload,
            headers=self._headers(),
        )
        response.raise_for_status()
        parsed = HostedTaskCreateResponse.model_validate(response.json())
        self._latest_task_id = parsed.task_id
        return parsed

    async def run_task(self, task_id: str) -> HostedDeliberationResult:
        """Execute a previously created hosted task."""

        response = await self._client.post(
            f"/tasks/{task_id}/run",
            headers=self._headers(),
        )
        response.raise_for_status()
        self._latest_task_id = task_id
        return HostedDeliberationResult.model_validate(response.json())

    async def get_task_status(
        self,
        task_id: str,
        *,
        detailed: bool = True,
    ) -> HostedTaskStatus:
        """Fetch a hosted task status payload."""

        response = await self._client.get(
            f"/tasks/{task_id}",
            params={"detailed": str(detailed).lower()},
            headers=self._headers(),
        )
        response.raise_for_status()
        self._latest_task_id = task_id
        return HostedTaskStatus.model_validate(response.json())

    async def get_task_result(self, task_id: str) -> DeliberationResult:
        """Fetch and convert a hosted task into the core deliberation result type."""

        status = await self.get_task_status(task_id, detailed=True)
        result = await self._status_to_result(status)
        self._result_task_ids[result.merkle_root] = task_id
        return result

    async def release_payment(self, task_id: str) -> HostedPaymentReleaseResponse:
        """Release payment for a completed hosted task."""

        response = await self._client.post(
            f"/tasks/{task_id}/pay",
            headers=self._headers(),
        )
        response.raise_for_status()
        self._latest_task_id = task_id
        return HostedPaymentReleaseResponse.model_validate(response.json())

    def task_id_for_result(self, result: DeliberationResult) -> str | None:
        """Return the hosted task id associated with a deliberation result when known."""

        return self._result_task_ids.get(result.merkle_root)

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

        created = await self.create_task(task, stakes=stakes)
        await self.run_task(created.task_id)
        return await self.get_task_result(created.task_id)

    async def verify_receipt(
        self,
        result: DeliberationResult,
        *,
        strict: bool | None = None,
    ) -> dict[str, bool | None]:
        """Verify receipt root locally and, when available, against hosted receipt metadata.

        Strict mode fails closed unless a real chain proof verifier is available.
        """

        strict_mode = self.config.strict_verification if strict is None else strict

        recomputed_root = self._hasher.build_merkle_tree(result.transcript_hashes)
        merkle_match = recomputed_root == result.merkle_root
        if strict_mode and not merkle_match:
            raise ReceiptVerificationError("Local Merkle verification failed")

        hosted_metadata_match: bool | None = None
        task_id = self._result_task_ids.get(result.merkle_root)
        if task_id:
            try:
                status = await self.get_task_status(task_id, detailed=True)
            except Exception as exc:
                if strict_mode:
                    raise ReceiptVerificationError(
                        f"Hosted receipt fetch failed: {exc}"
                    ) from exc
            else:
                hosted_metadata_match = self._hosted_receipt_matches(status, result)
                if strict_mode and not hosted_metadata_match:
                    raise ReceiptVerificationError(
                        "Hosted receipt verification failed: stored receipt fields mismatch"
                    )
        elif strict_mode:
            raise ReceiptVerificationError(
                "Strict receipt verification requires a hosted task_id and chain proof"
            )

        on_chain_match: bool | None = None
        if strict_mode:
            raise ReceiptVerificationError(
                "Strict on-chain receipt verification is not implemented"
            )

        valid = merkle_match and (hosted_metadata_match in {True, None})
        return {
            "valid": valid,
            "merkle_match": merkle_match,
            "hosted_metadata_match": hosted_metadata_match,
            "on_chain_match": on_chain_match,
        }

    def _hosted_receipt_matches(
        self,
        payload: HostedTaskStatus | dict[str, Any],
        result: DeliberationResult,
    ) -> bool:
        """Validate hosted receipt payload fields against the local deliberation result."""

        if isinstance(payload, HostedTaskStatus):
            payload_dict = payload.model_dump(mode="json")
        else:
            payload_dict = payload

        result_payload = payload_dict.get("result")
        if not isinstance(result_payload, dict):
            return False

        transcript_hashes_raw = result_payload.get("transcript_hashes")
        if not isinstance(transcript_hashes_raw, list):
            return False

        transcript_hashes = [str(item) for item in transcript_hashes_raw]
        expected_decision_hash = self._hasher.hash_content(result.final_answer)
        recomputed_root = self._hasher.build_merkle_tree(transcript_hashes)

        return (
            bool(payload_dict.get("solana_tx_hash"))
            and str(payload_dict.get("merkle_root", "")) == result.merkle_root
            and str(payload_dict.get("decision_hash", "")) == expected_decision_hash
            and str(result_payload.get("merkle_root", "")) == result.merkle_root
            and str(result_payload.get("decision_hash", "")) == expected_decision_hash
            and str(result_payload.get("final_answer", "")) == result.final_answer
            and transcript_hashes == result.transcript_hashes
            and recomputed_root == result.merkle_root
        )

    async def aclose(self) -> None:
        """Close the shared HTTP client."""

        await self._client.aclose()

    async def _status_to_result(
        self,
        status_payload: HostedTaskStatus | dict[str, Any],
    ) -> DeliberationResult:
        """Convert an API task status payload into the core deliberation result model."""

        if isinstance(status_payload, HostedTaskStatus):
            status = status_payload
        else:
            status = HostedTaskStatus.model_validate(status_payload)

        if status.result is None:
            raise ValueError("Task status did not include a result payload")

        mechanism = MechanismType(str(status.mechanism).lower())
        features = await extract_features(
            task_text=str(status.task_text),
            agent_count=int(status.agent_count or self.config.agent_count),
            stakes=float(status.payment_amount or 0.0),
        )
        selection = MechanismSelection(
            mechanism=mechanism,
            confidence=float(status.selector_confidence or 1.0),
            reasoning=str(status.selector_reasoning),
            reasoning_hash=str(status.selector_reasoning_hash),
            bandit_recommendation=mechanism,
            bandit_confidence=float(status.selector_confidence or 1.0),
            task_features=features,
        )
        return DeliberationResult(
            task=str(status.task_text),
            mechanism_used=MechanismType(str(status.result.mechanism).lower()),
            mechanism_selection=selection,
            final_answer=str(status.result.final_answer),
            confidence=float(status.result.confidence),
            quorum_reached=bool(status.result.quorum_reached),
            round_count=int(status.result.round_count),
            agent_count=int(status.agent_count or self.config.agent_count),
            mechanism_switches=int(status.result.mechanism_switches),
            merkle_root=str(status.result.merkle_root),
            transcript_hashes=list(status.result.transcript_hashes),
            agent_models_used=list(status.result.agent_models_used),
            convergence_history=list(status.result.convergence_history),
            locked_claims=list(status.result.locked_claims),
            total_tokens_used=int(status.result.total_tokens_used),
            total_latency_ms=float(status.result.latency_ms),
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
        solana_wallet: str | None = None,
        mechanism: str | None = None,
        agent_count: int = 3,
        auth_token: str | None = None,
        strict_verification: bool = True,
    ) -> None:
        self.arbitrator = AgoraArbitrator(
            api_url=api_url,
            solana_wallet=solana_wallet,
            mechanism=mechanism,
            agent_count=agent_count,
            auth_token=auth_token,
            strict_verification=strict_verification,
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
