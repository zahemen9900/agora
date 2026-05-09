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
from agora.tools.runtime import ToolPolicyConfig, _build_decision_prompt
from agora.types import MechanismType
from agora.tools.types import SourceRef
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
    assert "If two mechanisms seem plausible, choose the one whose failure mode is less costly" in system
    assert "Do not use stakes alone as a reason to escalate into debate" in system
    assert "Do not treat delphi as the generic choice for any hard task" in system
    assert "Treat historical performance as one data point about past task distributions" in system
    assert "Example for vote:" in system
    assert "Example for debate:" in system
    assert "Example for delphi:" in system


def test_base_policy_defines_confidence_operationally() -> None:
    prompt = vote_participant_prompt(task="What is the capital of France?")

    assert "Confidence means your probability that a domain expert would mark this answer correct" in prompt.system


def test_vote_prompt_enforces_independent_non_consensus_behavior() -> None:
    prompt = vote_participant_prompt(task="What is the capital of France?")

    assert "Do not coordinate with an imagined majority" in prompt.system
    assert "Do not game the aggregation rule" in prompt.system
    assert "Treat yourself as one independent sample in an ensemble" in prompt.system
    assert "Return your own answer" in prompt.system


def test_delphi_prompts_enforce_evidence_updates_without_social_convergence() -> None:
    independent = delphi_independent_prompt(task="Should a startup prioritize speed or reliability?")
    revision = delphi_revision_prompt(
        task="Should a startup prioritize speed or reliability?",
        prior_answer="Speed",
        peer_feedback=["Reliability prevents expensive outages."],
    )

    assert "Do not anchor on what you think the group will prefer" in independent.system
    assert "Preserve a minority answer when it is still better supported by the evidence" in independent.system
    assert "Treat anonymous peer answers as evidence to evaluate, not a vote to follow" in revision.system
    assert "Revise only when the evidence materially changes your view" in revision.system
    assert "Do not converge just to reduce disagreement" in revision.system
    assert "Keep a dissenting answer when the alternatives are weaker" in revision.system
    assert "This is revision round 2 of 3." in revision.user


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
    assert "Look for mismatches between the confidence of a claim and the evidence actually offered" in devil.system
    assert "Do not reward rhetorical confidence without evidence" in rebuttal.system
    assert "Preserve genuine uncertainty when the critique lands" in rebuttal.system
    assert "Answer the targeted challenge before introducing new supporting claims" in rebuttal.system
    assert "Return JSON" in rebuttal.user
    assert '"answer":' in rebuttal.user
    assert '"defense":' in rebuttal.user
    assert "treat these as established facts you cannot contradict" in rebuttal.user
    assert "Do not average incompatible positions into fake balance" in synthesis.system
    assert "Pick the answer that survives scrutiny, not the answer that sounds most moderate" in synthesis.system
    assert "Carry forward only claims that remained defensible under critique" in synthesis.system
    assert '"key_surviving_claims"' in synthesis.user
    assert '"dropped_claims"' in synthesis.user


def test_tool_decision_prompt_gives_concise_examples_and_pushes_tool_use_for_files_and_exact_checks() -> None:
    prompt = _build_decision_prompt(
        task="Compute the exact SHA256 of the attached file and compare it with a public changelog URL.",
        original_prompt="Find the exact digest and note any mismatch with the changelog.",
        context=type(
            "Ctx",
            (),
            {
                "stage": "vote",
                "agent_id": "agent-1",
                "round_index": 0,
                "sources": [
                    SourceRef(
                        source_id="file-1",
                        kind="code_file",
                        display_name="worker.py",
                        mime_type="text/x-python",
                        storage_uri="file:///tmp/worker.py",
                        size_bytes=12,
                    ),
                    SourceRef(
                        source_id="url-1",
                        kind="url",
                        display_name="example.com/changelog",
                        mime_type="text/html",
                        storage_uri="",
                        source_url="https://example.com/changelog",
                        size_bytes=0,
                    ),
                ],
                "tool_policy": ToolPolicyConfig(),
            },
        )(),
    )

    assert "Use a tool whenever the task requires exact computation" in prompt
    assert "If attached files exist, prefer analyze_file or execute_python" in prompt
    assert "sandbox_path=/workspace/input/file-1__worker.py" in prompt
    assert "use the listed sandbox_path values exactly" in prompt
    assert "Sandbox libraries available without pip install: pandas, numpy, polars, duckdb, pyarrow" in prompt
    assert "Use pandas/openpyxl/xlrd/pyxlsb for spreadsheet formats like .xlsx/.xls/.xlsb" in prompt
    assert "Use pyarrow/polars/duckdb/pandas for parquet or structured tabular data" in prompt
    assert "Use csv only for plain-text CSV/TSV, not for binary spreadsheets" in prompt
    assert "Do not write pip install commands" in prompt
    assert "Example execute_python" in prompt
    assert "Example analyze_urls" in prompt
    assert "Example search_online" in prompt
    assert "Example analyze_file" in prompt
