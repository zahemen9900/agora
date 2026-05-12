import { CodeBlock } from "../components/CodeBlock";
import { Callout } from "../components/Callout";
import { Steps, Step } from "../components/Steps";
import { LinkCard } from "../components/LinkCard";

const installCode = `pip install agora-sdk`;

const arbitrateCode = `import asyncio
from agora.sdk import AgoraArbitrator

async def main():
    arbitrator = AgoraArbitrator(
        api_url="https://agora-api-dcro4pg6ca-uc.a.run.app"
    )

    result = await arbitrator.arbitrate(
        "Should a startup with 3 engineers use microservices or a monolith?"
    )

    print(f"Mechanism: {result.mechanism_used}")     # "debate", "vote", or "delphi"
    print(f"Answer:    {result.final_answer}")
    print(f"Confidence:{result.confidence:.2f}")
    print(f"Merkle Root: {result.merkle_root}")      # on-chain proof
    print(f"Quorum:    {result.quorum_reached}")

asyncio.run(main())`;

const verifyCode = `verification = await arbitrator.verify_receipt(result)
print(verification)
# {
#   "valid": True,
#   "merkle_match": True,
#   "on_chain_match": True,
#   "solana_tx_hash": "5KkD...pQr9"
# }`;

const exampleOutput = `Mechanism:   debate
Answer:      A monolith is strongly recommended for a 3-engineer startup.
             Microservices introduce operational overhead — distributed tracing,
             independent deployments, network latency — that only pays off at
             scale. Ship fast, extract services when the seams are clear.
Confidence:  0.91
Merkle Root: 7f3a9c2b1e4d8f6a0c5b3e9d2f1a7c4b8e0d6f3a1c9b5e7d...
Quorum:      True`;

