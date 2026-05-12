import { CodeBlock } from "../../components/CodeBlock";
import { Callout } from "../../components/Callout";

const sdkVerifyCode = `from agora import AgoraClient

client = AgoraClient(api_key="YOUR_KEY")

# After a completed deliberation, verify the receipt
result = client.deliberate(
    prompt="What is the capital of France?",
    mechanism="vote",
    agent_count=5,
)

# One-line receipt verification
is_valid = client.verify_receipt(result.task_id)
print(f"Receipt valid: {is_valid}")
# Receipt valid: True

# Or pass the result object directly
is_valid = client.verify_receipt(result)
print(f"Merkle root: {result.merkle_root}")
print(f"Solana TX:   {result.solana_tx_hash}")`;

const manualVerifyCode = `import hashlib
from merkletools import MerkleTools

# 1. Obtain transcript hashes from the result
hashes = result.transcript_hashes  # list of hex strings

# 2. Build the Merkle tree
mt = MerkleTools(hash_type="SHA256")
mt.add_leaf(hashes, do_hash=False)
mt.make_tree()
computed_root = mt.get_merkle_root()

# 3. Compare against the result's Merkle root
assert computed_root == result.merkle_root, "Merkle root mismatch — transcript tampered!"
print(f"✓ Verified: {computed_root}")

# 4. Check on Solana
# Visit: https://explorer.solana.com/tx/{result.solana_tx_hash}?cluster=devnet`;

const recomputeHashCode = `import hashlib, json

def recompute_leaf_hashes(transcript: dict) -> list[str]:
    """
    Recompute all leaf hashes from a raw transcript JSON.
    Returns a list of hex-encoded SHA-256 digests.
    """
    hashes = []

    # Hash the selector chain-of-thought
    cot_bytes = json.dumps(transcript["selector_cot"], sort_keys=True).encode()
    hashes.append(hashlib.sha256(cot_bytes).hexdigest())

    # Hash each agent round output
    for round_data in transcript["rounds"]:
        for agent_output in round_data["agent_outputs"]:
            payload = json.dumps(agent_output, sort_keys=True).encode()
            hashes.append(hashlib.sha256(payload).hexdigest())

    # Hash any mechanism switch rationales
    for switch in transcript.get("mechanism_switches", []):
        switch_bytes = json.dumps(switch, sort_keys=True).encode()
        hashes.append(hashlib.sha256(switch_bytes).hexdigest())

    # Hash the final decision
    decision_bytes = json.dumps(transcript["final_decision"], sort_keys=True).encode()
    hashes.append(hashlib.sha256(decision_bytes).hexdigest())

    return hashes`;

