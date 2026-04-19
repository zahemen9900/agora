"""Tests for telemetry truthfulness in pricing and model summaries."""

from __future__ import annotations

from agora.runtime.costing import build_model_telemetry


def test_partial_token_splits_remain_approximate() -> None:
    """A single split token field must not be labeled exact pricing."""

    telemetry = build_model_telemetry(
        models=["gemini-3-flash-preview"],
        model_token_usage={"gemini-3-flash-preview": 3917},
        model_input_tokens={},
        model_output_tokens={},
        model_thinking_tokens={},
    )

    assert telemetry["gemini-3-flash-preview"].estimation_mode == "approx_total_tokens"


def test_complete_token_splits_are_labeled_exact() -> None:
    """Exact pricing is only valid when all split counts are present."""

    telemetry = build_model_telemetry(
        models=["gemini-3-flash-preview"],
        model_token_usage={"gemini-3-flash-preview": 12},
        model_input_tokens={"gemini-3-flash-preview": 4},
        model_output_tokens={"gemini-3-flash-preview": 6},
        model_thinking_tokens={"gemini-3-flash-preview": 2},
    )

    assert telemetry["gemini-3-flash-preview"].estimation_mode == "exact"