export function Quickstart() {
    return (
        <div>
            <p
                className="font-mono text-[11px] uppercase tracking-[0.1em] mb-3"
                style={{ color: "var(--accent-emerald)" }}
            >
                Getting Started
            </p>

            <h1
                className="text-3xl md:text-4xl font-mono font-bold mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Quickstart
            </h1>

            <p
                className="text-base leading-relaxed mb-6"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Run your first Agora deliberation in under five minutes. You'll
                install the SDK, submit a task, and get back a cryptographically
                verifiable answer with a Solana receipt — all in fewer than 20
                lines of Python.
            </p>

            <Callout type="info" title="Prerequisites">
                Python 3.11 or higher is required. The SDK has no other required
                system dependencies — Solana wallet configuration is optional
                and only needed if you want to use staked arbitration.
            </Callout>

            {/* ── Steps ─────────────────────────────────────────────────────── */}
            <Steps>
                {/* Step 1 */}
                <Step number={1} title="Install the SDK">
                    <CodeBlock code={installCode} language="bash" />
                    <p
                        className="text-sm leading-relaxed mb-0"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        This installs{" "}
                        <code
                            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                            style={{
                                background: "var(--bg-subtle)",
                                color: "var(--accent-emerald)",
                            }}
                        >
                            agora-sdk
                        </code>{" "}
                        and its core dependencies:{" "}
                        <code
                            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                            style={{
                                background: "var(--bg-subtle)",
                                color: "var(--accent-emerald)",
                            }}
                        >
                            httpx
                        </code>
                        ,{" "}
                        <code
                            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                            style={{
                                background: "var(--bg-subtle)",
                                color: "var(--accent-emerald)",
                            }}
                        >
                            solders
                        </code>
                        , and{" "}
                        <code
                            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                            style={{
                                background: "var(--bg-subtle)",
                                color: "var(--accent-emerald)",
                            }}
                        >
                            pydantic
                        </code>
                        . For LangGraph or CrewAI extras, see the{" "}
                        <a
                            href="/docs/installation"
                            style={{ color: "var(--accent-emerald)" }}
                        >
                            Installation
                        </a>{" "}
                        page.
                    </p>
                </Step>

                {/* Step 2 */}
                <Step number={2} title="Run your first arbitration">
                    <CodeBlock code={arbitrateCode} language="python" />
                    <p
                        className="text-sm leading-relaxed mb-3"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        Save this as{" "}
                        <code
                            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                            style={{
                                background: "var(--bg-subtle)",
                                color: "var(--accent-emerald)",
                            }}
                        >
                            main.py
                        </code>{" "}
                        and run it with{" "}
                        <code
                            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                            style={{
                                background: "var(--bg-subtle)",
                                color: "var(--accent-emerald)",
                            }}
                        >
                            python main.py
                        </code>
                        . Agora automatically selects the best deliberation
                        mechanism for your task. You should see output similar
                        to:
                    </p>
                    <CodeBlock
                        code={exampleOutput}
                        language="text"
                        filename="output"
                    />
                </Step>

                {/* Step 3 */}
                <Step number={3} title="Verify the on-chain receipt">
                    <CodeBlock code={verifyCode} language="python" />
                    <p
                        className="text-sm leading-relaxed mb-0"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        <code
                            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                            style={{
                                background: "var(--bg-subtle)",
                                color: "var(--accent-emerald)",
                            }}
                        >
                            verify_receipt
                        </code>{" "}
                        reconstructs the Merkle tree from the deliberation
                        transcript, computes the root locally, and checks it
                        against the value anchored on Solana. If all three flags
                        are{" "}
                        <code
                            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                            style={{
                                background: "var(--bg-subtle)",
                                color: "var(--accent-emerald)",
                            }}
                        >
                            True
                        </code>
                        , the result is tamper-proof.
                    </p>
                </Step>
            </Steps>

            {/* ── What just happened ────────────────────────────────────────── */}
            <h2
                id="what-just-happened"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                What just happened?
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Behind that single{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    arbitrate()
                </code>{" "}
                call, Agora ran the following pipeline:
            </p>

            <ol
                className="text-sm leading-relaxed mb-6 space-y-3 pl-5 list-decimal"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Task embedding and classification.
                    </strong>{" "}
                    Your question was embedded and compared against the
                    mechanism selector's task taxonomy. "Monolith vs.
                    microservices" was classified as a complex technical
                    reasoning task.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Mechanism selection (Thompson Sampling).
                    </strong>{" "}
                    The bandit sampled from its Beta posteriors for each
                    mechanism and selected <em>debate</em> — the mechanism
                    historically most reliable for multi-factor engineering
                    trade-off questions.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Factional debate with Devil's Advocate.
                    </strong>{" "}
                    Three agents were assigned factions (pro-monolith,
                    pro-microservices, neutral) before seeing each other's
                    outputs. A Devil's Advocate agent then cross-examined the
                    leading position, probing for weaknesses. Adaptive
                    termination fired when convergence exceeded the quorum
                    threshold.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Merkle receipt construction.
                    </strong>{" "}
                    Every agent output and cross-examination was serialised,
                    SHA-256 hashed, and assembled into a Merkle tree. The root
                    was submitted to Solana's devnet via the Agora Anchor
                    program.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Result returned.
                    </strong>{" "}
                    The SDK assembled the{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        DeliberationResult
                    </code>{" "}
                    object with the synthesised answer, confidence score,
                    mechanism metadata, Merkle root, and Solana transaction
                    hash.
                </li>
            </ol>

            <Callout type="tip" title="Inspect the full transcript">
                Add{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    print(result.transcript)
                </code>{" "}
                to see every agent output, cross-examination round, and
                convergence signal in the deliberation. The transcript is the
                raw input to the Merkle tree — each entry maps to a leaf node.
            </Callout>

            {/* ── Next Steps ────────────────────────────────────────────────── */}
            <h2
                id="next-steps"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Next Steps
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                <LinkCard
                    title="Core Concepts"
                    description="Understand mechanisms, the bandit selector, and Proof of Deliberation."
                    href="/docs/concepts"
                />
                <LinkCard
                    title="Python SDK Reference"
                    description="Full API for AgoraArbitrator, AgoraNode, and all result types."
                    href="/docs/sdk/python"
                />
                <LinkCard
                    title="LangGraph Integration"
                    description="Drop AgoraNode into a StateGraph as a deliberation step."
                    href="/docs/sdk/langgraph"
                />
                <LinkCard
                    title="Installation"
                    description="Virtual env setup, optional extras, and environment variables."
                    href="/docs/installation"
                />
            </div>
        </div>
    );
}
