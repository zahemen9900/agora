import { CodeBlock } from "../../components/CodeBlock";
import { Callout } from "../../components/Callout";

const basicCode = `import asyncio
from typing import TypedDict
from langgraph.graph import StateGraph, END
from agora.sdk import AgoraNode

# 1. Define your graph state
class ResearchState(TypedDict):
    query: str
    task: str          # AgoraNode reads this key
    agora_result: dict | None
    summary: str

# 2. Instantiate AgoraNode (auto-selects mechanism)
agora_node = AgoraNode(
    api_url="https://agora-api-dcro4pg6ca-uc.a.run.app",
    agent_count=5,
)

# 3. Build your graph
def prepare_task(state: ResearchState) -> ResearchState:
    """Transform the user query into an Agora task string."""
    return {**state, "task": f"Evaluate this research question: {state['query']}"}

def summarise(state: ResearchState) -> ResearchState:
    """Post-process the Agora result into a short summary."""
    result = state["agora_result"]
    summary = (
        f"[{result['mechanism_used'].upper()} | "
        f"confidence {result['confidence']:.0%}] "
        f"{result['final_answer']}"
    )
    return {**state, "summary": summary}

builder = StateGraph(ResearchState)
builder.add_node("prepare",    prepare_task)
builder.add_node("deliberate", agora_node)
builder.add_node("summarise",  summarise)

builder.set_entry_point("prepare")
builder.add_edge("prepare",    "deliberate")
builder.add_edge("deliberate", "summarise")
builder.add_edge("summarise",  END)

graph = builder.compile()

# 4. Run it
async def main():
    result = await graph.ainvoke({
        "query": "Is retrieval-augmented generation still necessary with 1M-token context windows?",
        "task": "",
        "agora_result": None,
        "summary": "",
    })
    print(result["summary"])

asyncio.run(main())`;

const conditionalCode = `from langgraph.graph import StateGraph, END
from agora.sdk import AgoraNode
from typing import TypedDict, Literal

class DecisionState(TypedDict):
    task: str
    agora_result: dict | None
    route: str

agora_node = AgoraNode(
    api_url="https://agora-api-dcro4pg6ca-uc.a.run.app",
    agent_count=3,
)

def route_by_confidence(
    state: DecisionState,
) -> Literal["high_confidence", "low_confidence", "human_review"]:
    result = state["agora_result"]

    # Flag for human review if the mechanism had to switch mid-run
    if result["mechanism_switches"] > 0:
        return "human_review"

    # Route based on confidence threshold
    if result["confidence"] >= 0.85:
        return "high_confidence"
    else:
        return "low_confidence"

def accept_answer(state: DecisionState) -> DecisionState:
    print("Auto-accepted:", state["agora_result"]["final_answer"])
    return {**state, "route": "accepted"}

def escalate(state: DecisionState) -> DecisionState:
    print("Low confidence — requesting more context.")
    return {**state, "route": "escalated"}

def flag_for_human(state: DecisionState) -> DecisionState:
    print("Mechanism switched mid-run — flagging for human review.")
    return {**state, "route": "human_review"}

builder = StateGraph(DecisionState)
builder.add_node("deliberate",     agora_node)
builder.add_node("high_confidence", accept_answer)
builder.add_node("low_confidence",  escalate)
builder.add_node("human_review",    flag_for_human)

builder.set_entry_point("deliberate")
builder.add_conditional_edges(
    "deliberate",
    route_by_confidence,
    {
        "high_confidence": "high_confidence",
        "low_confidence":  "low_confidence",
        "human_review":    "human_review",
    },
)
builder.add_edge("high_confidence", END)
builder.add_edge("low_confidence",  END)
builder.add_edge("human_review",    END)

graph = builder.compile()`;

