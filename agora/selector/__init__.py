"""Selector package containing feature extraction and mechanism routing logic."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agora.selector.bandit import ThompsonSamplingSelector
    from agora.selector.features import extract_features
    from agora.selector.reasoning import ReasoningSelector
    from agora.selector.selector import AgoraSelector

__all__ = [
    "AgoraSelector",
    "ReasoningSelector",
    "ThompsonSamplingSelector",
    "extract_features",
]


def __getattr__(name: str) -> object:
    """Resolve public selector exports lazily to avoid package import cycles."""

    if name == "AgoraSelector":
        from agora.selector.selector import AgoraSelector

        return AgoraSelector
    if name == "ReasoningSelector":
        from agora.selector.reasoning import ReasoningSelector

        return ReasoningSelector
    if name == "ThompsonSamplingSelector":
        from agora.selector.bandit import ThompsonSamplingSelector

        return ThompsonSamplingSelector
    if name == "extract_features":
        from agora.selector.features import extract_features

        return extract_features
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
