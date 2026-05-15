import { CodeBlock } from "../../components/CodeBlock";
import { Callout } from "../../components/Callout";

const installCode = `pip install agora-arbitrator-sdk crewai`;

const precomputeCode = `import asyncio
from agora.sdk import AgoraArbitrator
from crewai import Agent, Task, Crew


async def deliberate() -> dict:
    async with AgoraArbitrator(auth_token="agora_live_xxxxx.yyyyy") as arbitrator:
        result = await arbitrator.arbitrate(
            "Should we move our SaaS product from subscription pricing to usage-based pricing?"
        )
        return result.model_dump(mode="json")


agora_result = asyncio.run(deliberate())

decision_analyst = Agent(
    role="Senior Decision Analyst",
    goal="Turn Agora deliberation output into an executive recommendation.",
    backstory=(
        "You interpret structured multi-agent results faithfully instead of "
        "inventing a new answer from scratch."
    ),
    verbose=True,
)

analysis_task = Task(
    description=(
        "Read the provided Agora deliberation result and write a recommendation "
        "for leadership. Preserve the mechanism, confidence, and cited evidence."
    ),
    expected_output=(
        "A recommendation that includes mechanism, confidence score, "
        "Merkle root, and the winning argument."
    ),
    agent=decision_analyst,
    context=[str(agora_result)],
)

crew = Crew(
    agents=[decision_analyst],
    tasks=[analysis_task],
    verbose=True,
)

print(crew.kickoff())`;

const wrapperCode = `# If you want tool-style access inside CrewAI,
# wrap AgoraArbitrator yourself and return JSON.
import asyncio
from agora.sdk import AgoraArbitrator


class AgoraDeliberationWrapper:
    def __init__(self, auth_token: str) -> None:
        self.auth_token = auth_token

    def run(self, question: str) -> str:
        async def _inner() -> str:
            async with AgoraArbitrator(auth_token=self.auth_token) as arbitrator:
                result = await arbitrator.arbitrate(question)
                return result.model_dump_json(indent=2)

        return asyncio.run(_inner())`;

const multiAgentCode = `# Pattern: one step generates the Agora result, later crew steps consume it.
from crewai import Agent, Task, Crew

orchestrator = Agent(
    role="Decision Synthesizer",
    goal="Interpret Agora deliberation output faithfully.",
    backstory="You summarise what Agora found; you do not replace it.",
    verbose=True,
)

researcher = Agent(
    role="Research Analyst",
    goal="Turn the deliberation result into an executive briefing.",
    backstory="You distil the structured output into a shorter business memo.",
    verbose=True,
)

deliberation_task = Task(
    description="Read the Agora result and state the recommendation clearly.",
    expected_output="Short synthesis with mechanism, confidence, and merkle_root.",
    agent=orchestrator,
)

synthesis_task = Task(
    description=(
        "Read the Agora-backed recommendation from the previous task and write "
        "a 200-word executive summary."
    ),
    expected_output="200-word executive summary.",
    agent=researcher,
    context=[deliberation_task],
)

crew = Crew(
    agents=[orchestrator, researcher],
    tasks=[deliberation_task, synthesis_task],
    verbose=True,
)`;

export function CrewAIIntegration() {
    const IC = ({ children }: { children: string }) => (
        <code
            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
            style={{
                background: "var(--bg-subtle)",
                color: "var(--accent-emerald)",
            }}
        >
            {children}
        </code>
    );

    return (
        <div>
            <p
                className="font-mono text-[11px] uppercase tracking-[0.1em] mb-3"
                style={{ color: "var(--accent-emerald)" }}
            >
                SDK Reference
            </p>

            <h1
                className="text-3xl md:text-4xl font-mono font-bold mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                CrewAI Integration
            </h1>

            <p
                className="text-base leading-relaxed mb-6"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The current SDK does{" "}
                <strong style={{ color: "var(--text-primary)" }}>not</strong>{" "}
                ship a first-party <IC>agora.sdk.crewai</IC> adapter. The
                reliable pattern today is to call <IC>AgoraArbitrator</IC>{" "}
                directly, then feed the resulting JSON into your CrewAI workflow
                as structured context or behind a thin wrapper you own.
            </p>

            <Callout type="warning" title="No bundled CrewAI tool class">
                References to <IC>AgoraCrewAITool</IC> or{" "}
                <IC>from agora.sdk.crewai import ...</IC> are stale. Install{" "}
                <IC>crewai</IC> separately and integrate through the public SDK
                client instead.
            </Callout>

            {/* ── Installation ─────────────────────────────────────────────── */}
            <h2
                id="installation"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Installation
            </h2>

            <CodeBlock code={installCode} language="bash" />

            {/* ── Deliberate-first pattern ──────────────────────────────────── */}
            <h2
                id="precompute-pattern"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Deliberate-first pattern
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The simplest robust approach is two-stage orchestration: run
                Agora first, then pass the structured result into your CrewAI
                tasks. This keeps deliberation logic inside Agora while letting
                the crew handle synthesis, formatting, or downstream business
                workflow.
            </p>

            <CodeBlock code={precomputeCode} language="python" />

            {/* ── Custom tool wrapper ───────────────────────────────────────── */}
            <h2
                id="tool-style-wrapper"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Custom tool wrapper
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                If you want tool-style access inside CrewAI, wrap{" "}
                <IC>AgoraArbitrator</IC> yourself and return JSON. Keep that
                wrapper thin and version-local to your application instead of
                depending on a nonexistent bundled adapter.
            </p>

            <CodeBlock code={wrapperCode} language="python" />

            {/* ── Multi-agent Crew pattern ──────────────────────────────────── */}
            <h2
                id="multi-agent-flow"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Multi-agent Crew pattern
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                One clean pattern is to let one crew step consume Agora output
                and let later steps transform it into a memo, report, or
                downstream action plan.
            </p>

            <CodeBlock code={multiAgentCode} language="python" />

            <Callout type="tip" title="What to preserve from Agora">
                Carry <IC>mechanism</IC>, <IC>confidence</IC>,{" "}
                <IC>merkle_root</IC>, <IC>tool_usage_summary</IC>, and relevant
                citations into the CrewAI output. That keeps the downstream crew
                grounded in the actual deliberation instead of re-inventing the
                decision.
            </Callout>
        </div>
    );
}
