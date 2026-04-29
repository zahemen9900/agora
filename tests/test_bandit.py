"""Tests for Thompson sampling selector."""

from __future__ import annotations

import numpy as np

from agora.selector.bandit import ThompsonSamplingSelector
from agora.types import MechanismType
from tests.helpers import make_features


def test_uniform_priors_produce_balanced_selection() -> None:
    """Uniform priors should produce roughly balanced exploration."""

    np.random.seed(42)
    selector = ThompsonSamplingSelector(
        mechanisms=[MechanismType.DEBATE, MechanismType.VOTE, MechanismType.DELPHI]
    )
    features = make_features(topic_category="reasoning")

    selections = [selector.select(features)[0] for _ in range(100)]
    debate_count = sum(1 for mechanism in selections if mechanism == MechanismType.DEBATE)
    vote_count = sum(1 for mechanism in selections if mechanism == MechanismType.VOTE)
    delphi_count = sum(1 for mechanism in selections if mechanism == MechanismType.DELPHI)

    assert 15 <= debate_count <= 50
    assert 15 <= vote_count <= 50
    assert 15 <= delphi_count <= 50


def test_updates_bias_toward_successful_mechanism() -> None:
    """Strong rewards for one arm should shift selection mass to that arm."""

    np.random.seed(7)
    selector = ThompsonSamplingSelector(
        mechanisms=[MechanismType.DEBATE, MechanismType.VOTE, MechanismType.DELPHI]
    )
    features = make_features(topic_category="reasoning")

    for _ in range(20):
        selector.update(MechanismType.DEBATE, "reasoning", reward=1.0)
        selector.update(MechanismType.VOTE, "reasoning", reward=0.0)
        selector.update(MechanismType.DELPHI, "reasoning", reward=0.0)

    selections = [selector.select(features)[0] for _ in range(100)]
    debate_rate = sum(1 for mechanism in selections if mechanism == MechanismType.DEBATE) / 100

    assert debate_rate > 0.8


def test_bandit_state_save_load_roundtrip(tmp_path) -> None:
    """State persistence should preserve arm parameters exactly."""

    state_path = tmp_path / "bandit_state.json"
    selector = ThompsonSamplingSelector(
        mechanisms=[MechanismType.DEBATE, MechanismType.VOTE, MechanismType.DELPHI]
    )
    selector.update(MechanismType.DEBATE, "math", reward=1.0)
    selector.update(MechanismType.VOTE, "code", reward=0.25)
    selector.update(MechanismType.DELPHI, "creative", reward=0.75)
    selector.save_state(str(state_path))

    restored = ThompsonSamplingSelector(
        mechanisms=[MechanismType.DEBATE, MechanismType.VOTE, MechanismType.DELPHI]
    )
    restored.load_state(str(state_path))

    assert restored.get_stats() == selector.get_stats()
