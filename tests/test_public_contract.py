"""Tests for the public SDK/runtime surface contract."""

from __future__ import annotations

import agora.engines as engines
import agora.solana as solana


def test_public_engine_exports_include_supported_mechanisms_only() -> None:
    assert engines.__all__ == ["debate", "vote", "delphi"]


def test_public_solana_exports_hide_internal_stub_client() -> None:
    assert solana.__all__ == []
