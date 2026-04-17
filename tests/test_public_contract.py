"""Tests for the public SDK/runtime surface contract."""

from __future__ import annotations

import agora.engines as engines
import agora.solana as solana


def test_public_engine_exports_hide_future_mechanism_stubs() -> None:
    assert engines.__all__ == ["debate", "vote"]


def test_public_solana_exports_hide_internal_stub_client() -> None:
    assert solana.__all__ == []
