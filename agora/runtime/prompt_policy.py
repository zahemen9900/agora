"""Centralized prompt policy for selection and deliberation roles."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from agora.types import MechanismType, TaskFeatures


@dataclass(frozen=True)
class PromptBundle:
    """System and user prompt pair for one runtime role."""

    system: str
    user: str


_BASE_POLICY = (
    "You are operating inside Agora, a multi-model deliberation system. "
    "Stay in your assigned role. Preserve useful disagreement instead of converging early. "
    "Calibrate confidence to the actual strength of evidence: be willing to express uncertainty, "
    "and do not inflate certainty to sound persuasive. "
    "When structured output is requested, obey the requested schema exactly and do not add prose. "
    "Think when the task needs it, answer directly when it does not. "
    "Final content should stay concise, auditable, and easy to compare across runs."
)


def selector_prompt(
    *,
    task_text: str,
    features: TaskFeatures,
    bandit_mechanism: MechanismType,
    bandit_confidence: float,
    historical_payload: dict[str, Any],
) -> PromptBundle:
    """Build selector prompts with centralized routing policy."""

    system = (
        f"{_BASE_POLICY} "
        "Your role is selector. Decide how the group should deliberate, "
        "not how to answer the task. "
        "Available mechanisms: debate for adversarial exploration, "
        "vote for independent aggregation. "
        "Prefer the mechanism whose failure mode best matches the task."
    )
    user = (
        "Task text:\n"
        f"{task_text}\n\n"
        "Extracted features:\n"
        f"{json.dumps(features.model_dump(mode='json'), indent=2)}\n\n"
        "Bandit recommendation:\n"
        f"- mechanism: {bandit_mechanism.value}\n"
        f"- confidence: {bandit_confidence:.4f}\n\n"
        "Historical performance:\n"
        f"{json.dumps(historical_payload, indent=2)}\n\n"
        "Respond with a JSON object in this exact schema:\n"
        '{"mechanism": "debate"|"vote", "confidence": 0.0-1.0, "reasoning": "..."}'
    )
    return PromptBundle(system=system, user=user)


def vote_participant_prompt(*, task: str) -> PromptBundle:
    """Build vote participant prompts."""

    system = (
        f"{_BASE_POLICY} "
        "Your role is vote participant. Work independently and avoid mirroring "
        "what you expect other models to say unless the evidence truly points there. "
        "Return your own answer, calibrated "
        "confidence, your forecast of the group's likely answer, and a short rationale."
    )
    user = (
        f"Task: {task}\n"
        "Return JSON with fields: answer, confidence (0-1), predicted_group_answer, reasoning."
    )
    return PromptBundle(system=system, user=user)


def debate_initial_prompt(*, task: str) -> PromptBundle:
    """Build initial-answer prompts for counted debate participants."""

    system = (
        f"{_BASE_POLICY} "
        "Your role is debate initial answer. Produce your own best answer before seeing faction "
        "coordination. Concise first-pass reasoning is better than overexplaining."
    )
    return PromptBundle(system=system, user=task)


def debate_opening_prompt(*, task: str, faction_answer: str) -> PromptBundle:
    """Build opening-statement prompts."""

    system = (
        f"{_BASE_POLICY} "
        "Your role is debate opening. Argue for the assigned faction answer "
        "with the strongest evidence you can justify. "
        "Do not hedge toward compromise."
    )
    user = (
        f"Task: {task}\n"
        f"Assigned faction answer: {faction_answer}\n"
        "Respond as {claim, evidence, confidence}."
    )
    return PromptBundle(system=system, user=user)


def debate_devil_prompt(
    *,
    task: str,
    round_number: int,
    pro_outputs: list[str],
    opp_outputs: list[str],
) -> PromptBundle:
    """Build devil's-advocate prompts."""

    system = (
        f"{_BASE_POLICY} "
        "Your role is devil's advocate. Attack both factions symmetrically. "
        "Find the weakest claim, "
        "state the flaw, and ask the sharpest question that would stress-test it."
    )
    user = (
        f"Task: {task}\n"
        f"Round: {round_number}\n"
        f"Pro statements: {pro_outputs}\n"
        f"Opp statements: {opp_outputs}\n"
        "Respond as {'analyses': [{'faction': 'pro'|'opp', 'weakest_claim': str, 'flaw': str, "
        "'question': str}]}"
    )
    return PromptBundle(system=system, user=user)


def debate_rebuttal_prompt(
    *,
    task: str,
    faction_answer: str,
    targeted_prompt: str,
    locked_claims: list[str],
) -> PromptBundle:
    """Build rebuttal prompts."""

    system = (
        f"{_BASE_POLICY} "
        "Your role is debate rebuttal. Defend your faction answer directly "
        "against the targeted critique. "
        "Respect locked claims and do not relitigate them."
    )
    user = (
        f"Task: {task}\n"
        f"Faction answer: {faction_answer}\n"
        f"Targeted challenge: {targeted_prompt}\n"
        f"Locked claims: {locked_claims}"
    )
    return PromptBundle(system=system, user=user)


def debate_synthesis_prompt(
    *,
    task: str,
    winning_side: str,
    winning_answer: str,
    transcript: list[str],
) -> PromptBundle:
    """Build synthesis prompts."""

    system = (
        f"{_BASE_POLICY} "
        "Your role is debate synthesis. Read the trajectory, choose the strongest "
        "surviving answer, "
        "and produce a final answer that is concise enough for benchmark comparison and audit logs."
    )
    user = (
        f"Task: {task}\n"
        f"Winning faction: {winning_side}\n"
        f"Winning answer candidate: {winning_answer}\n"
        f"Faction transcript: {transcript}"
    )
    return PromptBundle(system=system, user=user)
