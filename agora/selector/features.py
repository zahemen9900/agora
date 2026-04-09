"""Task feature extraction for mechanism selection."""

from __future__ import annotations

import re

from agora.types import TaskFeatures

_NESTED_CLAUSE_HINTS = (
    "however",
    "although",
    "given that",
    "whereas",
    "despite",
    "assuming",
    "provided that",
)

_TOPIC_KEYWORDS: dict[str, tuple[str, ...]] = {
    "math": (
        "calculate",
        "equation",
        "solve",
        "integral",
        "derivative",
        "proof",
        "theorem",
    ),
    "code": (
        "function",
        "implement",
        "debug",
        "code",
        "algorithm",
        "python",
        "javascript",
        "class",
        "api",
    ),
    "reasoning": (
        "why",
        "explain",
        "analyze",
        "compare",
        "evaluate",
        "argue",
        "debate",
    ),
    "factual": (
        "what is",
        "who is",
        "when did",
        "define",
        "list",
        "name",
    ),
    "creative": (
        "write",
        "story",
        "poem",
        "design",
        "imagine",
        "create",
        "brainstorm",
    ),
}

_EXPECTED_DISAGREEMENT = {
    "math": 0.2,
    "code": 0.4,
    "factual": 0.15,
    "reasoning": 0.7,
    "creative": 0.9,
}

_ANSWER_SPACE_SIZE = {
    "math": 2,
    "factual": 3,
    "code": 6,
    "reasoning": 10,
    "creative": 50,
}


def _normalize_stakes(stakes: float) -> float:
    """Clamp stakes into the 0.0-1.0 range."""

    return max(0.0, min(1.0, stakes))


def _detect_topic_category(task_text: str) -> str:
    """Classify topic by static keyword matching."""

    lowered = task_text.lower()

    # Priority order follows the prompt specification.
    for category in ("math", "code", "reasoning", "factual", "creative"):
        if any(keyword in lowered for keyword in _TOPIC_KEYWORDS[category]):
            return category
    return "reasoning"


async def extract_features(
    task_text: str, agent_count: int = 3, stakes: float = 0.5
) -> TaskFeatures:
    """Extract routing features from a raw task prompt.

    Args:
        task_text: Task/question to route.
        agent_count: Number of participating agents.
        stakes: Normalized task stake level.

    Returns:
        TaskFeatures: Structured feature vector for mechanism selection.
    """

    token_count = len(task_text.split())
    punctuation_indicators = task_text.count("?") + task_text.count(";")

    clause_indicators = punctuation_indicators
    lowered = task_text.lower()
    for hint in _NESTED_CLAUSE_HINTS:
        clause_indicators += len(re.findall(rf"\b{re.escape(hint)}\b", lowered))

    complexity_score = min(1.0, ((token_count / 200.0) * 0.4) + ((clause_indicators / 5.0) * 0.6))

    topic_category = _detect_topic_category(task_text)
    expected_disagreement = _EXPECTED_DISAGREEMENT[topic_category]
    answer_space_size = _ANSWER_SPACE_SIZE[topic_category]

    return TaskFeatures(
        task_text=task_text,
        complexity_score=complexity_score,
        topic_category=topic_category,
        expected_disagreement=expected_disagreement,
        answer_space_size=answer_space_size,
        time_sensitivity=0.5,
        agent_count=max(1, agent_count),
        stakes=_normalize_stakes(stakes),
    )
