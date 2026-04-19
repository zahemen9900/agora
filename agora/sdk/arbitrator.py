"""Public SDK client for local or hosted Agora arbitration."""

from __future__ import annotations

import base64
import hashlib
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey

from agora.runtime.hasher import TranscriptHasher
from agora.runtime.orchestrator import AgoraOrchestrator
from agora.selector.features import extract_features
from agora.types import (
    ConvergenceMetrics,
    DeliberationResult,
    MechanismSelection,
    MechanismType,
    ReasoningPresetOverrides,
    ReasoningPresets,
    VerifiedClaim,
)

MechanismName = Literal["debate", "vote"]
TaskStatusName = Literal["pending", "in_progress", "completed", "failed", "paid"]
ChainOperationStatusName = Literal["pending", "succeeded", "failed"]
DEFAULT_PROGRAM_ID = "82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd"
DEFAULT_HTTP_TIMEOUT_SECONDS = 300.0


@dataclass(frozen=True)
class _OnChainTaskAccount:
    selector_reasoning_hash: str
    transcript_merkle_root: str
    decision_hash: str
    quorum_reached: bool
    mechanism: MechanismName
    switched_to: MechanismName | None
    mechanism_switches: int
    status: TaskStatusName


@dataclass(frozen=True)
class _OnChainMechanismSwitchLog:
    switch_index: int
    from_mechanism: MechanismName
    to_mechanism: MechanismName
    reason_hash: str
    round_number: int


class ArbitratorConfig(BaseModel):
    """SDK configuration for the public arbitrator interface."""

    model_config = ConfigDict(frozen=True)

    api_url: str = "http://localhost:8000"
    solana_wallet: str | None = None
    mechanism: MechanismName | None = None
    agent_count: int = 4
    reasoning_presets: ReasoningPresetOverrides | None = None
    auth_token: str | None = None
    strict_verification: bool = True
    rpc_url: str = ""
    program_id: str = DEFAULT_PROGRAM_ID
    http_timeout_seconds: float = Field(default=DEFAULT_HTTP_TIMEOUT_SECONDS, gt=0)


class HostedTaskCreateResponse(BaseModel):
    """Task creation payload returned by the hosted API."""

    model_config = ConfigDict(extra="ignore")

    task_id: str = ""
    mechanism: MechanismName = "debate"
    confidence: float = 0.0
    reasoning: str = ""
    selector_reasoning_hash: str = ""
    status: TaskStatusName = "pending"


class HostedDeliberationResult(BaseModel):
    """Hosted deliberation result payload returned by run/status endpoints."""

    model_config = ConfigDict(extra="ignore")

    task_id: str = ""
    mechanism: MechanismName = "debate"
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
    convergence_history: list[ConvergenceMetrics] = Field(default_factory=list)
    locked_claims: list[VerifiedClaim] = Field(default_factory=list)


class HostedChainOperationRecord(BaseModel):
    """Write-ahead status for one hosted chain side effect."""

    model_config = ConfigDict(extra="ignore")

    status: ChainOperationStatusName
    tx_hash: str | None = None
    explorer_url: str | None = None
    error: str | None = None
    attempts: int = Field(default=0, ge=0)
    updated_at: datetime | None = None


class HostedTaskStatus(BaseModel):
    """Detailed task status payload returned by the hosted API."""

    model_config = ConfigDict(extra="ignore")

    task_id: str = ""
    task_text: str = ""
    workspace_id: str = ""
    created_by: str = ""
    mechanism: MechanismName = "debate"
    mechanism_override: MechanismName | None = None
    status: TaskStatusName = "pending"
    selector_reasoning: str = ""
    selector_reasoning_hash: str = ""
    selector_confidence: float = 0.0
    merkle_root: str | None = None
    decision_hash: str | None = None
    quorum_reached: bool | None = None
    agent_count: int = 1
    reasoning_presets: ReasoningPresets | None = None
    round_count: int = 0
    mechanism_switches: int = 0
    transcript_hashes: list[str] = Field(default_factory=list)
    solana_tx_hash: str | None = None
    explorer_url: str | None = None
    payment_amount: float = 0.0
    payment_status: Literal["locked", "released", "none"] = "none"
    chain_operations: dict[str, HostedChainOperationRecord] = Field(default_factory=dict)
    created_at: str | None = None
    completed_at: str | None = None
    result: HostedDeliberationResult | None = None
    events: list[dict[str, Any]] = Field(default_factory=list)


