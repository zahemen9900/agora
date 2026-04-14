"""Deterministic transcript hashing and Merkle receipt generation."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

import structlog

from agora.types import AgentOutput, MechanismType

logger = structlog.get_logger(__name__)

try:
    from merkletools import MerkleTools
except ImportError:  # pragma: no cover
    MerkleTools = None  # type: ignore[assignment]


class TranscriptHasher:
    """Build deterministic hashes and Merkle roots for deliberation artifacts."""

    @staticmethod
    def hash_content(content: str) -> str:
        """Compute SHA-256 hash for a content string.

        Args:
            content: Input content.

        Returns:
            str: Hex digest.
        """

        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    @staticmethod
    def hash_agent_output(output: AgentOutput) -> str:
        """Create deterministic hash of selected agent output fields.

        Args:
            output: Agent output record.

        Returns:
            str: SHA-256 hex digest.
        """

        canonical_payload: dict[str, Any] = {
            "agent_id": output.agent_id,
            "content": output.content,
            "round_number": output.round_number,
            "role": output.role,
        }
        serialized = json.dumps(canonical_payload, sort_keys=True, separators=(",", ":"))
        return TranscriptHasher.hash_content(serialized)

    def build_merkle_tree(self, hashes: list[str]) -> str:
        """Build Merkle tree root from pre-hashed leaves.

        Args:
            hashes: Hex-encoded leaf hashes.

        Returns:
            str: Merkle root hex digest.
        """

        if not hashes:
            return self.hash_content("")

        if MerkleTools is not None:
            merkle = MerkleTools(hash_type="SHA256")
            merkle.add_leaf(hashes, do_hash=False)
            merkle.make_tree()
            root = merkle.get_merkle_root()
            if isinstance(root, str) and root:
                return root

        # Fallback deterministic Merkle implementation.
        layer = hashes[:]
        while len(layer) > 1:
            next_layer: list[str] = []
            for idx in range(0, len(layer), 2):
                left = layer[idx]
                right = layer[idx + 1] if idx + 1 < len(layer) else left
                combined = self.hash_content(left + right)
                next_layer.append(combined)
            layer = next_layer
        return layer[0]

    def build_receipt(
        self,
        hashes: list[str],
        mechanism: MechanismType,
        final_answer: str,
        quorum_reached: bool,
        round_count: int,
        mechanism_switches: int,
    ) -> dict[str, Any]:
        """Build a complete receipt payload for chain submission.

        Args:
            hashes: Transcript leaf hashes.
            mechanism: Execution mechanism.
            final_answer: Final answer content.
            quorum_reached: Whether quorum threshold was met.
            round_count: Number of rounds executed.
            mechanism_switches: Number of mid-execution switches.

        Returns:
            dict[str, Any]: Receipt dictionary.
        """

        merkle_root = self.build_merkle_tree(hashes)
        receipt = {
            "merkle_root": merkle_root,
            "leaf_count": len(hashes),
            "mechanism": mechanism.value,
            "final_answer_hash": self.hash_content(final_answer),
            "quorum_reached": quorum_reached,
            "round_count": round_count,
            "mechanism_switches": mechanism_switches,
            "timestamp": datetime.now(UTC).isoformat(),
        }
        logger.info(
            "transcript_receipt_built",
            mechanism=mechanism.value,
            leaf_count=receipt["leaf_count"],
            round_count=round_count,
            mechanism_switches=mechanism_switches,
        )
        return receipt
