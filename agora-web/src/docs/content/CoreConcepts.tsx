import { Callout } from "../components/Callout";

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

const keyTerms = [
    {
        term: "Deliberation",
        definition:
            "The structured process by which Agora routes a task through one or more agents using a chosen mechanism, producing a final answer and a verifiable audit trail.",
    },
    {
        term: "Quorum",
        definition:
            "A convergence threshold — the minimum fraction of agents that must agree on a position (or the minimum confidence delta) before adaptive termination fires.",
    },
    {
        term: "Merkle Root",
        definition:
            "The SHA-256 root of the Merkle tree built from all deliberation transcript entries. Committed to Solana; used to verify that no output was altered after the fact.",
    },
    {
        term: "Faction",
        definition:
            "A pre-assigned position in the debate mechanism. Agents are locked into a faction before seeing other outputs, preventing premature convergence on shared priors.",
    },
    {
        term: "State Locking",
        definition:
            "The practice of serialising and hashing agent state at each deliberation step, preventing retroactive modification of intermediate outputs.",
    },
    {
        term: "Adaptive Termination",
        definition:
            "An early-stopping strategy that ends deliberation when quorum is reached or when additional rounds are statistically unlikely to change the outcome.",
    },
    {
        term: "ISP",
        definition:
            "Inverse Surprising Popularity — a voting aggregation method that up-weights answers that are more popular among high-confidence respondents than a Bayesian prediction would suggest.",
    },
    {
        term: "Thompson Sampling",
        definition:
            "A Bayesian bandit algorithm that samples from Beta posteriors over mechanism performance to probabilistically select the best mechanism for a given task category.",
    },
];

