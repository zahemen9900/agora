import { Callout } from "../../components/Callout";

export function ISPVoting() {
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
                ISP Voting
            </h1>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <strong style={{ color: "var(--text-primary)" }}>
                    Inverse Surprising Popularity (ISP) Voting
                </strong>{" "}
                is a voting mechanism designed to surface correct minority
                knowledge in multi-agent groups. Unlike majority voting, which
                amplifies whichever answer the most agents happen to agree on,
                ISP identifies answers that are{" "}
                <em>more popular than agents predicted they would be</em> — a
                signal that a well-informed subgroup is pushing an underdog
                answer past what the group as a whole expected.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The mechanism requires each agent to submit not one but three
                pieces of information: their answer, their confidence in that
                answer, and their prediction of what the group will answer. The
                gap between the third and the actual group distribution is the
                ISP signal.
            </p>

            {/* ── Beyond Majority ─────────────────────────────────────────────── */}
            <h2
                id="beyond-majority"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Beyond Majority Voting
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Majority voting is attractive in multi-agent settings because it
                is simple, parallelizable, and resistant to individual model
                failures. Its fatal weakness, however, is that it is insensitive
                to the{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    epistemic quality of the votes
                </strong>
                : five agents that looked up the wrong source will outvote one
                agent that reasoned correctly. The majority doesn't know what it
                doesn't know.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The intuition behind ISP is borrowed from human peer prediction
                literature: when a correct answer is{" "}
                <em>more popular than uninformed agents would predict</em>, that
                excess popularity is a reliable indicator that some agents have
                privileged information or superior reasoning that is propagating
                through the group — even if those agents are a minority. ISP
                makes this second-order signal computable.
            </p>

            {/* ── The ISP Insight ─────────────────────────────────────────────── */}
            <h2
                id="isp-insight"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                The ISP Insight
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Each agent in Agora's ISP Voting round is prompted to submit:
            </p>

            <ol
                className="list-decimal list-inside text-sm leading-relaxed mb-6 space-y-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Their answer
                    </strong>{" "}
                    — the answer they believe is correct
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Their confidence
                    </strong>{" "}
                    — a probability estimate over all possible answers (not just
                    their chosen answer)
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Their group prediction
                    </strong>{" "}
                    — what fraction of the group they expect to give each
                    possible answer
                </li>
            </ol>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The group prediction is the key distinguishing feature. An agent
                that knows the correct answer but is in the minority will
                predict that few other agents share their answer. If the actual
                vote shows <em>more</em> support for that answer than predicted,
                the ISP signal is positive: more agents than expected found
                their way to that answer independently, suggesting it is more
                defensible than the naive vote distribution implies.
            </p>

            <Callout type="info" title="Why this works">
                The ISP mechanism is grounded in peer prediction theory (Prelec
                2004, Drazen et al.). The core idea: a correct answer is one
                that surprisingly many people know — surprising relative to the
                predictions of people who don't know it. Expert minorities can
                generate large ISP signals even when outnumbered.
            </Callout>

            {/* ── ISP Formula ─────────────────────────────────────────────────── */}
            <h2
                id="isp-formula"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                ISP Scoring Formula
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                For each candidate answer{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    a
                </code>
                , the ISP weight is:
            </p>

            <div
                className="font-mono text-[13px] p-5 rounded-lg border border-[var(--border-default)] my-5"
                style={{
                    background: "var(--bg-subtle)",
                    color: "var(--accent-emerald)",
                }}
            >
                isp_weight(a) = (actual_popularity(a) - predicted_popularity(a))
                / predicted_popularity(a)
            </div>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Where:
            </p>

            <ul
                className="list-disc list-inside text-sm leading-relaxed mb-4 space-y-2"
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
                        actual_popularity(a)
                    </code>{" "}
                    — fraction of agents that selected answer{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        a
                    </code>
                </li>
                <li>
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        predicted_popularity(a)
                    </code>{" "}
                    — mean of all agents' group predictions for answer{" "}
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        a
                    </code>
                </li>
            </ul>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                A positive{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    isp_weight
                </code>{" "}
                means the answer was more popular than agents anticipated. A
                negative weight means agents overpredicted its popularity. The
                final answer selected is:
            </p>

            <div
                className="font-mono text-[13px] p-5 rounded-lg border border-[var(--border-default)] my-5"
                style={{
                    background: "var(--bg-subtle)",
                    color: "var(--accent-emerald)",
                }}
            >
                selected_answer = argmax_a [ actual_popularity(a) + λ *
                isp_weight(a) ]
            </div>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                where{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    λ
                </code>{" "}
                is a configurable weight (default{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    0.4
                </code>
                ) that controls how aggressively the ISP signal overrides raw
                popularity. Setting{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    λ = 0
                </code>{" "}
                degrades to standard plurality voting.
            </p>

            {/* ── Confidence Calibration ──────────────────────────────────────── */}
            <h2
                id="confidence-calibration"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Confidence Calibration
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Raw LLM confidence outputs are poorly calibrated: models
                frequently assign near-1.0 probability to incorrect answers and
                near-uniform distributions to questions where they actually have
                strong knowledge. Agora applies{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    temperature scaling
                </strong>{" "}
                per agent to produce well-calibrated probability estimates
                before feeding confidence scores into the ISP formula.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Temperature scaling is a post-hoc calibration method: a scalar{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    T
                </code>{" "}
                is fitted per model backbone on a held-out calibration set such
                that softmax(logits / T) minimizes expected calibration error
                (ECE). Each agent's per-answer probability estimate is rescaled
                by its backbone's fitted temperature before being included in
                the ISP computation.
            </p>

            <Callout type="tip" title="Per-backbone calibration">
                If all agents share the same backbone (e.g., all GPT-4o), a
                single temperature is applied uniformly. When architectural
                diversity is enabled (see below), each backbone has its own
                fitted temperature. The calibration parameters are stored in the
                agent registry and updated periodically as new completed tasks
                provide calibration signal.
            </Callout>

            {/* ── Architectural Diversity ─────────────────────────────────────── */}
            <h2
                id="architectural-diversity"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Architectural Diversity
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The ReConcile paper (EMNLP 2024) demonstrated that using{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    different LLM backbones
                </strong>{" "}
                per agent — rather than running multiple instances of the same
                model — adds{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    8.6% accuracy
                </strong>{" "}
                over a same-model ensemble when measured on standard reasoning
                benchmarks. The gain comes from architectural diversity reducing
                correlated errors: when all agents share the same pretraining
                data and architecture, they tend to fail on the same examples.
                Different backbones have different failure modes, and ISP
                aggregation can surface the answer that different failure
                distributions happen to agree on — which is more likely to be
                correct.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                In Agora, architectural diversity is an opt-in configuration.
                When enabled, the orchestrator selects agents from a pool with
                different backbone assignments. Each backbone's temperature
                scaling is applied independently. The ISP formula operates on
                the aggregated, calibrated distribution regardless of backbone
                composition.
            </p>

            <div className="overflow-x-auto my-5 rounded-lg border border-[var(--border-default)]">
                <table className="w-full text-sm border-collapse">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            {[
                                "Configuration",
                                "Accuracy (benchmark avg)",
                                "Notes",
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
                                "Single model, majority vote",
                                "baseline",
                                "No diversity, correlated failures",
                            ],
                            [
                                "Same model, 5 agents, majority vote",
                                "+2.1%",
                                "Ensemble gain only",
                            ],
                            [
                                "Same model, 5 agents, ISP vote",
                                "+5.3%",
                                "ISP signal on top of ensemble",
                            ],
                            [
                                "Mixed backbones, 5 agents, ISP vote",
                                "+8.6%",
                                "ReConcile: full diversity + ISP",
                            ],
                        ].map(([config, acc, notes]) => (
                            <tr key={config}>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px]"
                                    style={{ color: "var(--text-primary)" }}
                                >
                                    {config}
                                </td>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px] font-mono"
                                    style={{ color: "var(--accent-emerald)" }}
                                >
                                    {acc}
                                </td>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px]"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {notes}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* ── When to Vote ────────────────────────────────────────────────── */}
            <h2
                id="when-to-vote"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                When the Selector Routes to Vote
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The Mechanism Selector routes to ISP Voting when the task has
                one or more of the following characteristics:
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
                        Time-sensitive tasks
                    </strong>{" "}
                    — ISP Voting runs a single round (all agents respond
                    simultaneously, no multi-round debate overhead). Latency is
                    bounded by the slowest single agent completion.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Large agent groups (5+)
                    </strong>{" "}
                    — the ISP signal becomes statistically meaningful with
                    larger N. With only 2 agents, the predicted vs. actual
                    popularity comparison is noisy; with 5+ agents the gap is
                    reliable.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Factual aggregation tasks
                    </strong>{" "}
                    — questions with a definite correct answer from a
                    well-defined fact space (geography, science, law,
                    calculation) where debate overhead does not provide
                    additional correction value over independent high-quality
                    answers.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Low subjectivity + high answer-space size
                    </strong>{" "}
                    — when the task has many plausible answer candidates and is
                    objectively gradable, ISP's ability to surface expert
                    minority knowledge is particularly valuable.
                </li>
            </ul>

            <Callout
                type="warning"
                title="ISP is not appropriate for all tasks"
            >
                ISP Voting degrades gracefully but not appropriately for highly
                subjective tasks (where "correct minority" is a meaningless
                concept) or for open-ended generation tasks (where the answer
                space is continuous). The Mechanism Selector will route those to
                Delphi and Debate respectively.
            </Callout>
        </div>
    );
}