const forcedMechanismCode = `from agora.sdk import AgoraNode

# Force debate for adversarial reasoning tasks
debate_node = AgoraNode(
    api_url="https://agora-api-dcro4pg6ca-uc.a.run.app",
    mechanism="debate",
    agent_count=5,
)

# Force ISP vote for factual aggregation tasks
vote_node = AgoraNode(
    api_url="https://agora-api-dcro4pg6ca-uc.a.run.app",
    mechanism="vote",
    agent_count=7,
)

# Force Delphi for open-ended or value-laden tasks
delphi_node = AgoraNode(
    api_url="https://agora-api-dcro4pg6ca-uc.a.run.app",
    mechanism="delphi",
    agent_count=5,
)

# Use them as regular LangGraph nodes:
# builder.add_node("adversarial_check", debate_node)
# builder.add_node("fact_check",        vote_node)
# builder.add_node("ethical_review",    delphi_node)`;

const customKeysCode = `# If your graph already uses different state keys,
# override the defaults so you don't need to rename fields.
from agora.sdk import AgoraNode

node = AgoraNode(
    api_url="https://agora-api-dcro4pg6ca-uc.a.run.app",
    input_key="user_query",     # read from state["user_query"]
    output_key="deliberation",  # write to state["deliberation"]
)`;

export function LangGraphIntegration() {
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
                LangGraph Integration
            </h1>

            <p
                className="text-base leading-relaxed mb-6"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <IC>AgoraNode</IC> is a first-class LangGraph node that
                integrates Agora's deliberation pipeline directly into a{" "}
                <IC>StateGraph</IC>. It reads the task from a configurable state
                key, runs the full Agora pipeline (including on-chain receipt
                commitment), and writes the result dict back into state.
                Requires <IC>pip install "agora-sdk[langgraph]"</IC>.
            </p>

            {/* ── Basic Integration ─────────────────────────────────────────── */}
            <h2
                id="basic-integration"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Basic Integration
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The example below shows a three-node graph: a preparation node
                that formats the user query into a task string, the{" "}
                <IC>AgoraNode</IC> deliberation step, and a post-processing node
                that formats the result. This is the recommended pattern — keep
                Agora responsible for the deliberation, and handle prompt
                engineering and output formatting in separate nodes.
            </p>

            <CodeBlock code={basicCode} language="python" />

            {/* ── Conditional Routing ───────────────────────────────────────── */}
            <h2
                id="conditional-routing"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Conditional Routing
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Use <IC>add_conditional_edges</IC> to route downstream based on
                the deliberation outcome. The most useful routing signals are{" "}
                <IC>confidence</IC> (0.0–1.0) and
                <IC>mechanism_switches</IC> (int). The example below routes to{" "}
                <IC>human_review</IC> when the mechanism had to switch
                mid-execution — a reliable indicator that the task was ambiguous
                or unusually complex.
            </p>

            <CodeBlock code={conditionalCode} language="python" />

            <Callout
                type="tip"
                title="Use mechanism_switches as a complexity signal"
            >
                A non-zero <IC>mechanism_switches</IC> value means the mechanism
                selector determined mid-execution that the originally chosen
                mechanism was unlikely to converge. This is a reliable heuristic
                for identifying decisions that warrant human review — the agent
                system itself is signalling uncertainty about its own process,
                not just its answer.
            </Callout>

            {/* ── Force a Specific Mechanism ────────────────────────────────── */}
            <h2
                id="force-mechanism"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Force a Specific Mechanism
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                If you know in advance which mechanism is appropriate — for
                example, all tasks routed to a particular node are adversarial
                trade-off questions — pass <IC>mechanism</IC>
                directly to the node constructor. This skips the mechanism
                selection step and reduces latency by one LLM call.
            </p>

            <CodeBlock code={forcedMechanismCode} language="python" />

            {/* ── Custom State Keys ─────────────────────────────────────────── */}
            <h2
                id="custom-state-keys"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Custom State Keys
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                By default, <IC>AgoraNode</IC> reads from <IC>state["task"]</IC>{" "}
                and writes to <IC>state["agora_result"]</IC>. If your graph uses
                different key names, override them with <IC>input_key</IC> and{" "}
                <IC>output_key</IC>:
            </p>

            <CodeBlock code={customKeysCode} language="python" />
        </div>
    );
}
