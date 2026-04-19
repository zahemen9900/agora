"""Tests for convergence monitoring and answer normalization."""

from __future__ import annotations

from agora.runtime.monitor import StateMonitor
from tests.helpers import make_agent_output


def test_extract_answer_signal_prefers_structured_answer_fields() -> None:
    """Structured debate payloads should normalize to the defended answer."""

    output = make_agent_output(
        "agent-1",
        '{"answer":"Different phrasing","defense":"long defense","faction_answer":"Option A"}',
        role="pro_rebuttal",
    )

    assert StateMonitor.extract_answer_signal(output) == "different phrasing"


def test_current_answer_movement_beats_static_assignment() -> None:
    """Changing current answers must register even when faction assignments are fixed."""

    monitor = StateMonitor()
    first = [
        make_agent_output(
            "agent-1",
            '{"assigned_answer":"Option A","current_answer":"Option A","confidence":0.8}',
            role="pro_rebuttal",
        ),
        make_agent_output(
            "agent-2",
            '{"assigned_answer":"Option B","current_answer":"Option B","confidence":0.8}',
            role="opp_rebuttal",
        ),
    ]
    second = [
        make_agent_output(
            "agent-1",
            '{"assigned_answer":"Option A","current_answer":"Option B","confidence":0.8}',
            role="pro_rebuttal",
        ),
        make_agent_output(
            "agent-2",
            '{"assigned_answer":"Option B","current_answer":"Option B","confidence":0.8}',
            role="opp_rebuttal",
        ),
    ]

    monitor.compute_metrics(first)
    moved = monitor.compute_metrics(second)

    assert moved.js_divergence > 0.0
    assert moved.answer_churn > 0.0
    assert moved.information_gain_delta == moved.js_divergence


def test_stable_answer_distribution_plateaus() -> None:
    """Identical answer distributions should produce zero movement."""

    monitor = StateMonitor()
    outputs = [
        make_agent_output("agent-1", '{"current_answer":"Option A"}', role="pro_rebuttal"),
        make_agent_output("agent-2", '{"current_answer":"Option B"}', role="opp_rebuttal"),
    ]

    monitor.compute_metrics(outputs)
    plateau = monitor.compute_metrics(outputs)

    assert plateau.js_divergence == 0.0
    assert plateau.answer_churn == 0.0
    assert plateau.entropy_delta == 0.0


def test_confidence_weighted_entropy_handles_extreme_confidence() -> None:
    """Zero and one confidence weights should not produce invalid entropy."""

    monitor = StateMonitor()
    outputs = [
        make_agent_output("agent-1", '{"current_answer":"Option A"}', confidence=0.0),
        make_agent_output("agent-2", '{"current_answer":"Option B"}', confidence=1.0),
    ]

    metrics = monitor.compute_metrics(outputs)

    assert metrics.disagreement_entropy >= 0.0
    assert metrics.dominant_answer_share <= 1.0


def test_compute_metrics_uses_normalized_answer_signal() -> None:
    """Convergence metrics should ignore changing defense text when answers match."""

    monitor = StateMonitor()
    outputs = [
        make_agent_output(
            "agent-1",
            '{"faction_answer":"Option A","defense":"first rationale"}',
            role="pro_rebuttal",
        ),
        make_agent_output(
            "agent-2",
            '{"faction_answer":"Option A","defense":"second rationale"}',
            role="pro_rebuttal",
        ),
    ]

    metrics = monitor.compute_metrics(outputs)

    assert metrics.unique_answers == 1
    assert metrics.dominant_answer_share == 1.0
    assert metrics.disagreement_entropy == 0.0
