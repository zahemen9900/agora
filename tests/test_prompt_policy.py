from __future__ import annotations

from agora.runtime.prompt_policy import (
    debate_devil_prompt,
    debate_initial_prompt,
    debate_opening_prompt,
    debate_rebuttal_prompt,
    debate_synthesis_prompt,
    delphi_independent_prompt,
    delphi_revision_prompt,
    selector_prompt,
    vote_participant_prompt,
)
from agora.types import MechanismType
from tests.helpers import make_features


def test_selector_prompt_describes_when_each_mechanism_should_and_should_not_be_used() -> None:
    prompt = selector_prompt(
        task_text="Design a procurement policy for a public university AI lab.",
        features=make_features("reasoning"),
        bandit_mechanism=MechanismType.VOTE,
        bandit_confidence=0.62,
        historical_payload={"reasoning": {"vote": {"wins": 3}}},
    )

    system = prompt.system

    assert "Do not choose a mechanism by habit" in system
    assert "Do not simply echo the bandit recommendation" in system
    assert "Choose vote when the task is bounded, objective, and answer-checkable" in system
    assert "Avoid vote when the main challenge is surfacing hidden assumptions" in system
    assert "Choose debate when the task benefits from adversarial pressure" in system
    assert "Avoid debate when the task is a straightforward factual or arithmetic check" in system
    assert "Choose delphi when the task is open-ended, multi-criteria, or subjective" in system
    assert "Avoid delphi when the task should be resolved in one independent pass" in system
    assert "Example for vote:" in system
    assert "Example for debate:" in system
    assert "Example for delphi:" in system


def test_vote_prompt_enforces_independent_non_consensus_behavior() -> None:
    prompt = vote_participant_prompt(task="What is the capital of France?")

    assert "Do not coordinate with an imagined majority" in prompt.system
    assert "Do not game the aggregation rule" in prompt.system
    assert "Return your own answer" in prompt.system


def test_delphi_prompts_enforce_evidence_updates_without_social_convergence() -> None:
    independent = delphi_independent_prompt(task="Should a startup prioritize speed or reliability?")
    revision = delphi_revision_prompt(
        task="Should a startup prioritize speed or reliability?",
        prior_answer="Speed",
        peer_feedback=["Reliability prevents expensive outages."],
    )

    assert "Do not anchor on what you think the group will prefer" in independent.system
    assert "Treat anonymous peer answers as evidence to evaluate, not a vote to follow" in revision.system
    assert "Revise only when the evidence materially changes your view" in revision.system
    assert "Do not converge just to reduce disagreement" in revision.system


def test_debate_prompts_enforce_targeted_falsification_and_evidence_sensitive_synthesis() -> None:
    initial = debate_initial_prompt(task="Should a city ban private cars downtown?")
    opening = debate_opening_prompt(
        task="Should a city ban private cars downtown?",
        faction_answer="Ban private cars downtown.",
    )
    devil = debate_devil_prompt(
        task="Should a city ban private cars downtown?",
        round_number=2,
        pro_outputs=["Cars create congestion and pollution."],
        opp_outputs=["Bans hurt workers and delivery logistics."],
    )
    rebuttal = debate_rebuttal_prompt(
        task="Should a city ban private cars downtown?",
        faction_answer="Ban private cars downtown.",
        targeted_prompt="What is the strongest counterexample involving disabled residents?",
        locked_claims=["Traffic injuries declined after prior lane restrictions."],
    )
    synthesis = debate_synthesis_prompt(
        task="Should a city ban private cars downtown?",
        winning_side="pro",
        winning_answer="Ban private cars downtown.",
        transcript=["pro: congestion dropped", "opp: exemptions are needed"],
    )

    assert "Do not pre-compromise before the adversarial phase begins" in initial.system
    assert "Commit to a clear candidate answer" in initial.system
    assert "Defend the assigned answer even if you can imagine respectable objections" in opening.system
    assert "Do not blur the faction boundary by preemptively conceding the other side's case" in opening.system
    assert "Prefer falsifiable, task-specific pressure over generic skepticism" in devil.system
    assert "If one faction is obviously weaker, press harder on the stronger faction's hidden assumptions" in devil.system
    assert "Do not reward rhetorical confidence without evidence" in rebuttal.system
    assert "Preserve genuine uncertainty when the critique lands" in rebuttal.system
    assert "Do not average incompatible positions into fake balance" in synthesis.system
    assert "Pick the answer that survives scrutiny, not the answer that sounds most moderate" in synthesis.system
