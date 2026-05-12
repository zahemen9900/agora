import { Callout } from "../../components/Callout";
import { Steps, Step } from "../../components/Steps";

export function DelphiConsensus() {
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
                Delphi Consensus
            </h1>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <strong style={{ color: "var(--text-primary)" }}>
                    Delphi Consensus
                </strong>{" "}
                is Agora's mechanism for tasks requiring structured convergence
                on subjective, values-laden, or creative questions. Rather than
                arguing (Factional Debate) or aggregating independent votes (ISP
                Voting), Delphi runs agents through multiple anonymized revision
                cycles — each agent sees a summary of where its peers landed,
                but not who said what, before revising its own position.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The anonymization is the defining feature. Li et al., NeurIPS
                2025, showed that conformity bias — where agents shift toward
                positions associated with prominent or authoritative peers — is
                the primary failure mode of unguided debate. Delphi's anonymous
                feedback loop preserves the information from peer positions
                while eliminating the identity signal that drives conformity.
            </p>

            {/* ── Classical Delphi ────────────────────────────────────────────── */}
            <h2
                id="classical-delphi"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Classical Delphi Method
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The Delphi method was developed in the 1950s by{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    RAND Corporation
                </strong>{" "}
                researchers Olaf Helmer and Norman Dalkey as a structured
                forecasting technique for expert panels. The original protocol:
            </p>

            <ol
                className="list-decimal list-inside text-sm leading-relaxed mb-6 space-y-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    Experts submit independent forecasts or judgments via
                    anonymous questionnaire
                </li>
                <li>
                    A facilitator aggregates all submissions and computes
                    summary statistics (median, IQR)
                </li>
                <li>
                    Experts receive the anonymous summary and are invited to
                    revise their estimate
                </li>
                <li>
                    Steps 2–3 repeat until convergence (typically 3–4 rounds in
                    practice)
                </li>
                <li>
                    The final aggregated distribution is taken as the panel's
                    collective judgment
                </li>
            </ol>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Key properties that made the classical method successful in
                human expert panels: experts can update their view when they
                learn what others think, but they cannot be socially pressured
                because they never know <em>who</em> thinks what. Minority
                outliers are preserved in the distribution rather than silenced
                by group consensus dynamics.
            </p>

            <Callout type="info" title="Historical context">
                RAND's early Delphi applications focused on military forecasting
                — estimating the number of atomic bombs needed to destroy Soviet
                industrial capacity. The technique was later adopted for
                technology forecasting, policy analysis, and corporate strategy.
                Agora adapts it for LLM agent consensus on subjective tasks
                where neither majority vote nor adversarial debate is
                appropriate.
            </Callout>

            {/* ── LLM Adaptation ──────────────────────────────────────────────── */}
            <h2
                id="llm-adaptation"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                LLM Adaptation
            </h2>

            <p
                className="text-sm leading-relaxed mb-6"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Agora's Delphi implementation runs in three rounds, each
                corresponding to a distinct cognitive phase:
            </p>

            <Steps>
                <Step number={1} title="Independent generation">
                    <p
                        className="text-sm leading-relaxed"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        All agents receive the task prompt simultaneously with
                        no information about what other agents will say. Each
                        agent produces its initial response and an accompanying
                        structured reasoning trace. Responses are collected by
                        the orchestrator and not shared between agents at this
                        stage. This phase produces the prior distribution over
                        agent positions.
                    </p>
                </Step>

                <Step number={2} title="Anonymous feedback">
                    <p
                        className="text-sm leading-relaxed mb-3"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        The orchestrator synthesizes a{" "}
                        <strong style={{ color: "var(--text-primary)" }}>
                            peer summary
                        </strong>{" "}
                        from all round-1 responses. The summary includes:
                    </p>
                    <ul
                        className="list-disc list-inside text-sm leading-relaxed space-y-1"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        <li>
                            The distribution of positions (e.g., "3 agents
                            favored X, 2 favored Y")
                        </li>
                        <li>
                            Key reasoning themes raised, without attribution
                        </li>
                        <li>
                            Outlier positions that diverge significantly from
                            the modal answer — also without attribution
                        </li>
                    </ul>
                    <p
                        className="text-sm leading-relaxed mt-3"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        Each agent receives this identical summary. No agent
                        learns which peer wrote which argument.
                    </p>
                </Step>

                <Step number={3} title="Justified revision">
                    <p
                        className="text-sm leading-relaxed"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        Agents revise their position in light of the peer
                        summary. The revision prompt explicitly requires a{" "}
                        <strong style={{ color: "var(--text-primary)" }}>
                            change justification
                        </strong>
                        : if the agent's position changed, it must articulate
                        which peer arguments caused the change and why. If
                        unchanged, it must acknowledge the opposing positions
                        and explain why they were insufficient. Revisions
                        without justification are flagged and excluded from the
                        final aggregation.
                    </p>
                </Step>
            </Steps>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                After round 3, the orchestrator aggregates all final positions
                (weighted equally, since trajectory scoring is not applied in
                Delphi — the goal is convergence, not adversarial correctness).
                The final answer is the modal position in round 3, with the full
                distribution included in the task receipt.
            </p>

            {/* ── Anonymization ───────────────────────────────────────────────── */}
            <h2
                id="anonymization"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Anonymization as Conformity Prevention
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Li et al.'s finding that debate has a martingale property over
                agent belief trajectories is largely explained by conformity:
                agents shift toward positions associated with identifiable,
                high-volume, or high-confidence peers — not because those
                positions are better supported, but because the social signal is
                strong. Removing agent attribution from the feedback summary
                eliminates this social signal.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                In practice, anonymization is implemented at the summary
                generation step:
            </p>

            <ul
                className="list-disc list-inside text-sm leading-relaxed mb-6 space-y-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    Agent IDs are replaced with positional labels (
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        Agent A
                    </code>
                    ,{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        Agent B
                    </code>
                    , ...) and these labels are shuffled between rounds so
                    cross-round tracking is impossible
                </li>
                <li>
                    Model backbone identities are stripped — agents cannot infer
                    "GPT-4o said this" from stylistic cues in the summary
                    because the summary is generated by the orchestrator's own
                    LLM call, not by paraphrasing the original response
                </li>
                <li>
                    Confidence scores are included in the summary only as
                    aggregate statistics (mean, spread), not as per-agent values
                </li>
            </ul>

            <Callout type="tip" title="When anonymization matters most">
                Anonymization is most valuable when agent architectures differ
                significantly — e.g., a mixture of GPT-4o and Claude Sonnet
                agents. In same-backbone configurations, stylistic cues that
                could reveal identity are less likely to be recognizable to
                other agents of the same type, making the practical benefit
                smaller (though still present).
            </Callout>

            {/* ── Convergence ─────────────────────────────────────────────────── */}
            <h2
                id="convergence"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Convergence and Rounds
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Empirically across Agora's internal test suite, Delphi reaches
                stable convergence in{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    2–3 rounds
                </strong>{" "}
                for the majority of tasks. A 4th round adds minimal
                informational value: the position distribution typically shifts
                less than 5% of agents in round 4 vs. round 3, and those shifts
                are often reversals rather than meaningful convergence.
            </p>

            <div className="overflow-x-auto my-5 rounded-lg border border-[var(--border-default)]">
                <table className="w-full text-sm border-collapse">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            {[
                                "Round",
                                "Typical convergence",
                                "Recommendation",
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
                                "1 (generate)",
                                "No convergence — establishing prior positions",
                                "Always run",
                            ],
                            [
                                "2 (feedback)",
                                "Major shifts; 40–60% of outlier agents revise",
                                "Always run",
                            ],
                            [
                                "3 (revise)",
                                "Convergence; most tasks stabilize here",
                                "Always run",
                            ],
                            [
                                "4 (optional)",
                                "<5% additional shift; mainly reversals",
                                "Run only for highly contested tasks",
                            ],
                            [
                                "5+",
                                "Diminishing returns; risk of oscillation",
                                "Not recommended",
                            ],
                        ].map(([round, conv, rec]) => (
                            <tr key={round}>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px] font-mono"
                                    style={{ color: "var(--accent-emerald)" }}
                                >
                                    {round}
                                </td>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px]"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {conv}
                                </td>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px]"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {rec}
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
                Convergence is measured as the fraction of agents whose position
                changed between the last two rounds. When this fraction drops
                below 10%, the mechanism declares convergence even if the
                configured maximum round count has not been reached. This
                adaptive termination is analogous to the information-gain-based
                termination used in Factional Debate, but uses a simpler
                positional stability metric appropriate for Delphi's
                non-adversarial format.
            </p>

            {/* ── Selector Routing ────────────────────────────────────────────── */}
            <h2
                id="selector-routing"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                When the Selector Routes to Delphi
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The Mechanism Selector routes to Delphi when the task feature
                profile matches a specific pattern: high initial disagreement is
                expected <em>but</em> the topic is subjective rather than
                factual. This combination — agents likely to disagree, but no
                objectively correct answer to arbitrate — is where Delphi's
                structured convergence outperforms both the ISP signal (which
                requires an objectively correct minority) and Factional Debate
                (which risks entrenching positions rather than converging them).
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Concretely, the selector routes to Delphi when:
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
                        subjectivity
                    </code>{" "}
                    score is high ({">"} 0.6) — the task involves values,
                    aesthetics, policy preference, or open-ended creative output
                    where there is no ground truth
                </li>
                <li>
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        expected_disagreement
                    </code>{" "}
                    is high ({">"} 0.5) — agents are expected to hold
                    meaningfully different initial positions, making
                    single-round aggregation insufficient
                </li>
                <li>
                    The task is not time-sensitive — Delphi's multi-round
                    structure adds latency (typically 2–3× a single-round Vote
                    call)
                </li>
                <li>
                    Groupthink risk is high — tasks where a confident initial
                    response from one agent would anchor others in free debate,
                    but where the question deserves genuine deliberation
                </li>
            </ul>

            <Callout type="info" title="Delphi vs. Debate routing boundary">
                The key routing boundary between Delphi and Factional Debate is{" "}
                <strong>subjectivity</strong>. High subjectivity routes to
                Delphi (convergence without adversarial pressure). Low
                subjectivity with high disagreement routes to Debate
                (adversarial correction toward an objective answer). The
                selector's feature extraction and LLM reasoning wrapper jointly
                determine this classification.
            </Callout>
        </div>
    );
}
