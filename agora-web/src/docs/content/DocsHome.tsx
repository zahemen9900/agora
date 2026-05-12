import { Callout } from "../components/Callout";
import { LinkCard } from "../components/LinkCard";

export function DocsHome() {
    return (
        <div>
            <p
                className="font-mono text-[11px] uppercase tracking-[0.1em] mb-3"
                style={{ color: "var(--accent-emerald)" }}
            >
                Documentation
            </p>

            <h1
                className="text-3xl md:text-4xl font-mono font-bold mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Agora Documentation
            </h1>

            <p
                className="text-base leading-relaxed mb-6"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Agora is an on-chain multi-agent orchestration primitive. It
                dynamically selects whether AI agents should debate, vote, or
                use Delphi consensus to resolve a task, executes the chosen
                mechanism with structural guarantees against known failure
                modes, and commits Merkle-verified receipts to Solana —
                producing a cryptographically auditable record of every
                reasoning step.
            </p>

            {/* ── Why Agora ─────────────────────────────────────────────────── */}
            <h2
                id="why-agora"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Why Agora?
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Multi-agent debate, as typically implemented, suffers from the{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    martingale property
                </strong>{" "}
                (Li et al., NeurIPS 2025): agents iteratively converge toward a
                shared answer, but that answer is a weighted average of their
                initial priors — not a reliable approximation of ground truth.
                Errors compound rather than cancel. The more rounds of debate,
                the more confident the agents become in a potentially wrong
                answer.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Agora addresses this with three structural innovations:
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
                        Mechanism selection via Thompson Sampling.
                    </strong>{" "}
                    A contextual bandit model — informed by task embeddings and
                    historical outcome data — selects the deliberation mechanism
                    best suited to each task category: factional debate,
                    ISP-weighted voting, or Delphi consensus. The bandit updates
                    Beta posteriors after each run and can switch mechanisms
                    mid-execution if early signals indicate the chosen path is
                    diverging.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Anti-failure structural guarantees.
                    </strong>{" "}
                    The debate engine uses factional assignment (agents are
                    locked into positions before seeing each other's outputs),
                    Devil's Advocate cross-examination rounds, and adaptive
                    termination — stopping when convergence or quorum is reached
                    rather than running a fixed number of rounds. ISP voting
                    weights answers by how surprising they are among
                    high-confidence respondents, surfacing expert minority
                    knowledge that majority vote would bury.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Proof of Deliberation.
                    </strong>{" "}
                    Every agent output, cross-examination, convergence signal,
                    and final answer is hashed into a SHA-256 Merkle tree. The
                    root is committed to Solana via an Anchor program, producing
                    an immutable, verifiable receipt. You can independently
                    reconstruct the tree and confirm that the on-chain root
                    matches — without trusting Agora's servers.
                </li>
            </ol>

            <Callout type="info" title="Research basis">
                The martingale convergence failure was formally characterised in{" "}
                <em>Du Plessis et al. (2025)</em>. Agora's ISP voting mechanism
                adapts the Surprisingly Popular Answer algorithm from{" "}
                <em>Prelec et al. (Science, 2017)</em>. See the{" "}
                <a
                    href="/docs/research/proof-of-deliberation"
                    style={{ color: "var(--accent-emerald)" }}
                >
                    Research
                </a>{" "}
                section for full citations.
            </Callout>

            {/* ── How it works ──────────────────────────────────────────────── */}
            <h2
                id="how-it-works"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                How It Works
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Every call to Agora follows the same five-stage pipeline,
                regardless of which mechanism is selected:
            </p>

            <ol
                className="text-sm leading-relaxed mb-6 space-y-2 pl-5 list-decimal"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Task ingestion.
                    </strong>{" "}
                    Your task string is embedded, classified, and matched
                    against the bandit's prior distribution over mechanisms.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Mechanism selection.
                    </strong>{" "}
                    Thompson Sampling draws from the Beta posteriors to select
                    debate, vote, or Delphi. An LLM reasoning step validates the
                    choice against task semantics.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Deliberation execution.
                    </strong>{" "}
                    The selected mechanism runs with structural anti-failure
                    measures: faction locking, adversarial cross-examination, or
                    anonymous iterative refinement, depending on the mechanism.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Receipt construction.
                    </strong>{" "}
                    All intermediate states are hashed into a SHA-256 Merkle
                    tree. The root is committed to Solana via the Anchor
                    program.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Result return.
                    </strong>{" "}
                    The SDK returns a{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        DeliberationResult
                    </code>{" "}
                    containing the final answer, confidence, mechanism used,
                    Merkle root, and Solana transaction hash.
                </li>
            </ol>

            {/* ── Quick Links ───────────────────────────────────────────────── */}
            <h2
                id="quick-links"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Quick Links
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
                <LinkCard
                    title="Quickstart"
                    description="Run your first Agora deliberation in under 5 minutes."
                    href="/docs/quickstart"
                />
                <LinkCard
                    title="Python SDK"
                    description="Full SDK reference — AgoraArbitrator, AgoraNode, and DeliberationResult."
                    href="/docs/sdk/python"
                />
                <LinkCard
                    title="Research Foundations"
                    description="The papers and theory behind Proof of Deliberation."
                    href="/docs/research/proof-of-deliberation"
                />
                <LinkCard
                    title="On-Chain Architecture"
                    description="Anchor contract, Merkle trees, and Solana integration details."
                    href="/docs/on-chain/architecture"
                />
            </div>
        </div>
    );
}