class HostedCostEstimate(BaseModel):
    """Normalized estimated USD cost metadata."""

    model_config = ConfigDict(extra="ignore")

    estimated_cost_usd: float | None = None
    model_estimated_costs_usd: dict[str, float] = Field(default_factory=dict)
    pricing_version: str | None = None
    estimated_at: datetime | None = None
    estimation_mode: str | None = None
    pricing_sources: dict[str, str] = Field(default_factory=dict)


class HostedModelTelemetry(BaseModel):
    """Per-model telemetry for hosted task and benchmark flows."""

    model_config = ConfigDict(extra="ignore")

    total_tokens: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0
    latency_ms: float = 0.0
    estimated_cost_usd: float | None = None
    estimation_mode: str | None = None


class HostedBenchmarkRunResponse(BaseModel):
    """Benchmark run trigger acknowledgement."""

    model_config = ConfigDict(extra="ignore")

    run_id: str
    status: str
    created_at: datetime | None = None


class HostedBenchmarkRunStatus(BaseModel):
    """Queued/running/completed benchmark run status."""

    model_config = ConfigDict(extra="ignore")

    run_id: str
    status: str
    created_at: datetime | None = None
    updated_at: datetime | None = None
    error: str | None = None
    artifact_id: str | None = None
    request: dict[str, Any] | None = None
    latest_mechanism: str | None = None
    agent_count: int | None = None
    total_tokens: int | None = None
    thinking_tokens: int | None = None
    total_latency_ms: float | None = None
    model_telemetry: dict[str, HostedModelTelemetry] = Field(default_factory=dict)
    cost: HostedCostEstimate | None = None


