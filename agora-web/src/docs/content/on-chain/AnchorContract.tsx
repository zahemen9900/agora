import { CodeBlock } from "../../components/CodeBlock";
import { Callout } from "../../components/Callout";
import { ParamTable } from "../../components/ParamTable";
import type { Param } from "../../components/ParamTable";

const tsClientCode = `import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { Agora } from "./target/types/agora";

const connection = new anchor.web3.Connection(
  "https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
);
const wallet = anchor.web3.Keypair.generate();
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {});
anchor.setProvider(provider);

const program = anchor.workspace.Agora as Program<Agora>;

// Initialize a task
const taskId = anchor.web3.Keypair.generate().publicKey.toBytes();
const [taskPda] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("task"), taskId],
  program.programId
);

await program.methods
  .initializeTask(
    Array.from(taskId),      // task_id: [u8; 32]
    { debate: {} },          // mechanism: MechanismType::Debate
    3,                       // agent_count
    60,                      // consensus_threshold (60%)
    new anchor.BN(0)         // payment_amount in lamports
  )
  .accounts({
    taskAccount: taskPda,
    payer: wallet.publicKey,
    systemProgram: anchor.web3.SystemProgram.programId,
  })
  .rpc();

console.log("Task initialized:", taskPda.toBase58());

// After deliberation completes — submit receipt
const merkleRoot = new Uint8Array(32).fill(0xab); // Replace with actual root
const decisionHash = new Uint8Array(32).fill(0xcd); // Replace with actual hash

await program.methods
  .submitReceipt(
    Array.from(merkleRoot),   // transcript_merkle_root: [u8; 32]
    Array.from(decisionHash)  // decision_hash: [u8; 32]
  )
  .accounts({
    taskAccount: taskPda,
    orchestrator: wallet.publicKey,
  })
  .rpc();

console.log("Receipt submitted — quorum_reached: true");`;

const taskAccountParams: Param[] = [
    {
        name: "task_id",
        type: "[u8; 32]",
        required: true,
        description:
            "Unique 32-byte identifier for this task. Used as the PDA seed. Caller-generated — typically derived from a UUID or a random keypair public key.",
    },
    {
        name: "mechanism",
        type: "MechanismType",
        required: true,
        description:
            "The deliberation mechanism selected for this task. One of Debate, Vote, Delphi, MoA, or Hybrid { primary, switched_to }. Set by initialize_task, updated by record_mechanism_switch.",
    },
    {
        name: "selector_reasoning_hash",
        type: "[u8; 32]",
        required: true,
        description:
            "SHA-256 hash of the LLM reasoning agent's chain-of-thought JSON that justified the mechanism selection. Committed before deliberation starts via record_mechanism_selection.",
    },
    {
        name: "transcript_merkle_root",
        type: "[u8; 32]",
        required: true,
        description:
            "Merkle root of all deliberation artifacts. Set by submit_receipt after deliberation completes. Initialized to [0u8; 32] until the receipt is submitted.",
    },
    {
        name: "decision_hash",
        type: "[u8; 32]",
        required: true,
        description:
            "SHA-256 hash of the final aggregated decision JSON. Set alongside transcript_merkle_root by submit_receipt.",
    },
    {
        name: "quorum_reached",
        type: "bool",
        required: true,
        default: "false",
        description:
            "Set to true by submit_receipt when the deliberation met the configured consensus_threshold. release_payment checks this field before transferring escrow.",
    },
    {
        name: "agent_count",
        type: "u8",
        required: true,
        description:
            "Number of agents that participated in the deliberation. Set at initialize_task. Used by the orchestrator to validate that all expected agents responded before submitting the receipt.",
    },
    {
        name: "consensus_threshold",
        type: "u8",
        required: true,
        description:
            "Minimum fraction of agents (as a percentage, 0–100) that must agree for quorum_reached to be set. Example: 60 means at least 60% of agents must converge on the winning answer.",
    },
    {
        name: "payment_amount",
        type: "u64",
        required: true,
        description:
            "Lamports locked in escrow when the task is initialized. Released to the payer by release_payment after quorum is confirmed. Set to 0 for free tasks.",
    },
    {
        name: "payer",
        type: "Pubkey",
        required: true,
        description:
            "The public key of the account that funded the escrow and is entitled to receive the payment release. Only this address can call release_payment.",
    },
    {
        name: "mechanism_switches",
        type: "u8",
        required: true,
        default: "0",
        description:
            "Counter of how many mid-execution mechanism switches occurred during this task's lifetime. Incremented by record_mechanism_switch. An auditor can use this to know how many switch rationale hashes to look for in the GCS transcript.",
    },
    {
        name: "created_at",
        type: "i64",
        required: true,
        description:
            "Unix timestamp (seconds since epoch) at which initialize_task was called. Stored as an i64 to match Solana's Clock::unix_timestamp type.",
    },
    {
        name: "completed_at",
        type: "Option<i64>",
        required: false,
        default: "None",
        description:
            "Unix timestamp at which submit_receipt was called. None until the task completes. Can be used to compute deliberation latency from created_at.",
    },
];

