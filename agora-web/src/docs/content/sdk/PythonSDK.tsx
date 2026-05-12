import { CodeBlock } from "../../components/CodeBlock";
import { Callout } from "../../components/Callout";
import { ParamTable } from "../../components/ParamTable";

const constructorCode = `from agora.sdk import AgoraArbitrator

arbitrator = AgoraArbitrator(
    api_url="https://agora-api-dcro4pg6ca-uc.a.run.app",
    mechanism=None,       # auto-select (default)
    agent_count=3,        # 3, 5, or 7
    solana_wallet=None,   # required for staked arbitration
)`;

const arbitrateCode = `result = await arbitrator.arbitrate(
    task="Should we adopt TypeScript across the entire codebase?",
    stakes=0.0,  # SOL to escrow; 0.0 for free deliberation
)

# Result fields:
print(result.task_id)          # "task_01hx..."
print(result.mechanism_used)   # "debate" | "vote" | "delphi"
print(result.final_answer)     # Full synthesised answer string
print(result.confidence)       # 0.0 – 1.0
print(result.quorum_reached)   # True if convergence threshold met
print(result.mechanism_switches)  # int: how many mid-run switches occurred
print(result.merkle_root)      # "7f3a9c2b..."
print(result.solana_tx_hash)   # "5KkDp..."  (None if off-chain mode)
print(result.transcript)       # List[TranscriptEntry]
print(result.duration_ms)      # int: wall-clock time in milliseconds`;

const verifyCode = `verification = await arbitrator.verify_receipt(result)
# Returns:
# {
#   "valid": True,
#   "merkle_match": True,     # local root matches result.merkle_root
#   "on_chain_match": True,   # result.merkle_root matches Solana account
#   "solana_tx_hash": "5KkD..."
# }

# Or pass a task_id string directly:
verification = await arbitrator.verify_receipt("task_01hx...")`;

const streamCode = `async for event in arbitrator.stream("task_01hx..."):
    print(event.type, event.data)
    # mechanism_selected  {"mechanism": "debate", "reason": "..."}
    # agent_output        {"agent_id": "a1", "faction": "pro", "output": "..."}
    # cross_examination   {"examiner": "devil_advocate", "target": "pro", "output": "..."}
    # convergence_update  {"confidence": 0.87, "quorum": False}
    # mechanism_switch    {"from": "debate", "to": "vote", "reason": "..."}
    # quorum_reached      {"mechanism": "debate", "confidence": 0.91}
    # receipt_committed   {"merkle_root": "7f3a...", "solana_tx_hash": "5KkD..."}`;

const nodeCode = `from agora.sdk import AgoraNode
from langgraph.graph import StateGraph
from typing import TypedDict

class State(TypedDict):
    task: str
    agora_result: dict | None

# AgoraNode reads state["task"] and writes state["agora_result"]
node = AgoraNode(
    api_url="https://agora-api-dcro4pg6ca-uc.a.run.app",
    mechanism=None,   # auto-select
    agent_count=5,
)

builder = StateGraph(State)
builder.add_node("deliberate", node)
builder.set_entry_point("deliberate")
builder.set_finish_point("deliberate")
graph = builder.compile()

result = await graph.ainvoke({"task": "Is Rust ready for ML workloads?", "agora_result": None})
print(result["agora_result"]["final_answer"])`;

const transcriptEntryCode = `# TranscriptEntry fields (each maps to one Merkle leaf)
entry.step          # "faction_output" | "cross_examination" | "convergence" | ...
entry.agent_id      # "agent_0" | "devil_advocate" | "synthesiser"
entry.content       # str: the raw agent output
entry.confidence    # float: agent's self-reported confidence
entry.timestamp     # ISO-8601 string
entry.hash          # SHA-256 hash of the serialised entry (the Merkle leaf)`;