class HostedBenchmarkDetail(BaseModel):
    """Detailed benchmark payload for artifact or live run routes."""

    model_config = ConfigDict(extra="ignore")

    benchmark_id: str
    artifact_id: str | None = None
    run_id: str | None = None
    scope: str
    source: str
    status: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    run_count: int = 0
    mechanism_counts: dict[str, int] = Field(default_factory=dict)
    model_counts: dict[str, int] = Field(default_factory=dict)
    latest_mechanism: str | None = None
    agent_count: int | None = None
    total_tokens: int = 0
    thinking_tokens: int = 0
    total_latency_ms: float = 0.0
    models: list[str] = Field(default_factory=list)
    request: dict[str, Any] | None = None
    model_telemetry: dict[str, HostedModelTelemetry] = Field(default_factory=dict)
    events: list[dict[str, Any]] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    benchmark_payload: dict[str, Any] = Field(default_factory=dict)
    cost: HostedCostEstimate | None = None


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
        mechanism: MechanismName | None = None,
        agent_count: int = 4,
        reasoning_presets: ReasoningPresetOverrides | None = None,
        auth_token: str | None = None,
        strict_verification: bool = True,
        rpc_url: str = "",
        program_id: str = DEFAULT_PROGRAM_ID,
        http_timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
    ) -> None:
        self.config = ArbitratorConfig(
            api_url=api_url,
            solana_wallet=solana_wallet,
            mechanism=mechanism,
            agent_count=agent_count,
            reasoning_presets=reasoning_presets,
            auth_token=auth_token,
            strict_verification=strict_verification,
            rpc_url=rpc_url,
            program_id=program_id,
            http_timeout_seconds=http_timeout_seconds,
        )
        self._client = httpx.AsyncClient(
            base_url=api_url,
            timeout=httpx.Timeout(self.config.http_timeout_seconds),
        )
        self._hasher = TranscriptHasher()
        self._result_task_ids: dict[str, str] = {}
        self._latest_task_id: str | None = None

    async def __aenter__(self) -> AgoraArbitrator:
        """Return this arbitrator and close its HTTP client on context exit."""

        return self

    async def __aexit__(self, *_exc_info: object) -> None:
        """Close the shared HTTP client when leaving an async context."""

        await self.aclose()

    @property
    def latest_task_id(self) -> str | None:
        """Most recent hosted task id created or fetched by this client."""

        return self._latest_task_id

    async def create_task(
        self,
        task: str,
        *,
        stakes: float = 0.0,
        mechanism: MechanismName | None = None,
        agent_count: int | None = None,
        reasoning_presets: ReasoningPresetOverrides | dict[str, Any] | None = None,
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
        effective_reasoning_presets = reasoning_presets or self.config.reasoning_presets
        if effective_reasoning_presets is not None:
            payload["reasoning_presets"] = (
                effective_reasoning_presets.model_dump(mode="json")
                if isinstance(effective_reasoning_presets, BaseModel)
                else effective_reasoning_presets
            )

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

    async def run_benchmark(self, **payload: Any) -> HostedBenchmarkRunResponse:
        """Trigger a hosted benchmark run."""

        response = await self._client.post(
            "/benchmarks/run",
            json=payload,
            headers=self._headers(),
        )
        response.raise_for_status()
        return HostedBenchmarkRunResponse.model_validate(response.json())

    async def get_benchmark_run_status(self, run_id: str) -> HostedBenchmarkRunStatus:
        """Fetch a hosted benchmark run status."""

        response = await self._client.get(
            f"/benchmarks/runs/{run_id}",
            headers=self._headers(),
        )
        response.raise_for_status()
        return HostedBenchmarkRunStatus.model_validate(response.json())

    async def get_benchmark_detail(self, benchmark_id: str) -> HostedBenchmarkDetail:
        """Fetch a hosted benchmark detail payload by run_id or artifact_id."""

        response = await self._client.get(
            f"/benchmarks/{benchmark_id}",
            headers=self._headers(),
        )
        response.raise_for_status()
        return HostedBenchmarkDetail.model_validate(response.json())

    async def stream_benchmark_run_events(
        self,
        run_id: str,
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream benchmark run SSE events with replay from the hosted API."""

        ticket_response = await self._client.post(
            f"/benchmarks/runs/{run_id}/stream-ticket",
            headers=self._headers(),
        )
        ticket_response.raise_for_status()
        ticket_payload = ticket_response.json()
        ticket = str(ticket_payload["ticket"])

        async with self._client.stream(
            "GET",
            f"/benchmarks/runs/{run_id}/stream",
            params={"ticket": ticket},
            headers=self._headers(),
        ) as response:
            response.raise_for_status()
            event_type = "message"
            data_lines: list[str] = []

            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    event_type = line[6:].strip()
                    continue
                if line.startswith("data:"):
                    data_lines.append(line[5:].strip())
                    continue
                if line:
                    continue
                if not data_lines:
                    event_type = "message"
                    continue
                raw_data = "\n".join(data_lines)
                data_lines = []
                try:
                    payload = json.loads(raw_data)
                except json.JSONDecodeError:
                    payload = {"payload": {"message": raw_data}, "timestamp": None}
                yield {
                    "event": event_type,
                    "data": payload.get("payload", payload),
                    "timestamp": payload.get("timestamp"),
                }
                event_type = "message"

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
            orchestrator = AgoraOrchestrator(
                agent_count=local_agent_count,
                reasoning_presets=self.config.reasoning_presets,
            )
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
        task_id: str | None = None,
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
        status: HostedTaskStatus | None = None
        resolved_task_id = task_id or self._result_task_ids.get(result.merkle_root)
        if resolved_task_id:
            try:
                status = await self.get_task_status(resolved_task_id, detailed=True)
            except Exception as exc:
                if strict_mode:
                    raise ReceiptVerificationError(f"Hosted receipt fetch failed: {exc}") from exc
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
            assert resolved_task_id is not None
            if status is None:
                raise ReceiptVerificationError(
                    "Strict receipt verification requires hosted task metadata"
                )
            if not self.config.rpc_url.strip():
                raise ReceiptVerificationError("Strict receipt verification requires rpc_url")
            on_chain_match = await self._verify_onchain_receipt(
                task_id=resolved_task_id,
                status=status,
                result=result,
            )
            if not on_chain_match:
                raise ReceiptVerificationError("Strict on-chain receipt verification failed")

        valid = (
            merkle_match
            and (hosted_metadata_match in {True, None})
            and (on_chain_match in {True, None})
        )
        return {
            "valid": valid,
            "merkle_match": merkle_match,
            "hosted_metadata_match": hosted_metadata_match,
            "on_chain_match": on_chain_match,
        }

    async def _verify_onchain_receipt(
        self,
        *,
        task_id: str,
        status: HostedTaskStatus,
        result: DeliberationResult,
    ) -> bool:
        task_account = await self._fetch_onchain_task_account(task_id)
        if task_account is None:
            raise ReceiptVerificationError(f"On-chain task account not found for task_id={task_id}")

        expected_decision_hash = self._hasher.hash_content(result.final_answer)
        if status.status not in {"completed", "paid"}:
            return False
        if task_account.selector_reasoning_hash != status.selector_reasoning_hash:
            return False
        if task_account.transcript_merkle_root != result.merkle_root:
            return False
        if task_account.decision_hash != expected_decision_hash:
            return False
        if task_account.quorum_reached != result.quorum_reached:
            return False
        if task_account.mechanism != result.mechanism_used.value:
            return False
        if task_account.mechanism_switches != result.mechanism_switches:
            return False
        if status.status == "completed" and task_account.status != "completed":
            return False
        if status.status == "paid" and task_account.status != "paid":
            return False
        if result.mechanism_switches == 0:
            return True

        switch_events = [
            event for event in status.events if event.get("event") == "mechanism_switch"
        ]
        if len(switch_events) != result.mechanism_switches:
            return False

        for switch_index, event in enumerate(switch_events):
            switch_log = await self._fetch_onchain_switch_log(task_id, switch_index)
            if switch_log is None:
                return False
            data = event.get("data") or {}
            if not isinstance(data, dict):
                return False
            if switch_log.from_mechanism != str(data.get("from_mechanism", "")):
                return False
            if switch_log.to_mechanism != str(data.get("to_mechanism", "")):
                return False
            if switch_log.round_number != int(data.get("round_number", 0)):
                return False
            expected_reason_hash = self._hasher.hash_content(str(data.get("reason", "")))
            if switch_log.reason_hash != expected_reason_hash:
                return False
        return True

    async def _fetch_onchain_task_account(self, task_id: str) -> _OnChainTaskAccount | None:
        payload = await self._fetch_account_bytes(self._derive_task_pda(task_id))
        if payload is None:
            return None
        return self._parse_task_account(payload)

    async def _fetch_onchain_switch_log(
        self,
        task_id: str,
        switch_index: int,
    ) -> _OnChainMechanismSwitchLog | None:
        payload = await self._fetch_account_bytes(self._derive_switch_pda(task_id, switch_index))
        if payload is None:
            return None
        return self._parse_switch_log(payload)

    async def _fetch_account_bytes(self, account: Pubkey) -> bytes | None:
        async with AsyncClient(self.config.rpc_url) as client:
            response = await client.get_account_info(
                account,
                encoding="base64",
                commitment="confirmed",
            )
        value = response.value
        if value is None:
            return None
        data = value.data
        if isinstance(data, bytes | bytearray):
            return bytes(data)
        if isinstance(data, tuple):
            encoded = data[0]
        elif isinstance(data, list):
            encoded = data[0]
        else:
            encoded = data
        if isinstance(encoded, bytes | bytearray):
            return bytes(encoded)
        if not isinstance(encoded, str):
            raise ReceiptVerificationError("Unexpected account data encoding from Solana RPC")
        return base64.b64decode(encoded)

    def _derive_task_pda(self, task_id: str) -> Pubkey:
        return Pubkey.find_program_address(
            [b"task", bytes.fromhex(task_id)],
            Pubkey.from_string(self.config.program_id),
        )[0]

    def _derive_switch_pda(self, task_id: str, switch_index: int) -> Pubkey:
        return Pubkey.find_program_address(
            [b"switch", bytes.fromhex(task_id), bytes([switch_index])],
            Pubkey.from_string(self.config.program_id),
        )[0]

    @staticmethod
    def _account_discriminator(name: str) -> bytes:
        return hashlib.sha256(f"account:{name}".encode()).digest()[:8]

    @staticmethod
    def _parse_mechanism(value: int) -> MechanismName:
        mapping: dict[int, MechanismName] = {0: "debate", 1: "vote"}
        mechanism = mapping.get(value)
        if mechanism is None:
            raise ReceiptVerificationError(f"Unsupported on-chain mechanism value: {value}")
        return mechanism

    @staticmethod
    def _parse_task_status(value: int) -> TaskStatusName:
        mapping: dict[int, TaskStatusName] = {
            0: "pending",
            1: "in_progress",
            2: "completed",
            3: "failed",
            4: "paid",
        }
        status = mapping.get(value)
        if status is None:
            raise ReceiptVerificationError(f"Unsupported on-chain task status value: {value}")
        return status

    @staticmethod
    def _read_u8(payload: bytes, offset: int) -> tuple[int, int]:
        return payload[offset], offset + 1

    @staticmethod
    def _read_bool(payload: bytes, offset: int) -> tuple[bool, int]:
        value, offset = AgoraArbitrator._read_u8(payload, offset)
        return bool(value), offset

    @staticmethod
    def _read_bytes(payload: bytes, offset: int, size: int) -> tuple[bytes, int]:
        return payload[offset : offset + size], offset + size

    @staticmethod
    def _read_option_u8(payload: bytes, offset: int) -> tuple[int | None, int]:
        tag, offset = AgoraArbitrator._read_u8(payload, offset)
        if tag == 0:
            return None, offset
        value, offset = AgoraArbitrator._read_u8(payload, offset)
        return value, offset

    @staticmethod
    def _read_i64(payload: bytes, offset: int) -> tuple[int, int]:
        chunk, offset = AgoraArbitrator._read_bytes(payload, offset, 8)
        return int.from_bytes(chunk, "little", signed=True), offset

    @staticmethod
    def _read_u64(payload: bytes, offset: int) -> tuple[int, int]:
        chunk, offset = AgoraArbitrator._read_bytes(payload, offset, 8)
        return int.from_bytes(chunk, "little"), offset

    def _parse_task_account(self, payload: bytes) -> _OnChainTaskAccount:
        if payload[:8] != self._account_discriminator("TaskAccount"):
            raise ReceiptVerificationError("Unexpected TaskAccount discriminator")
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
        _, offset = self._read_u64(payload, offset)
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

        return _OnChainTaskAccount(
            selector_reasoning_hash=selector_reasoning_hash.hex(),
            transcript_merkle_root=transcript_merkle_root.hex(),
            decision_hash=decision_hash.hex(),
            quorum_reached=quorum_reached,
            mechanism=self._parse_mechanism(mechanism_value),
            switched_to=(
                self._parse_mechanism(switched_to_value) if switched_to_value is not None else None
            ),
            mechanism_switches=mechanism_switches,
            status=self._parse_task_status(status_value),
        )

    def _parse_switch_log(self, payload: bytes) -> _OnChainMechanismSwitchLog:
        if payload[:8] != self._account_discriminator("MechanismSwitchLog"):
            raise ReceiptVerificationError("Unexpected MechanismSwitchLog discriminator")
        offset = 8
        _, offset = self._read_bytes(payload, offset, 32)
        switch_index, offset = self._read_u8(payload, offset)
        from_mechanism, offset = self._read_u8(payload, offset)
        to_mechanism, offset = self._read_u8(payload, offset)
        reason_hash, offset = self._read_bytes(payload, offset, 32)
        round_number, offset = self._read_u8(payload, offset)
        _, offset = self._read_i64(payload, offset)
        _, offset = self._read_u8(payload, offset)

        return _OnChainMechanismSwitchLog(
            switch_index=switch_index,
            from_mechanism=self._parse_mechanism(from_mechanism),
            to_mechanism=self._parse_mechanism(to_mechanism),
            reason_hash=reason_hash.hex(),
            round_number=round_number,
        )

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
        mechanism: MechanismName | None = None,
        agent_count: int = 4,
        auth_token: str | None = None,
        strict_verification: bool = True,
        rpc_url: str = "",
        program_id: str = DEFAULT_PROGRAM_ID,
        http_timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
    ) -> None:
        self.arbitrator = AgoraArbitrator(
            api_url=api_url,
            solana_wallet=solana_wallet,
            mechanism=mechanism,
            agent_count=agent_count,
            auth_token=auth_token,
            strict_verification=strict_verification,
            rpc_url=rpc_url,
            program_id=program_id,
            http_timeout_seconds=http_timeout_seconds,
        )

    async def __aenter__(self) -> AgoraNode:
        """Return this node and close its wrapped arbitrator on context exit."""

        return self

    async def __aexit__(self, *_exc_info: object) -> None:
        """Close the wrapped arbitrator when leaving an async context."""

        await self.aclose()

    async def aclose(self) -> None:
        """Close the wrapped arbitrator's shared HTTP client."""

        await self.arbitrator.aclose()

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