export function MerkleVerification() {
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
                Merkle Verification
            </h1>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Every completed deliberation produces a{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    Merkle receipt
                </strong>
                : a 32-byte root that cryptographically commits to the entire
                deliberation transcript. The root is stored on-chain in the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    TaskAccount
                </code>
                . The full transcript is stored off-chain in Google Cloud
                Storage. Anyone can download the transcript, recompute the root
                from scratch, and verify it matches the on-chain value — without
                trusting Agora.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                This page covers three ways to verify a receipt: via the SDK
                helper (easiest), via a manual Python script using{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    merkletools
                </code>{" "}
                (most educational), and directly on Solana Explorer (no code
                required).
            </p>

            {/* ── Using the SDK ───────────────────────────────────────────────── */}
            <h2
                id="using-sdk"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Using the SDK
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The SDK's{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    verify_receipt
                </code>{" "}
                method handles the full pipeline: it fetches the GCS transcript,
                recomputes the Merkle tree, and compares against the on-chain
                root. It raises{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    ReceiptTamperedError
                </code>{" "}
                if verification fails.
            </p>

            <CodeBlock
                code={sdkVerifyCode}
                language="python"
                filename="examples/verify_receipt.py"
            />

            <Callout type="info" title="What verify_receipt checks">
                The SDK method verifies three things: (1) the Merkle root
                computed from the GCS transcript matches the on-chain{" "}
                <code>transcript_merkle_root</code>, (2) the decision hash
                computed from the final answer matches the on-chain{" "}
                <code>decision_hash</code>, and (3) the Solana transaction that
                submitted the receipt is confirmed finalized (not just confirmed
                — finalized, meaning it cannot be rolled back).
            </Callout>

            {/* ── Manual Verification ─────────────────────────────────────────── */}
            <h2
                id="manual-verification"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Manual Verification
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The SDK is a convenience wrapper. The underlying verification is
                pure Python and can be run by anyone with the transcript JSON
                and the task's on-chain address. Install the required library
                first:
            </p>

            <CodeBlock
                code={`pip install merkletools`}
                language="bash"
                filename="terminal"
            />

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Then run the verification against the transcript hashes from the
                result object:
            </p>

            <CodeBlock
                code={manualVerifyCode}
                language="python"
                filename="scripts/manual_verify.py"
            />

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                If you are starting from a raw transcript JSON file (rather than
                a result object), use this helper to recompute all leaf hashes
                in the correct order:
            </p>

            <CodeBlock
                code={recomputeHashCode}
                language="python"
                filename="scripts/recompute_hashes.py"
            />

            <Callout type="warning" title="Hash ordering matters">
                The leaf hash order in the Merkle tree is deterministic and must
                match the order used during deliberation: selector CoT first,
                then agent outputs in round order and agent-index order within
                each round, then mechanism switch hashes in switch order, then
                the final decision last. The transcript JSON preserves this
                ordering. Do not sort leaves before building the tree.
            </Callout>

            {/* ── Solana Explorer ─────────────────────────────────────────────── */}
            <h2
                id="solana-explorer"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Verifying on Solana Explorer
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                No code is required to check that a receipt was committed
                on-chain. The Solana Explorer shows the full transaction and
                account state for any confirmed transaction. To verify manually:
            </p>

            <ol
                className="list-decimal list-inside text-sm leading-relaxed mb-6 space-y-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    Take the{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        solana_tx_hash
                    </code>{" "}
                    from the task result and visit:
                </li>
            </ol>

            <div
                className="font-mono text-[12px] p-4 rounded-lg border border-[var(--border-default)] my-5"
                style={{
                    background: "var(--bg-subtle)",
                    color: "var(--accent-emerald)",
                }}
            >
                https://explorer.solana.com/tx/{"{"} result.solana_tx_hash {"}"}
                ?cluster=devnet
            </div>

            <ol
                className="list-decimal list-inside text-sm leading-relaxed mb-6 space-y-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
                start={2}
            >
                <li>
                    Confirm the transaction status is{" "}
                    <strong style={{ color: "var(--text-primary)" }}>
                        Finalized
                    </strong>{" "}
                    (not just confirmed)
                </li>
                <li>
                    Click{" "}
                    <strong style={{ color: "var(--text-primary)" }}>
                        Account Input(s)
                    </strong>{" "}
                    and find the TaskAccount PDA address
                </li>
                <li>
                    Open the TaskAccount and select{" "}
                    <strong style={{ color: "var(--text-primary)" }}>
                        Anchor Data
                    </strong>{" "}
                    to decode the account fields using the Agora IDL
                </li>
                <li>
                    Compare the decoded{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        transcript_merkle_root
                    </code>{" "}
                    field against the root you computed from the GCS transcript.
                    They must be identical.
                </li>
            </ol>

            <Callout type="tip" title="Solana Explorer + Anchor decoding">
                Solana Explorer can auto-decode Anchor accounts if you upload
                the program IDL or if the program is registered on Anchor's IDL
                registry. The Agora program IDL is available at{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    /idl/agora.json
                </code>{" "}
                in the SDK repository.
            </Callout>

            {/* ── What Gets Verified ──────────────────────────────────────────── */}
            <h2
                id="what-is-verified"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                What Gets Verified
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The Merkle tree includes every discrete artifact produced during
                the deliberation. The following table lists each artifact type,
                its leaf hash construction, and where it appears in the
                transcript JSON:
            </p>

            <div className="overflow-x-auto my-5 rounded-lg border border-[var(--border-default)]">
                <table className="w-full text-sm border-collapse">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            {[
                                "Artifact",
                                "Leaf hash input",
                                "Mechanisms",
                                "Transcript key",
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
                                "Selector chain-of-thought",
                                "SHA-256(JSON.stringify(selector_cot))",
                                "All",
                                "selector_cot",
                            ],
                            [
                                "Agent argument (per round, per agent)",
                                "SHA-256(JSON.stringify(agent_output))",
                                "Debate, Delphi",
                                "rounds[n].agent_outputs[i]",
                            ],
                            [
                                "Agent vote + confidence + group prediction",
                                "SHA-256(JSON.stringify(vote_record))",
                                "ISP Voting",
                                "rounds[0].agent_outputs[i]",
                            ],
                            [
                                "Mechanism switch rationale",
                                "SHA-256(JSON.stringify(switch_record))",
                                "Any (on switch)",
                                "mechanism_switches[n]",
                            ],
                            [
                                "Final decision",
                                "SHA-256(JSON.stringify(final_decision))",
                                "All",
                                "final_decision",
                            ],
                        ].map(([artifact, hash, mechanisms, key]) => (
                            <tr key={artifact}>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px]"
                                    style={{ color: "var(--text-primary)" }}
                                >
                                    {artifact}
                                </td>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px] font-mono"
                                    style={{
                                        color: "var(--accent-emerald)",
                                        fontSize: "11px",
                                    }}
                                >
                                    {hash}
                                </td>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px]"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {mechanisms}
                                </td>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px] font-mono"
                                    style={{
                                        color: "var(--text-secondary)",
                                        fontSize: "11px",
                                    }}
                                >
                                    {key}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                All JSON serialization uses{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    sort_keys=True
                </code>{" "}
                and no extra whitespace to ensure deterministic byte sequences
                regardless of the Python version or dictionary insertion order
                used to construct the objects. The same canonical serialization
                is used in the TypeScript SDK via{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    JSON.stringify
                </code>{" "}
                with a custom key-sorting replacer. Cross-language verification
                is therefore reliable.
            </p>
        </div>
    );
}