export function AnchorContract() {
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
                Anchor Contract
            </h1>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The Agora Anchor contract is the on-chain component of the Proof
                of Deliberation system. It defines the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    TaskAccount
                </code>{" "}
                PDA structure, exposes six instructions for the full task
                lifecycle (initialize → select mechanism → deliberate → submit
                receipt → release payment), and logs mechanism switches on-chain
                as a first-class operation. The contract is written in Rust
                using the{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    Anchor framework
                </strong>{" "}
                and deployed on Solana devnet.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                This page covers the account structure in detail (with
                field-by-field descriptions), all six instructions with their
                account context requirements, the error code catalog, and a
                working TypeScript client example using{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    @coral-xyz/anchor
                </code>
                .
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
                The{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    TaskAccount
                </code>{" "}
                is the only account type defined in the contract. All data for a
                task — mechanism type, cryptographic receipts, escrow amount,
                quorum status — lives in this single PDA. The following table
                describes each field:
            </p>

            <ParamTable params={taskAccountParams} />

            <Callout type="info" title="Account size">
                The fixed-size portion of the TaskAccount (excluding the{" "}
                <code>MechanismType::Hybrid</code> variant's boxed pointers) is
                approximately 180 bytes. The minimum rent-exempt balance at
                current Solana parameters is ~0.0016 SOL. This is paid by the
                payer at <code>initialize_task</code> time on top of any{" "}
                <code>payment_amount</code>.
            </Callout>

            {/* ── Instructions ────────────────────────────────────────────────── */}
            <h2
                id="instructions"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Instructions
            </h2>

            {/* initialize_task */}
            <h3
                id="ix-initialize-task"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                initialize_task
            </h3>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Creates the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    TaskAccount
                </code>{" "}
                PDA seeded by{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    ["task", task_id]
                </code>
                , transfers{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    payment_amount
                </code>{" "}
                lamports into the PDA as escrow, and initializes all fields.
                Must be called before any other instruction on this task.
            </p>

            <p
                className="text-sm leading-relaxed mb-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Signature:{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    initialize_task(task_id: [u8; 32], mechanism: MechanismType,
                    agent_count: u8, consensus_threshold: u8, payment_amount:
                    u64)
                </code>
            </p>

            <Callout type="info" title="Accounts required">
                <code>task_account</code> (PDA, init), <code>payer</code>{" "}
                (signer, mut), <code>system_program</code>
            </Callout>

            {/* record_mechanism_selection */}
            <h3
                id="ix-record-mechanism-selection"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                record_mechanism_selection
            </h3>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Stores the SHA-256 hash of the LLM reasoning agent's
                chain-of-thought justification in
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    {" "}
                    selector_reasoning_hash
                </code>
                . Called by the orchestrator immediately after mechanism
                selection, before the first deliberation round begins. This
                locks the mechanism choice on-chain.
            </p>

            <p
                className="text-sm leading-relaxed mb-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Signature:{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    record_mechanism_selection(selector_reasoning_hash: [u8;
                    32])
                </code>
            </p>

            <Callout type="info" title="Accounts required">
                <code>task_account</code> (mut), <code>orchestrator</code>{" "}
                (signer)
            </Callout>

            {/* submit_receipt */}
            <h3
                id="ix-submit-receipt"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                submit_receipt
            </h3>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The terminal instruction for a successful deliberation. Writes
                the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    transcript_merkle_root
                </code>{" "}
                and{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    decision_hash
                </code>{" "}
                to the account, sets{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    quorum_reached = true
                </code>
                , and records{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    completed_at
                </code>{" "}
                from the current on-chain clock. This is the transaction that
                Helius webhooks monitor.
            </p>

            <p
                className="text-sm leading-relaxed mb-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Signature:{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    submit_receipt(transcript_merkle_root: [u8; 32],
                    decision_hash: [u8; 32])
                </code>
            </p>

            <Callout type="info" title="Accounts required">
                <code>task_account</code> (mut), <code>orchestrator</code>{" "}
                (signer), <code>clock</code> (sysvar)
            </Callout>

            {/* record_mechanism_switch */}
            <h3
                id="ix-record-mechanism-switch"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                record_mechanism_switch
            </h3>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Called by the mid-execution state monitor when it triggers a
                mechanism switch. Updates the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    mechanism
                </code>{" "}
                field to{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    {"Hybrid { primary, switched_to }"}
                </code>
                , stores the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    switch_reason_hash
                </code>{" "}
                (SHA-256 of the monitor's rationale JSON), and increments{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    mechanism_switches
                </code>
                . This instruction is unique to Agora — no other on-chain AI
                system exposes mid-execution strategy changes as a first-class
                auditable event.
            </p>

            <p
                className="text-sm leading-relaxed mb-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Signature:{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    record_mechanism_switch(new_mechanism: MechanismType,
                    switch_reason_hash: [u8; 32])
                </code>
            </p>

            <Callout type="info" title="Accounts required">
                <code>task_account</code> (mut), <code>orchestrator</code>{" "}
                (signer)
            </Callout>

            {/* release_payment */}
            <h3
                id="ix-release-payment"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                release_payment
            </h3>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Transfers the escrowed lamports from the TaskAccount PDA back to
                the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    payer
                </code>{" "}
                address. Requires{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    quorum_reached == true
                </code>{" "}
                and{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    transcript_merkle_root != [0u8; 32]
                </code>
                . Only the original payer address may call this instruction.
            </p>

            <p
                className="text-sm leading-relaxed mb-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Signature:{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    release_payment()
                </code>
            </p>

            <Callout type="info" title="Accounts required">
                <code>task_account</code> (mut), <code>payer</code> (signer,
                mut)
            </Callout>

            {/* get_task_status */}
            <h3
                id="ix-get-task-status"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                get_task_status
            </h3>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                A read-only view instruction that derives the current{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    TaskStatus
                </code>{" "}
                enum value from the account state:{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    Pending
                </code>{" "}
                (not yet started),{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    Running
                </code>{" "}
                (receipt not yet submitted),{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    Completed
                </code>{" "}
                (receipt submitted and quorum reached), or{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    Failed
                </code>{" "}
                (terminal failure state, no quorum reached within timeout).
            </p>

            <p
                className="text-sm leading-relaxed mb-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Signature:{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    get_task_status() {"→"} TaskStatus
                </code>
            </p>

            <Callout type="info" title="Accounts required">
                <code>task_account</code> (read only)
            </Callout>

            {/* ── Error Codes ─────────────────────────────────────────────────── */}
            <h2
                id="error-codes"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Error Codes
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The contract defines custom Anchor error codes for all expected
                failure states. These are returned as{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    AnchorError
                </code>{" "}
                in the TypeScript client and can be matched by their numeric
                code in the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    error.code.number
                </code>{" "}
                field.
            </p>

            <div className="overflow-x-auto my-5 rounded-lg border border-[var(--border-default)]">
                <table className="w-full text-sm border-collapse">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            {["Code", "Name", "Description"].map((h) => (
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
                                "6000",
                                "QuorumNotReached",
                                "release_payment called but quorum_reached is still false. Deliberation has not concluded or failed.",
                            ],
                            [
                                "6001",
                                "InsufficientFunds",
                                "The payer account does not have enough lamports to cover payment_amount plus the TaskAccount rent.",
                            ],
                            [
                                "6002",
                                "TaskAlreadyCompleted",
                                "submit_receipt was called on a task where quorum_reached is already true. Each task can only be completed once.",
                            ],
                            [
                                "6003",
                                "InvalidMechanism",
                                "The MechanismType value passed to initialize_task or record_mechanism_switch is not a recognized variant.",
                            ],
                            [
                                "6004",
                                "UnauthorizedSigner",
                                "The signer of a state-mutating instruction does not match the stored payer or registered orchestrator address.",
                            ],
                        ].map(([code, name, desc]) => (
                            <tr key={code}>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px] font-mono"
                                    style={{ color: "var(--accent-emerald)" }}
                                >
                                    {code}
                                </td>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px] font-mono"
                                    style={{ color: "var(--text-primary)" }}
                                >
                                    {name}
                                </td>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px]"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {desc}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* ── TypeScript Client ───────────────────────────────────────────── */}
            <h2
                id="typescript-client"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                TypeScript Client Example
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The following example shows how to interact with the Agora
                contract using{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    @coral-xyz/anchor
                </code>
                . It covers the two most common operations: initializing a task
                and submitting a receipt after deliberation completes. Replace{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    YOUR_KEY
                </code>{" "}
                with your Helius API key.
            </p>

            <CodeBlock
                code={tsClientCode}
                language="typescript"
                filename="client/agora_client.ts"
            />

            <Callout type="warning" title="Keypair security">
                The example generates an ephemeral keypair for demonstration. In
                production, use a hardware wallet (Ledger) or a securely loaded
                keypair from an environment variable. Never commit a funded
                keypair to source control.
            </Callout>

            <Callout type="tip" title="IDL auto-completion">
                Anchor generates a TypeScript type file at{" "}
                <code>target/types/agora.ts</code> from the program IDL. Import
                this type as{" "}
                <code>
                    import type {"{"} Agora {"}"} from "./target/types/agora"
                </code>{" "}
                to get full type-safe auto-completion on all method names,
                argument types, and account names in your editor.
            </Callout>
        </div>
    );
}
