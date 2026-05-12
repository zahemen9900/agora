import { Callout } from "../../components/Callout";
import { Steps, Step } from "../../components/Steps";

export function ProofOfDeliberation() {
    return (
        <div>
            <p
                className="font-mono text-[11px] uppercase tracking-[0.1em] mb-3"
                style={{ color: "var(--accent-emerald)" }}
            >
                Research
            </p>

            <h1
                className="text-3xl md:text-4xl font-mono font-bold mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Proof of Deliberation
            </h1>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <strong style={{ color: "var(--text-primary)" }}>
                    Proof of Deliberation (PoD)
                </strong>{" "}
                is Agora's cryptographic audit trail for every AI reasoning
                session. Every artifact produced during a deliberation — agent
                arguments, votes, confidence scores, mechanism-selection
                justifications, and mid-execution switch decisions — is SHA-256
                hashed, assembled into a Merkle tree, and the root is committed
                to Solana via the Anchor contract. Anyone can download the raw
                transcript and independently recompute the root to verify that
                nothing was altered after the fact.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Unlike traditional AI audit logs — which are plain text files
                controlled by the provider — PoD anchors integrity to an
                immutable, public ledger. The on-chain record is not the
                transcript itself (which lives in Google Cloud Storage), but the
                tamper-evident commitment to it. Separation of storage and
                integrity is deliberate: transcripts can be large; Merkle roots
                are always 32 bytes.
            </p>

            {/* ── The Problem ────────────────────────────────────────────────── */}
            <h2
                id="the-problem"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                The Problem: Trust in AI Governance
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Multi-agent systems designed for high-stakes decisions —
                contract arbitration, DAO governance, medical triage
                prioritization — require more than a correct final answer.
                Stakeholders need to verify <em>how</em> the answer was reached:
                which agents participated, what positions they took, whether a
                mechanism switch occurred mid-session, and what the final
                consensus threshold was. Without a verifiable record, the output
                is just another opaque model response.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Existing approaches fall into two camps, both insufficient:
            </p>

            <ul
                className="list-disc list-inside text-sm leading-relaxed mb-6 space-y-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Provider-held logs
                    </strong>{" "}
                    — mutable, access-controlled, and trust-requiring. The
                    provider can retroactively edit or delete records.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        On-chain full transcripts
                    </strong>{" "}
                    — prohibitively expensive at current Solana rent costs for
                    multi-round debates with five or more agents.
                </li>
            </ul>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                PoD resolves this by storing the <em>commitment</em> on-chain
                (cheap) and the <em>transcript</em> off-chain (scalable), while
                making the off-chain data verifiable against the on-chain root.
            </p>

            <Callout type="info" title="Design constraint">
                The Merkle root committed on-chain is exactly 32 bytes
                regardless of whether the deliberation involved 2 agents or 20
                agents across 10 rounds. Storage cost is constant.
            </Callout>

            {/* ── Merkle-Rooted Verification ──────────────────────────────────── */}
            <h2
                id="merkle-verification"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Merkle-Rooted Verification
            </h2>

            <p
                className="text-sm leading-relaxed mb-6"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The verification pipeline runs in five steps, each producing a
                value that feeds into the next. Steps 1–3 happen off-chain; step
                4 is on-chain; step 5 is the verification check.
            </p>

            <Steps>
                <Step number={1} title="Hash every artifact">
                    <p
                        className="text-sm leading-relaxed mb-3"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        Every discrete output produced during a deliberation is
                        individually hashed with SHA-256. The artifact set
                        depends on the mechanism:
                    </p>
                    <ul
                        className="list-disc list-inside text-sm leading-relaxed space-y-1"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        <li>
                            Mechanism-selector chain-of-thought (
                            <code
                                className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                                style={{
                                    background: "var(--bg-subtle)",
                                    color: "var(--accent-emerald)",
                                }}
                            >
                                selector_reasoning_hash
                            </code>
                            )
                        </li>
                        <li>
                            Each agent argument per round (Factional Debate,
                            Delphi)
                        </li>
                        <li>Each agent vote + confidence score (ISP Voting)</li>
                        <li>
                            Each mechanism switch decision (
                            <code
                                className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                                style={{
                                    background: "var(--bg-subtle)",
                                    color: "var(--accent-emerald)",
                                }}
                            >
                                switch_reason_hash
                            </code>
                            )
                        </li>
                        <li>The final aggregated decision</li>
                    </ul>
                </Step>

                <Step number={2} title="Construct the Merkle tree">
                    <p
                        className="text-sm leading-relaxed"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        All individual hashes become the leaf nodes of a binary
                        Merkle tree. Parent nodes are computed as{" "}
                        <code
                            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                            style={{
                                background: "var(--bg-subtle)",
                                color: "var(--accent-emerald)",
                            }}
                        >
                            SHA-256(left_child || right_child)
                        </code>
                        . Agora uses SHA-256 throughout for consistency with
                        on-chain verification tooling. The tree is balanced; if
                        the leaf count is odd, the last leaf is duplicated.
                    </p>
                </Step>

                <Step number={3} title="Store transcript off-chain">
                    <p
                        className="text-sm leading-relaxed"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        The full structured transcript (JSON — all agent
                        messages, timestamps, round metadata) is uploaded to
                        Google Cloud Storage. The GCS URI is included in the
                        task receipt returned to the caller. Anyone can fetch
                        this URI to obtain the raw data needed to recompute
                        hashes.
                    </p>
                </Step>

                <Step number={4} title="Commit root on-chain">
                    <p
                        className="text-sm leading-relaxed"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        The Merkle root (32 bytes) and the final decision hash
                        are written to the{" "}
                        <code
                            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                            style={{
                                background: "var(--bg-subtle)",
                                color: "var(--accent-emerald)",
                            }}
                        >
                            TaskAccount
                        </code>{" "}
                        PDA via the{" "}
                        <code
                            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                            style={{
                                background: "var(--bg-subtle)",
                                color: "var(--accent-emerald)",
                            }}
                        >
                            submit_receipt
                        </code>{" "}
                        instruction. The Solana transaction hash becomes the
                        globally addressable proof identifier. Finalization is
                        confirmed within one slot (~400 ms on Solana mainnet).
                    </p>
                </Step>

                <Step number={5} title="Verify independently">
                    <p
                        className="text-sm leading-relaxed"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        Any third party can download the GCS transcript,
                        recompute every leaf hash, rebuild the Merkle tree, and
                        compare the resulting root against the value stored in
                        the{" "}
                        <code
                            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                            style={{
                                background: "var(--bg-subtle)",
                                color: "var(--accent-emerald)",
                            }}
                        >
                            TaskAccount
                        </code>
                        . A match proves the transcript is unmodified. A
                        mismatch proves tampering occurred. See the{" "}
                        <strong style={{ color: "var(--text-primary)" }}>
                            Merkle Verification
                        </strong>{" "}
                        page for the exact Python snippet.
                    </p>
                </Step>
            </Steps>

            {/* ── Novel Contribution ──────────────────────────────────────────── */}
            <h2
                id="novel-contribution"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                The Novel Contribution:{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    record_mechanism_switch
                </code>
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Existing on-chain AI audit systems record what decision was made
                and (sometimes) which agents participated. No existing system
                records{" "}
                <em>
                    whether the deliberation methodology changed mid-execution
                </em>{" "}
                — and why. This is a significant blind spot: if an orchestrator
                silently upgrades from a cheap Vote to a full Debate without
                leaving a trace, the audit trail misrepresents the actual
                computational process.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Agora's{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    record_mechanism_switch
                </code>{" "}
                instruction is called by the mid-execution state monitor
                whenever it determines that switching mechanisms is warranted.
                It writes to the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    TaskAccount
                </code>{" "}
                on-chain:
            </p>

            <ul
                className="list-disc list-inside text-sm leading-relaxed mb-6 space-y-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    The{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        MechanismType::Hybrid
                    </code>{" "}
                    variant, encoding both the original and the replacement
                    mechanism
                </li>
                <li>
                    A{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        switch_reason_hash
                    </code>{" "}
                    — SHA-256 of the monitor's JSON rationale (the specific
                    entropy and information-gain values that triggered the
                    switch)
                </li>
                <li>
                    An incremented{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        mechanism_switches
                    </code>{" "}
                    counter so auditors know how many transitions occurred in a
                    single task lifetime
                </li>
            </ul>

            <Callout type="tip" title="Auditability implication">
                A task completed with <code>mechanism_switches = 2</code> tells
                an auditor that the orchestrator changed strategy twice. They
                can fetch the GCS transcript, find the two switch rationale
                records, recompute their hashes, and verify each against the
                corresponding on-chain <code>switch_reason_hash</code>. Full
                accountability without storing the rationale text on-chain.
            </Callout>

            {/* ── Verification Flow ───────────────────────────────────────────── */}
            <h2
                id="verification-flow"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Verification Flow
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The following diagram shows data flow from task execution to
                independent verification:
            </p>

            <pre
                className="font-mono text-[11px] leading-relaxed p-5 overflow-x-auto rounded-lg border border-[var(--border-default)] my-5"
                style={{
                    background: "var(--bg-subtle)",
                    color: "var(--text-secondary)",
                    whiteSpace: "pre",
                }}
            >{`
  EXECUTION                         STORAGE                        VERIFICATION
  ─────────                         ───────                        ────────────

  Agent outputs                     GCS Bucket                     Third Party
  + selector CoT       ──SHA256──►  (full transcript)   ◄─fetch─   downloads
  + switch rationales  ──SHA256──►  JSON record          recompute  transcript
  + votes + scores     ──SHA256──►                       hashes     rebuilds
                                                                     Merkle tree
          │                                                              │
          ▼                                                              ▼
  Merkle leaves                                                  Computed root
  → Merkle tree                                                       │
  → root (32 bytes)                                                   │ compare
          │                                                              │
          ▼                                                              ▼
  submit_receipt             on-chain TaskAccount            ✓ Match → verified
  instruction       ──────►  transcript_merkle_root  ──────►  ✗ Mismatch → alert
                              decision_hash
                              mechanism_switches
`}</pre>

            {/* ── References ──────────────────────────────────────────────────── */}
            <h2
                id="references"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                References
            </h2>

            <ul
                className="list-disc list-inside text-sm leading-relaxed space-y-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    Li et al.,{" "}
                    <em>
                        "Debate or Vote? Benchmarking Multi-Agent Deliberation
                        Mechanisms for LLM Reasoning"
                    </em>
                    , NeurIPS 2025 Spotlight — establishes conformity bias in
                    naive debate and motivates structured deliberation with
                    verifiable process records.
                </li>
                <li>
                    Merkle, R. C.,{" "}
                    <em>
                        "A Digital Signature Based on a Conventional Encryption
                        Function"
                    </em>
                    , CRYPTO 1987 — the original hash tree construction used as
                    the cryptographic backbone of PoD.
                </li>
                <li>
                    Solana Anchor Framework —{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        https://www.anchor-lang.com/
                    </code>{" "}
                    — provides the PDA account model and instruction dispatch
                    used by Agora's settlement layer.
                </li>
            </ul>
        </div>
    );
}
