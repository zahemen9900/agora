import { CodeBlock } from "../../components/CodeBlock";
import { Callout } from "../../components/Callout";

const accountStructuresCode = `use anchor_lang::prelude::*;

#[account]
pub struct TaskAccount {
    pub task_id: [u8; 32],
    pub mechanism: MechanismType,
    pub selector_reasoning_hash: [u8; 32],  // Hash of LLM chain-of-thought
    pub transcript_merkle_root: [u8; 32],
    pub decision_hash: [u8; 32],
    pub quorum_reached: bool,
    pub agent_count: u8,
    pub consensus_threshold: u8,            // e.g., 60 = 60%
    pub payment_amount: u64,                // lamports
    pub payer: Pubkey,
    pub mechanism_switches: u8,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum MechanismType {
    Debate,
    Vote,
    Delphi,
    MoA,  // Mixture of Agents
    Hybrid {
        primary: Box<MechanismType>,
        switched_to: Box<MechanismType>,
    },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum TaskStatus {
    Pending,
    Running,
    Completed,
    Failed,
}`;

const architectureDiagram = `┌─────────────────────────────────────────────────────────────────┐
│                     TASK INPUT (from user or SDK)               │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│              META-ORCHESTRATOR (LangGraph root graph)             │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  Thompson Sampling Bandit + LLM Reasoning Agent          │     │
│  │  Input: task features + historical mechanism performance  │     │
│  │  Output: mechanism + confidence + chain-of-thought        │     │
│  │  → CoT hashed and committed on-chain                      │     │
│  └──────────────────────────┬──────────────────────────────┘     │
│                              │                                     │
│         ┌────────────────────┼────────────────────┐               │
│         ▼                    ▼                    ▼               │
│  ┌─────────────┐  ┌──────────────────┐  ┌──────────────┐        │
│  │   DEBATE     │  │      VOTE        │  │   DELPHI /   │        │
│  │   ENGINE     │  │      ENGINE      │  │   MoA        │        │
│  │  (factional  │  │  (ISP-weighted   │  │  (extension) │        │
│  │   adaptive)  │  │   calibrated)    │  │              │        │
│  └──────┬───────┘  └────────┬─────────┘  └──────┬───────┘        │
│         │                   │                    │                │
│         ▼                   ▼                    ▼                │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  MID-EXECUTION STATE MONITOR                             │     │
│  │  Tracks: disagreement_entropy, information_gain_delta    │     │
│  │  Can trigger: mechanism switch, early termination         │     │
│  │  Switches logged on-chain via record_mechanism_switch     │     │
│  └──────────────────────────┬──────────────────────────────┘     │
│                              │                                     │
│                              ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  TRANSCRIPT HASHER + MERKLE BUILDER                      │     │
│  │  - Each agent output → SHA-256 leaf                      │     │
│  │  - All leaves → Merkle tree → root                       │     │
│  │  - Full transcript → off-chain storage (GCS bucket)      │     │
│  └──────────────────────────┬──────────────────────────────┘     │
└──────────────────────────────┼─────────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────────┐
│                    SOLANA SETTLEMENT LAYER                        │
│  ┌──────────────────┐  ┌─────────────────┐  ┌────────────────┐  │
│  │ Anchor Contract   │  │ Helius Webhooks  │  │ Agent Registry │  │
│  │ - TaskAccount PDA │  │ - Confirmation   │  │ - PDA identity │  │
│  │ - Escrow          │  │   streaming      │  │ - Reputation   │  │
│  │ - Receipt storage │  │ - Event triggers │  │   scoring      │  │
│  │ - Mechanism switch│  │                  │  │  (planned)     │  │
│  └──────────────────┘  └─────────────────┘  └────────────────┘  │
└───────────────────────────────────────────────────────────────────┘`;

