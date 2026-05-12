import { CodeBlock } from "../../components/CodeBlock";
import { Callout } from "../../components/Callout";

const installCode = `pip install "agora-sdk[crewai]"
# or install both separately:
pip install agora-sdk crewai`;

const fullExampleCode = `import asyncio
from agora.sdk.crewai import AgoraCrewAITool
from crewai import Agent, Task, Crew

# 1. Instantiate the Agora tool
agora_tool = AgoraCrewAITool(
    api_url="https://agora-api-b4auawqzbq-uc.a.run.app",
    mechanism=None,   # auto-select (recommended)
    agent_count=5,
)

# 2. Create a CrewAI agent that has access to the tool
decision_analyst = Agent(
    role="Senior Decision Analyst",
    goal=(
        "Evaluate complex technical and strategic decisions using "
        "structured multi-agent deliberation."
    ),
    backstory=(
        "You are an expert analyst with access to Agora, an on-chain "
        "multi-agent deliberation system. When facing a significant "
        "decision, you call the Agora tool to run a structured debate, "
        "vote, or Delphi consensus among specialised AI agents."
    ),
    tools=[agora_tool],
    verbose=True,
)

# 3. Define the task
analysis_task = Task(
    description=(
        "Analyse whether our SaaS product should move from a monthly "
        "subscription model to usage-based pricing. Consider engineering "
        "complexity, customer psychology, revenue predictability, and "
        "competitive positioning. Use the Agora deliberation tool to "
        "get a structured multi-agent verdict."
    ),
    expected_output=(
        "A recommendation with the deliberation mechanism used, "
        "confidence score, Merkle root for audit, and a 2-3 sentence "
        "summary of the winning argument."
    ),
    agent=decision_analyst,
)

# 4. Run the crew
crew = Crew(
    agents=[decision_analyst],
    tasks=[analysis_task],
    verbose=True,
)

result = crew.kickoff()
print(result)`;

const toolInputOutputCode = `# The tool receives a plain string input from the CrewAI agent.
# It calls Agora's arbitrate() and returns a JSON string.

# Input (what the agent passes to the tool):
# "Should we adopt event sourcing for our order management system?"

# Output (what the tool returns to the agent, as a JSON string):
# {
#   "mechanism_used": "debate",
#   "final_answer": "Event sourcing is recommended for order management...",
#   "confidence": 0.88,
#   "quorum_reached": true,
#   "mechanism_switches": 0,
#   "merkle_root": "7f3a9c2b1e4d8f6a...",
#   "solana_tx_hash": "5KkDpQr9...",
#   "duration_ms": 14320
# }`;

const multiAgentCrewCode = `from agora.sdk.crewai import AgoraCrewAITool
from crewai import Agent, Task, Crew

agora_tool = AgoraCrewAITool(
    api_url="https://agora-api-b4auawqzbq-uc.a.run.app",
    agent_count=7,  # Higher count for more critical decisions
)

# Only the orchestrator agent gets the Agora tool.
# Researcher and writer agents work with its output.
orchestrator = Agent(
    role="AI Deliberation Orchestrator",
    goal="Run structured multi-agent deliberations for high-stakes decisions.",
    backstory="You orchestrate AI deliberation using the Agora platform.",
    tools=[agora_tool],
    verbose=True,
)

researcher = Agent(
    role="Research Analyst",
    goal="Synthesise the deliberation output into an executive briefing.",
    backstory="You distil complex AI reasoning into clear business insights.",
    tools=[],
    verbose=True,
)

deliberation_task = Task(
    description="Use Agora to deliberate: Should we expand to APAC in Q3?",
    expected_output="Raw Agora JSON result with mechanism, answer, and merkle_root.",
    agent=orchestrator,
)

synthesis_task = Task(
    description=(
        "Read the Agora deliberation result from the previous task. "
        "Write a 200-word executive briefing with the recommendation, "
        "confidence level, and key arguments."
    ),
    expected_output="200-word executive briefing.",
    agent=researcher,
    context=[deliberation_task],
)

crew = Crew(
    agents=[orchestrator, researcher],
    tasks=[deliberation_task, synthesis_task],
    verbose=True,
)

result = crew.kickoff()
print(result)`;

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
                <IC>AgoraCrewAITool</IC> wraps the Agora deliberation pipeline
                as a native CrewAI tool. Any agent in your crew can call it by
                passing a plain string task — the tool handles the full Agora
                pipeline (mechanism selection, deliberation, on-chain receipt)
                and returns a structured JSON string the agent can reason about.
            </p>

            <Callout type="info" title="CrewAI compatibility">
                Requires <IC>crewai</IC> v0.28 or higher. Install both packages
                together: <IC>pip install "agora-sdk[crewai]"</IC>. The tool is
                compatible with both synchronous <IC>crew.kickoff()</IC> and
                async <IC>await crew.kickoff_async()</IC>.
            </Callout>

            {/* ── Installation ──────────────────────────────────────────────── */}
            <h2
                id="installation"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Installation
            </h2>

            <CodeBlock code={installCode} language="bash" />

            {/* ── Full Working Example ──────────────────────────────────────── */}
            <h2
                id="full-example"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Full Working Example
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The example below creates a single-agent crew with access to the
                Agora tool. The agent decides when to call it based on its task
                description. This is the simplest integration pattern — let the
                agent decide when deliberation is needed.
            </p>

            <CodeBlock code={fullExampleCode} language="python" />

            {/* ── Tool Input/Output ─────────────────────────────────────────── */}
            <h2
                id="tool-input-output"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Tool Input and Output
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The tool follows CrewAI's standard tool contract: it receives a
                plain string from the agent and returns a plain string
                (JSON-encoded). The agent can reference any field in the
                returned JSON in its reasoning and in subsequent task outputs.
            </p>

            <CodeBlock
                code={toolInputOutputCode}
                language="python"
                filename="tool I/O contract"
            />

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The <IC>merkle_root</IC> and <IC>solana_tx_hash</IC> fields in
                the output are particularly useful for audit trails — instruct
                your agent to include them in its final output so you have a
                verifiable reference for every deliberation the crew ran.
            </p>

            {/* ── Multi-Agent Crew ──────────────────────────────────────────── */}
            <h2
                id="multi-agent-crew"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Multi-Agent Crew Pattern
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                In larger crews, it's good practice to give the Agora tool only
                to a designated orchestrator agent. Downstream agents receive
                the deliberation output as context and synthesise it into final
                deliverables. This separates concerns and prevents multiple
                agents from triggering redundant Agora calls on the same
                question.
            </p>

            <CodeBlock code={multiAgentCrewCode} language="python" />

            <Callout
                type="tip"
                title="Pass merkle_root in task expected_output"
            >
                Explicitly require <IC>merkle_root</IC> and{" "}
                <IC>solana_tx_hash</IC> in your task's <IC>expected_output</IC>{" "}
                description. This ensures CrewAI's output parser preserves these
                fields, giving you an auditable link between each crew run and
                its on-chain Proof of Deliberation receipt.
            </Callout>
        </div>
    );
}