export function PythonSDK() {
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
                Python SDK
            </h1>

            <p
                className="text-base leading-relaxed mb-6"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The <IC>agora-sdk</IC> package exposes two primary interfaces:{" "}
                <IC>AgoraArbitrator</IC> for direct async usage in any Python
                application, and <IC>AgoraNode</IC> for drop-in integration into
                LangGraph <IC>StateGraph</IC> pipelines. Both share the same
                underlying HTTP client and return the same{" "}
                <IC>DeliberationResult</IC> type.
            </p>

            {/* ── AgoraArbitrator ───────────────────────────────────────────── */}
            <h2
                id="agora-arbitrator"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                AgoraArbitrator
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The main client class. Instantiate it once and reuse across
                multiple calls — it manages an internal{" "}
                <IC>httpx.AsyncClient</IC> connection pool.
            </p>

            <CodeBlock code={constructorCode} language="python" />

            <h3
                id="arbitrator-constructor"
                className="text-lg font-mono font-semibold mt-8 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                Constructor parameters
            </h3>

            <ParamTable
                params={[
                    {
                        name: "api_url",
                        type: "str",
                        required: true,
                        description: "URL of the Agora API endpoint.",
                    },
                    {
                        name: "solana_wallet",
                        type: "str | None",
                        required: false,
                        default: "None",
                        description:
                            "Base58-encoded Solana wallet address. Required for staked arbitration (stakes > 0). Agora uses this to escrow and release SOL.",
                    },
                    {
                        name: "mechanism",
                        type: "str | None",
                        required: false,
                        default: "None",
                        description:
                            'Force a specific mechanism: "debate", "vote", or "delphi". Pass None (default) to let the mechanism selector choose automatically.',
                    },
                    {
                        name: "agent_count",
                        type: "int",
                        required: false,
                        default: "3",
                        description:
                            "Number of agents to use. Must be 3, 5, or 7. Higher counts increase deliberation quality at the cost of latency.",
                    },
                ]}
            />

            {/* arbitrate() */}
            <h3
                id="arbitrate"
                className="text-lg font-mono font-semibold mt-8 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                arbitrate()
            </h3>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The primary method. Submits a task, runs the full deliberation
                pipeline, and returns when the mechanism reaches quorum or
                exhausts its round budget. This is an <IC>async</IC> method —
                use <IC>await</IC>.
            </p>

            <ParamTable
                params={[
                    {
                        name: "task",
                        type: "str",
                        required: true,
                        description:
                            "The question or decision for deliberation. Any natural language string. More specific tasks generally produce higher-confidence outputs.",
                    },
                    {
                        name: "stakes",
                        type: "float",
                        required: false,
                        default: "0.0",
                        description:
                            "SOL to escrow for this arbitration. When > 0, a solana_wallet must be set on the arbitrator. Escrowed funds are released after the on-chain receipt is committed.",
                    },
                ]}
            />

            <CodeBlock code={arbitrateCode} language="python" />

            {/* DeliberationResult */}
            <h3
                id="deliberation-result"
                className="text-lg font-mono font-semibold mt-8 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                DeliberationResult fields
            </h3>

            <div className="overflow-x-auto my-5 rounded-lg border border-[var(--border-default)]">
                <table className="w-full text-sm border-collapse">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            {["Field", "Type", "Description"].map((h) => (
                                <th
                                    key={h}
                                    className="text-left px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.07em]"
                                    style={{ color: "var(--text-tertiary)" }}
                                >
                                    {h}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {[
                            [
                                "task_id",
                                "str",
                                "Unique task identifier (ULID format).",
                            ],
                            [
                                "mechanism_used",
                                "str",
                                '"debate", "vote", or "delphi" — whichever ran to completion.',
                            ],
                            [
                                "final_answer",
                                "str",
                                "The synthesised answer from the winning faction or aggregated votes.",
                            ],
                            [
                                "confidence",
                                "float",
                                "Aggregate confidence score, 0.0 – 1.0.",
                            ],
                            [
                                "quorum_reached",
                                "bool",
                                "True if the mechanism hit its convergence threshold before exhausting rounds.",
                            ],
                            [
                                "mechanism_switches",
                                "int",
                                "Number of mid-run mechanism switches. 0 in most cases.",
                            ],
                            [
                                "merkle_root",
                                "str",
                                "SHA-256 Merkle root of the full deliberation transcript.",
                            ],
                            [
                                "solana_tx_hash",
                                "str | None",
                                "Solana transaction hash of the on-chain receipt commit. None if off-chain mode.",
                            ],
                            [
                                "transcript",
                                "list[TranscriptEntry]",
                                "Ordered list of all deliberation steps. Each entry is a Merkle leaf.",
                            ],
                            [
                                "duration_ms",
                                "int",
                                "Total wall-clock time for the deliberation in milliseconds.",
                            ],
                        ].map(([field, type, desc]) => (
                            <tr
                                key={field}
                                className="border-t border-[var(--border-default)]"
                                onMouseEnter={(e) => {
                                    (
                                        e.currentTarget as HTMLTableRowElement
                                    ).style.background = "var(--bg-elevated)";
                                }}
                                onMouseLeave={(e) => {
                                    (
                                        e.currentTarget as HTMLTableRowElement
                                    ).style.background = "";
                                }}
                            >
                                <td
                                    className="px-4 py-3 font-mono text-[13px]"
                                    style={{ color: "var(--accent-emerald)" }}
                                >
                                    {field}
                                </td>
                                <td
                                    className="px-4 py-3 font-mono text-[12px]"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {type}
                                </td>
                                <td
                                    className="px-4 py-3 text-[13px]"
                                    style={{
                                        fontFamily:
                                            "'Hanken Grotesk', sans-serif",
                                        color: "var(--text-secondary)",
                                    }}
                                >
                                    {desc}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* TranscriptEntry */}
            <h3
                id="transcript-entry"
                className="text-lg font-mono font-semibold mt-8 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                TranscriptEntry
            </h3>
            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Each element of <IC>result.transcript</IC> is a{" "}
                <IC>TranscriptEntry</IC> — a single deliberation event that maps
                to one Merkle leaf.
            </p>
            <CodeBlock code={transcriptEntryCode} language="python" />

            {/* verify_receipt() */}
            <h3
                id="verify-receipt"
                className="text-lg font-mono font-semibold mt-8 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                verify_receipt()
            </h3>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Reconstructs the Merkle tree from the deliberation transcript,
                recomputes the root locally, and compares it against both the
                value in the result and the value committed on Solana. Accepts
                either a <IC>DeliberationResult</IC> object or a task ID string.
            </p>

            <CodeBlock code={verifyCode} language="python" />

            {/* stream() */}
            <h3
                id="stream"
                className="text-lg font-mono font-semibold mt-8 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                stream()
            </h3>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Returns an async generator that yields SSE events from a running
                or completed task. Useful for displaying live deliberation
                progress in a UI. Each event has a <IC>type</IC> (string) and{" "}
                <IC>data</IC> (parsed dict).
            </p>

            <CodeBlock code={streamCode} language="python" />

            {/* ── AgoraNode ─────────────────────────────────────────────────── */}
            <h2
                id="agora-node"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                AgoraNode
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <IC>AgoraNode</IC> is a callable LangGraph node that wraps{" "}
                <IC>AgoraArbitrator</IC>. It reads the task from{" "}
                <IC>state["task"]</IC> and writes the serialised{" "}
                <IC>DeliberationResult</IC> dict to{" "}
                <IC>state["agora_result"]</IC>. Requires the <IC>langgraph</IC>{" "}
                extra: <IC>pip install "agora-sdk[langgraph]"</IC>.
            </p>

            <CodeBlock code={nodeCode} language="python" />

            <Callout type="info" title="State key configuration">
                The default state keys (<IC>task</IC> and <IC>agora_result</IC>)
                can be overridden by passing <IC>input_key="my_task"</IC> and{" "}
                <IC>output_key="my_result"</IC> to the <IC>AgoraNode</IC>{" "}
                constructor. This lets you integrate Agora into existing graphs
                without renaming your state fields.
            </Callout>
        </div>
    );
}