export function OnChainArchitecture() {
    return (
        <div>
            <p
                className="font-mono text-[11px] uppercase tracking-[0.1em] mb-3"
                style={{ color: "var(--accent-emerald)" }}
            >
                On-Chain
            </p>

            <h1
                className="text-3xl md:text-4xl font-mono font-bold mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                On-Chain Architecture
            </h1>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Agora's settlement layer runs on{" "}
                <strong style={{ color: "var(--text-primary)" }}>Solana</strong>{" "}
                via an{" "}
                <strong style={{ color: "var(--text-primary)" }}>Anchor</strong>{" "}
                smart contract. It handles three responsibilities: locking task
                payment in escrow while deliberation runs, storing the
                cryptographic receipts (Merkle root + decision hash + mechanism
                metadata) that constitute the Proof of Deliberation, and
                releasing payment when quorum is confirmed. A fourth
                responsibility — unique to Agora — is logging mid-execution
                mechanism switches on-chain so the audit trail captures not just
                what was decided but how the deliberation methodology evolved.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Helius webhooks fire on{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    submit_receipt
                </code>{" "}
                confirmation and stream events to the dashboard via Server-Sent
                Events, giving users real-time task status without polling.
            </p>

            {/* ── Account Structures ──────────────────────────────────────────── */}
            <h2
                id="account-structures"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Account Structures
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The central account is{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    TaskAccount
                </code>
                , a PDA seeded by{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    ["task", task_id]
                </code>
                . It stores all data needed to verify the deliberation receipt
                and release escrow. The{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    MechanismType
                </code>{" "}
                enum includes a{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    Hybrid
                </code>{" "}
                variant that records both the original and the replacement
                mechanism when a mid-execution switch occurred.
            </p>

            <CodeBlock
                code={accountStructuresCode}
                language="rust"
                filename="programs/agora/src/state.rs"
            />

            <Callout type="info" title="PDA derivation">
                The TaskAccount PDA is derived from{" "}
                <code>["task", task_id]</code> where <code>task_id</code> is a
                32-byte array provided by the caller at{" "}
                <code>initialize_task</code> time. The PDA holds the escrow SOL
                — it does not require a separate escrow account. Rent is paid by
                the <code>payer</code> and reclaimed on account closure (planned
                in a future instruction).
            </Callout>

            {/* ── Instruction Set ─────────────────────────────────────────────── */}
            <h2
                id="instruction-set"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Instruction Set
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The contract exposes six instructions. All state-mutating
                instructions require the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    payer
                </code>{" "}
                or an authorized orchestrator keypair as signer.
            </p>

            <div className="overflow-x-auto my-5 rounded-lg border border-[var(--border-default)]">
                <table className="w-full text-sm border-collapse">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            {[
                                "Instruction",
                                "Description",
                                "Accounts modified",
                            ].map((h) => (
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
                                "initialize_task",
                                "Creates the TaskAccount PDA, locks SOL escrow, sets mechanism and agent parameters",
                                "TaskAccount (create), system_program",
                            ],
                            [
                                "record_mechanism_selection",
                                "Stores the selector_reasoning_hash (SHA-256 of LLM CoT) before deliberation starts",
                                "TaskAccount (write selector_reasoning_hash)",
                            ],
                            [
                                "submit_receipt",
                                "Writes transcript_merkle_root + decision_hash, sets quorum_reached = true, timestamps completed_at",
                                "TaskAccount (write merkle root, decision hash, status)",
                            ],
                            [
                                "record_mechanism_switch",
                                "Logs a mid-execution mechanism switch with switch_reason_hash; increments mechanism_switches counter",
                                "TaskAccount (write mechanism, switch hash, increment counter)",
                            ],
                            [
                                "release_payment",
                                "Checks quorum_reached = true, transfers escrow lamports to payer",
                                "TaskAccount (read), payer (receive lamports)",
                            ],
                            [
                                "get_task_status",
                                "View function — returns current TaskStatus enum value without modifying state",
                                "TaskAccount (read only)",
                            ],
                        ].map(([inst, desc, accounts]) => (
                            <tr key={inst}>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px] font-mono"
                                    style={{ color: "var(--accent-emerald)" }}
                                >
                                    {inst}
                                </td>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px]"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {desc}
                                </td>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px]"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {accounts}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* ── Escrow Design ───────────────────────────────────────────────── */}
            <h2
                id="escrow-design"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Escrow Design
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The escrow model is intentionally simple:{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    initialize_task
                </code>{" "}
                transfers{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    payment_amount
                </code>{" "}
                lamports from the payer to the TaskAccount PDA itself. The PDA's
                lamport balance is the escrow — no separate vault account is
                needed. This works because the PDA is program-owned; only the
                Agora program can sign on its behalf.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Release conditions enforced by{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    release_payment
                </code>
                :
            </p>

            <ul
                className="list-disc list-inside text-sm leading-relaxed mb-6 space-y-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        quorum_reached == true
                    </code>{" "}
                    — set by{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        submit_receipt
                    </code>{" "}
                    after the orchestrator confirms the deliberation met its
                    consensus threshold
                </li>
                <li>
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        transcript_merkle_root != [0u8; 32]
                    </code>{" "}
                    — ensures the receipt has been submitted before payment is
                    released
                </li>
                <li>
                    Caller must be the original{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        payer
                    </code>{" "}
                    stored in the account — prevents frontrunning by third
                    parties
                </li>
            </ul>

            <Callout type="warning" title="Zero-payment tasks">
                Setting <code>payment_amount = 0</code> is valid and commonly
                used during development. The escrow logic still runs (lamport
                transfer of 0 is a no-op), so the contract flow is identical.{" "}
                <code>release_payment</code> must still be called to formally
                close the task lifecycle.
            </Callout>

            {/* ── Helius Integration ──────────────────────────────────────────── */}
            <h2
                id="helius-integration"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Helius Webhook Integration
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Agora uses{" "}
                <strong style={{ color: "var(--text-primary)" }}>Helius</strong>{" "}
                as its Solana RPC and webhook provider. Two integration points
                are active:
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
                        RPC endpoint
                    </strong>{" "}
                    — all on-chain interactions (sending transactions, reading
                    account state) use the Helius devnet endpoint at{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        https://devnet.helius-rpc.com/?api-key=YOUR_KEY
                    </code>
                    . The enhanced RPC provides significantly higher rate limits
                    and priority fee estimation compared to the public endpoint.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Webhooks
                    </strong>{" "}
                    — a Helius webhook is registered on the Agora program
                    address. When a{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        submit_receipt
                    </code>{" "}
                    transaction lands on-chain, Helius fires an HTTP POST to the
                    Agora backend. The backend decodes the account delta and
                    pushes a task completion event to the frontend dashboard via
                    SSE (Server-Sent Events), eliminating the need for polling.
                </li>
            </ul>

            <Callout type="tip" title="Webhook configuration">
                The Helius webhook is configured to filter for account writes to
                the Agora program ID and only fire on{" "}
                <code>ACCOUNT_ACTIVITY</code> events where the instruction
                discriminator matches <code>submit_receipt</code>. This avoids
                noisy webhook calls for every <code>initialize_task</code> or{" "}
                <code>record_mechanism_selection</code>.
            </Callout>

            {/* ── System Diagram ──────────────────────────────────────────────── */}
            <h2
                id="system-diagram"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                System Architecture
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The diagram below shows the full data flow from task submission
                through on-chain settlement. The meta-orchestrator, mechanism
                engines, and state monitor all run off-chain in the LangGraph
                execution environment. Only receipts, hashes, and escrow events
                touch the chain.
            </p>

            <pre
                className="font-mono text-[11px] leading-relaxed p-5 overflow-x-auto rounded-lg border border-[var(--border-default)] my-5"
                style={{
                    background: "var(--bg-subtle)",
                    color: "var(--text-secondary)",
                    whiteSpace: "pre",
                }}
            >
                {architectureDiagram}
            </pre>
        </div>
    );
}
