"""Tests for transcript hashing and Merkle receipt generation."""

from __future__ import annotations

from agora.runtime.hasher import TranscriptHasher
from agora.types import MechanismType
from tests.helpers import make_agent_output


def test_hash_content_is_deterministic() -> None:
    """Same content should always produce the same hash."""

    hasher = TranscriptHasher()
    first = hasher.hash_content("hello world")
    second = hasher.hash_content("hello world")

    assert first == second


def test_hash_agent_output_changes_with_content() -> None:
    """Distinct content should produce distinct output hashes."""

    hasher = TranscriptHasher()
    a = make_agent_output("a1", "claim one")
    b = make_agent_output("a1", "claim two")

    assert hasher.hash_agent_output(a) != hasher.hash_agent_output(b)


def test_build_merkle_tree_known_two_leaf_root() -> None:
    """Two-leaf root should match sha256(left_hash + right_hash)."""

    hasher = TranscriptHasher()
    h1 = hasher.hash_content("a")
    h2 = hasher.hash_content("b")

    root = hasher.build_merkle_tree([h1, h2])
    expected = hasher.hash_content(h1 + h2)

    assert root == expected


def test_build_receipt_has_required_fields() -> None:
    """Receipt payload should include all required metadata fields."""

    hasher = TranscriptHasher()
    hashes = [hasher.hash_content("x"), hasher.hash_content("y")]

    receipt = hasher.build_receipt(
        hashes=hashes,
        mechanism=MechanismType.VOTE,
        final_answer="Paris",
        quorum_reached=True,
        round_count=1,
        mechanism_switches=0,
    )

    assert receipt["leaf_count"] == 2
    assert receipt["mechanism"] == "vote"
    assert receipt["quorum_reached"] is True
    assert "merkle_root" in receipt
    assert "final_answer_hash" in receipt
    assert "timestamp" in receipt