export function CoreConcepts() {
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
                Core Concepts
            </h1>

            <p
                className="text-base leading-relaxed mb-6"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Agora coordinates three deliberation mechanisms, a learned
                mechanism selector, and an on-chain verification layer.
                Understanding these pieces will help you choose the right
                configuration for your use case and interpret the results you
                get back.
            </p>

            {/* ── Mechanisms ────────────────────────────────────────────────── */}
            <h2
                id="mechanisms"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Mechanisms
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                A mechanism is the deliberation protocol Agora uses to resolve a
                task. Each one is designed with structural safeguards against a
                specific class of multi-agent failure. The mechanism selector
                chooses among them automatically, but you can override the
                choice by passing <IC>mechanism="debate"</IC>,{" "}
                <IC>mechanism="vote"</IC>, or <IC>mechanism="delphi"</IC> to the
                SDK.
            </p>

            {/* Debate */}
            <h3
                id="debate"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                Debate (Factional)
            </h3>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The debate mechanism assigns each agent to a faction — a
                position to argue — before any agent sees another's output. This
                prevents the martingale collapse that occurs when agents update
                on each other's priors before committing to an independent
                stance. After initial faction outputs are recorded, a{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    Devil's Advocate
                </strong>{" "}
                agent cross-examines the leading position, introducing
                structured adversarial pressure.
            </p>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Adaptive termination fires when the faction holding the highest
                aggregate confidence score exceeds a quorum threshold, or when
                cross-examination rounds fail to shift confidence by more than a
                configurable delta. The final answer is the synthesised position
                of the winning faction, weighted by confidence scores.
            </p>

            <div
                className="text-sm mb-5 px-4 py-3 rounded-lg"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-default)",
                    color: "var(--text-secondary)",
                }}
            >
                <span
                    className="font-mono text-[11px] uppercase tracking-wider"
                    style={{ color: "var(--text-tertiary)" }}
                >
                    Best for:{" "}
                </span>
                Complex reasoning tasks, engineering trade-offs, policy
                analysis, multi-factor decisions where the failure modes of
                majority vote (ignoring minority expertise) and Delphi
                (groupthink) are both relevant.
            </div>

            {/* Vote */}
            <h3
                id="vote"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                Vote (ISP-Weighted)
            </h3>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Instead of simple majority vote, Agora uses{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    Inverse Surprising Popularity (ISP)
                </strong>{" "}
                scoring. Each agent independently answers the question and then
                predicts the distribution of answers across all other agents. An
                answer that is{" "}
                <em>more popular than predicted by the median respondent</em>{" "}
                scores a positive ISP signal — it represents genuine expert
                knowledge that most agents underestimated the prevalence of.
            </p>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                This surfaces minority-but-correct knowledge that plain majority
                vote buries. A small group of high-confidence experts can
                outweigh a larger group of uncertain agents, even if the
                majority picks the wrong answer.
            </p>

            <div
                className="text-sm mb-5 px-4 py-3 rounded-lg"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-default)",
                    color: "var(--text-secondary)",
                }}
            >
                <span
                    className="font-mono text-[11px] uppercase tracking-wider"
                    style={{ color: "var(--text-tertiary)" }}
                >
                    Best for:{" "}
                </span>
                Factual aggregation, classification tasks, trivia-style
                questions, and situations where ground truth exists and expert
                minority knowledge is likely to be correct.
            </div>

            {/* Delphi */}
            <h3
                id="delphi"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                Delphi Consensus
            </h3>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Agora's Delphi mechanism mirrors the classical Delphi method:
                agents submit anonymous initial responses, see an anonymised
                summary of the group's responses, and then revise their answers
                in subsequent rounds. Anonymity prevents social conformity
                pressure — agents update based on the <em>content</em> of other
                responses, not their source.
            </p>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Groupthink is suppressed by a dissent preservation rule: if any
                agent's position diverges by more than a threshold from the
                emerging consensus, that agent's reasoning is explicitly
                included in the next round's summary. Convergence is measured by
                inter-round variance across agent confidence scores.
            </p>

            <div
                className="text-sm mb-5 px-4 py-3 rounded-lg"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-default)",
                    color: "var(--text-secondary)",
                }}
            >
                <span
                    className="font-mono text-[11px] uppercase tracking-wider"
                    style={{ color: "var(--text-tertiary)" }}
                >
                    Best for:{" "}
                </span>
                Subjective questions, value judgements, forecasting tasks, and
                open-ended questions where multiple valid perspectives exist and
                iterative refinement improves quality.
            </div>

            {/* ── Mechanism Selection ───────────────────────────────────────── */}
            <h2
                id="mechanism-selection"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Mechanism Selection
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                When you call <IC>arbitrate()</IC> without specifying a
                mechanism, Agora's{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    mechanism selector
                </strong>{" "}
                chooses one automatically. It combines a Thompson Sampling
                contextual bandit with an LLM reasoning step to make this
                decision.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The bandit maintains{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    Beta posterior distributions
                </strong>{" "}
                over the performance of each mechanism, stratified by task
                category (e.g., "engineering trade-off", "factual recall",
                "ethical judgement"). At selection time, it draws one sample
                from each posterior and selects the mechanism with the highest
                draw — this is Thompson Sampling. After each run, the outcome
                (quorum reached, confidence score, user rating) updates the
                corresponding Beta parameters.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                An LLM reasoning step then validates the bandit's choice against
                the semantic content of the task. If the task has
                characteristics strongly associated with a different mechanism —
                such as a highly subjective framing that suggests Delphi despite
                the bandit preferring debate — the LLM can override the
                selection.
            </p>

            <Callout type="info" title="Mid-execution switching">
                If early convergence signals indicate the selected mechanism is
                unlikely to reach quorum — for example, factional debate
                producing oscillating confidence without convergence after two
                rounds — Agora can switch mechanisms mid-execution. The original
                mechanism's transcript entries are preserved in the Merkle tree,
                and the switch event is logged as a <IC>mechanism_switch</IC>{" "}
                SSE event.
            </Callout>

            {/* ── Proof of Deliberation ─────────────────────────────────────── */}
            <h2
                id="proof-of-deliberation"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Proof of Deliberation
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Proof of Deliberation is Agora's cryptographic audit trail — a
                new primitive that makes AI reasoning verifiable in the same way
                that Proof of Work makes computation verifiable. It works in
                five steps:
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
                        Hash each transcript entry.
                    </strong>{" "}
                    Every agent output, cross-examination round, convergence
                    signal, mechanism switch, and final answer is serialised to
                    a canonical JSON string and SHA-256 hashed. Each hash
                    becomes a leaf node in the Merkle tree.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Build the Merkle tree.
                    </strong>{" "}
                    Leaf hashes are paired and hashed together, bottom-up, until
                    a single root hash remains. The tree structure is
                    deterministic given the same transcript, so any party can
                    reconstruct it independently.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Commit the root to Solana.
                    </strong>{" "}
                    The Merkle root is written to Solana via the Agora Anchor
                    program when the hosted flow commits a receipt. Hosted task
                    metadata can include the transaction hash; the local{" "}
                    <IC>DeliberationResult</IC> itself is the receipt payload,
                    not a full on-chain status object.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Verify locally.
                    </strong>{" "}
                    Call <IC>verify_receipt(result, strict=False)</IC> to
                    recompute the Merkle root and compare it against hosted
                    receipt metadata when available. Add <IC>rpc_url</IC> and
                    use strict mode only when you want a full on-chain check.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Audit externally.
                    </strong>{" "}
                    Anyone with the Solana transaction hash can independently
                    retrieve the committed root and verify it against a
                    transcript. The Anchor program is open-source and the
                    verification algorithm is deterministic.
                </li>
            </ol>

            <Callout type="tip" title="Why Solana?">
                Solana's sub-second finality and low transaction costs make it
                practical to commit a receipt for every deliberation — not just
                high-stakes ones. The Anchor contract stores only the 32-byte
                Merkle root, keeping on-chain storage minimal. Full transcript
                data is returned by the API and stored by the caller.
            </Callout>

            {/* ── Key Terms ─────────────────────────────────────────────────── */}
            <h2
                id="key-terms"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Key Terms
            </h2>

            <div className="overflow-x-auto my-5 rounded-lg border border-[var(--border-default)]">
                <table className="w-full text-sm border-collapse">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            <th
                                className="text-left px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.07em]"
                                style={{ color: "var(--text-tertiary)" }}
                            >
                                Term
                            </th>
                            <th
                                className="text-left px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.07em]"
                                style={{ color: "var(--text-tertiary)" }}
                            >
                                Definition
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {keyTerms.map(({ term, definition }) => (
                            <tr
                                key={term}
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
                                    className="px-4 py-3 font-mono text-[13px] whitespace-nowrap align-top"
                                    style={{ color: "var(--accent-emerald)" }}
                                >
                                    {term}
                                </td>
                                <td
                                    className="px-4 py-3 text-[13px] leading-relaxed"
                                    style={{
                                        fontFamily:
                                            "'Hanken Grotesk', sans-serif",
                                        color: "var(--text-secondary)",
                                    }}
                                >
                                    {definition}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
