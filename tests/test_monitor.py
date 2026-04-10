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

    assert StateMonitor.extract_answer_signal(output) == "option a"


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
