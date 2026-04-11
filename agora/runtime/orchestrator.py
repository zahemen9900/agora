"""Main orchestration pipeline for mechanism selection and execution."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import structlog

from agora.engines.debate import DebateEngine
from agora.engines.vote import VoteEngine
from agora.runtime.hasher import TranscriptHasher
from agora.runtime.monitor import StateMonitor
from agora.selector.selector import AgoraSelector
from agora.solana.client import SolanaClient, SolanaReceipt, build_decision_hash, build_task_id
from agora.types import DeliberationResult, MechanismSelection, MechanismType, SettlementRecord

logger = structlog.get_logger(__name__)


class AgoraOrchestrator:
    """Top-level orchestrator tying selection, engines, and post-run learning."""

    def __init__(
        self,
        agent_count: int = 3,
        bandit_state_path: str | None = None,
        default_stakes: float = 0.5,
        solana_client: SolanaClient | None = None,
        auto_submit_receipts: bool = False,
    ) -> None:
        """Initialize orchestrator dependencies.

        Args:
            agent_count: Number of participating agents.
            bandit_state_path: Optional persistence path for selector bandit state.
            default_stakes: Fallback normalized stakes value.
            solana_client: Optional client for Josh-side settlement bridge.
            auto_submit_receipts: Whether to submit built receipts after execution.
        """

        self.agent_count = max(1, agent_count)
        self.default_stakes = max(0.0, min(1.0, default_stakes))
        self.solana_client = solana_client
        self.auto_submit_receipts = auto_submit_receipts

        self.selector = AgoraSelector(bandit_state_path=bandit_state_path)
        self.hasher = TranscriptHasher()
        self.monitor = StateMonitor()
        self.debate_engine = DebateEngine(
            agent_count=self.agent_count,
            monitor=self.monitor,
            hasher=self.hasher,
        )
        self.vote_engine = VoteEngine(
            agent_count=self.agent_count,
            quorum_threshold=0.6,
            hasher=self.hasher,
        )

    async def run(self, task: str, stakes: float | None = None) -> DeliberationResult:
        """Execute full selection-to-deliberation pipeline.

        Args:
            task: Input task/question.
            stakes: Optional normalized stake override.

        Returns:
            DeliberationResult: Final deliberation artifact.

        Raises:
            RuntimeError: If no mechanism produces a result.
        """

        normalized_stakes = self.default_stakes if stakes is None else max(0.0, min(1.0, stakes))
        selection = await self.selector.select(
            task_text=task,
            agent_count=self.agent_count,
            stakes=normalized_stakes,
        )

        logger.info(
            "orchestrator_mechanism_selected",
            mechanism=selection.mechanism.value,
            confidence=selection.confidence,
            reasoning_hash=selection.reasoning_hash,
            bandit_recommendation=selection.bandit_recommendation.value,
            bandit_confidence=selection.bandit_confidence,
        )

        result = await self._execute_mechanism(task=task, selection=selection)

        receipt = self.hasher.build_receipt(
            hashes=result.transcript_hashes,
            mechanism=result.mechanism_used,
            final_answer=result.final_answer,
            quorum_reached=result.quorum_reached,
            round_count=result.round_count,
            mechanism_switches=result.mechanism_switches,
        )
        logger.info(
            "orchestrator_receipt_built",
            mechanism=result.mechanism_used.value,
            merkle_root=receipt["merkle_root"],
            leaf_count=receipt["leaf_count"],
        )
        if self.auto_submit_receipts:
            submission = await self.submit_result(result=result, receipt=receipt)
            result = result.model_copy(
                update={
                    "chain_submission": submission,
                    "timestamp": datetime.now(UTC),
                }
            )
        return result

    async def run_and_learn(
        self,
        task: str,
        ground_truth: str | None = None,
        stakes: float | None = None,
    ) -> DeliberationResult:
        """Run task and update selector from reward signal.

        Args:
            task: Input task/question.
            ground_truth: Optional expected answer for supervised reward.
            stakes: Optional normalized stake override.

        Returns:
            DeliberationResult: Execution result.
        """

        result = await self.run(task=task, stakes=stakes)

        if ground_truth is not None:
            reward = (
                1.0 if result.final_answer.strip().lower() == ground_truth.strip().lower() else 0.0
            )
        else:
            reward = result.confidence * (1.0 if result.quorum_reached else 0.5)

        self.selector.update_with_mechanism(
            result.mechanism_selection,
            reward,
            mechanism=result.mechanism_used,
        )
        logger.info(
            "orchestrator_bandit_updated",
            reward=reward,
            mechanism=result.mechanism_used.value,
            originally_selected=result.mechanism_selection.mechanism.value,
        )
        return result

    async def _execute_mechanism(
        self,
        task: str,
        selection: MechanismSelection,
    ) -> DeliberationResult:
        """Execute selected mechanism with fallback/switch handling."""

        if selection.mechanism == MechanismType.DEBATE:
            debate_outcome = await self.debate_engine.run(task=task, selection=selection)
            if debate_outcome.switch_to_vote:
                vote_outcome = await self.vote_engine.run(task=task, selection=selection)
                switched = vote_outcome.result.model_copy(
                    update={"mechanism_switches": vote_outcome.result.mechanism_switches + 1}
                )
                return switched
            if debate_outcome.result is not None:
                return debate_outcome.result
            raise RuntimeError("Debate engine produced no result")

        if selection.mechanism == MechanismType.VOTE:
            vote_outcome = await self.vote_engine.run(task=task, selection=selection)
            if vote_outcome.switch_to_debate:
                debate_outcome = await self.debate_engine.run(task=task, selection=selection)
                if debate_outcome.result is not None:
                    switched = debate_outcome.result.model_copy(
                        update={
                            "mechanism_switches": debate_outcome.result.mechanism_switches + 1,
                            "timestamp": datetime.now(UTC),
                        }
                    )
                    return switched
            return vote_outcome.result

        # Week 1 supports debate and vote only. Route extension mechanisms safely.
        fallback_selection = selection.model_copy(update={"mechanism": MechanismType.DEBATE})
        debate_outcome = await self.debate_engine.run(task=task, selection=fallback_selection)
        if debate_outcome.result is not None:
            return debate_outcome.result
        vote_outcome = await self.vote_engine.run(task=task, selection=fallback_selection)
        return vote_outcome.result

    async def submit_result(
        self,
        result: DeliberationResult,
        receipt: dict[str, Any] | None = None,
    ) -> SettlementRecord:
        """Submit a completed runtime result through the configured Solana bridge."""

        if self.solana_client is None:
            raise RuntimeError("No Solana client configured for result submission")

        receipt_payload = receipt or self.hasher.build_receipt(
            hashes=result.transcript_hashes,
            mechanism=result.mechanism_used,
            final_answer=result.final_answer,
            quorum_reached=result.quorum_reached,
            round_count=result.round_count,
            mechanism_switches=result.mechanism_switches,
        )
        chain_receipt = self.build_chain_receipt(result=result, receipt=receipt_payload)
        receipt_tx_signature = await self.solana_client.submit_receipt(chain_receipt)

        mechanism_switch_tx_signature: str | None = None
        selected_mechanism = result.mechanism_selection.mechanism.value
        final_mechanism = result.mechanism_used.value
        if selected_mechanism != final_mechanism:
            mechanism_switch_tx_signature = await self.solana_client.record_mechanism_switch(
                task_id=chain_receipt.task_id,
                from_mechanism=selected_mechanism,
                to_mechanism=final_mechanism,
            )

        status = await self.solana_client.get_task_status(chain_receipt.task_id)
        return SettlementRecord(
            task_id=chain_receipt.task_id,
            decision_hash=chain_receipt.decision_hash,
            receipt_tx_signature=receipt_tx_signature,
            mechanism_switch_tx_signature=mechanism_switch_tx_signature,
            status=str(status.get("status", "submitted")),
        )

    @staticmethod
    def build_chain_receipt(
        result: DeliberationResult,
        receipt: dict[str, Any],
    ) -> SolanaReceipt:
        """Map a runtime result and receipt payload into the stable bridge contract."""

        task_id = build_task_id(result.task)
        decision_hash = build_decision_hash(
            task_id=task_id,
            mechanism=result.mechanism_used.value,
            merkle_root=str(receipt["merkle_root"]),
            final_answer_hash=str(receipt["final_answer_hash"]),
            round_count=result.round_count,
            mechanism_switches=result.mechanism_switches,
        )
        selector_reasoning_hash = result.mechanism_selection.reasoning_hash

        # Canonical receipt serialization matters because chain, API, and runtime
        # must agree on identifiers without hidden transforms.
        _ = json.dumps(
            {
                "task_id": task_id,
                "decision_hash": decision_hash,
                "selector_reasoning_hash": selector_reasoning_hash,
            },
            sort_keys=True,
            separators=(",", ":"),
        )

        return SolanaReceipt(
            task_id=task_id,
            decision_hash=decision_hash,
            mechanism=result.mechanism_used.value,
            merkle_root=str(receipt["merkle_root"]),
            final_answer_hash=str(receipt["final_answer_hash"]),
            quorum_reached=bool(receipt["quorum_reached"]),
            round_count=result.round_count,
            mechanism_switches=result.mechanism_switches,
            selector_reasoning_hash=selector_reasoning_hash,
        )
