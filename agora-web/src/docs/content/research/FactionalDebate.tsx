import { Callout } from "../../components/Callout";

export function FactionalDebate() {
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
                Factional Debate
            </h1>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <strong style={{ color: "var(--text-primary)" }}>
                    Factional Debate
                </strong>{" "}
                is Agora's structured argumentation mechanism. Rather than
                allowing agents to freely agree or disagree, it assigns agents
                to opposing factions before exposing them to the question, adds
                a Devil's Advocate cross-examiner, locks verified claims so they
                cannot be retroactively contradicted, and terminates the debate
                adaptively when additional rounds stop generating new
                information.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The mechanism is routed to by the Mechanism Selector for tasks
                with high{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    complexity_score
                </code>{" "}
                and high{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    expected_disagreement
                </code>{" "}
                — typically adversarial reasoning, multi-step inference, or
                tasks where a correct minority position must be surfaced against
                a plausible majority.
            </p>

            {/* ── The Martingale Problem ──────────────────────────────────────── */}
            <h2
                id="the-martingale-problem"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                The Martingale Problem: Why Naive Debate Fails
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Li et al.,{" "}
                <em>
                    "Debate or Vote? Benchmarking Multi-Agent Deliberation
                    Mechanisms for LLM Reasoning"
                </em>
                , NeurIPS 2025 Spotlight, demonstrated that unguided debate —
                where agents see each other's responses and freely update — has
                a{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    martingale property
                </strong>{" "}
                over agent belief trajectories. Specifically, in expectation,
                the belief of any agent after observing peer responses is equal
                to its belief before: debate rounds are not corrective, they are
                noise. The apparent gains attributed to debate in prior
                benchmarks were largely ensemble effects — averaging multiple
                independent samples from similar models — not genuine
                adversarial correction.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The core failure mode is{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    conformity bias
                </strong>
                : when agents observe that their peers hold a position, they
                tend to shift toward it regardless of evidential merit. In free
                debate, this creates a feedback loop where the first agent to
                state a position confidently can anchor the entire group —
                independent of correctness.
            </p>

            <Callout type="warning" title="Implementation implication">
                Any debate implementation that shows agents each other's full
                responses before they commit their own is susceptible to
                conformity bias. Agora addresses this through faction
                pre-assignment and state locking, described below.
            </Callout>

            {/* ── Factional Assignment ────────────────────────────────────────── */}
            <h2
                id="factional-assignment"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Factional Assignment
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Agora assigns agents to{" "}
                <strong style={{ color: "var(--text-primary)" }}>pro</strong>{" "}
                and{" "}
                <strong style={{ color: "var(--text-primary)" }}>con</strong>{" "}
                factions <em>before</em> the question is revealed. The
                assignment is made by the orchestrator based on a coin flip per
                agent; the specific topic is then injected into the system
                prompt with faction context already set.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                This pre-assignment has two critical effects:
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
                        Eliminates implicit conformity
                    </strong>{" "}
                    — agents cannot observe the group's modal position before
                    forming their own, because their role is locked before the
                    question appears.
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Guarantees adversarial coverage
                    </strong>{" "}
                    — at least one agent is obligated to argue the minority
                    position regardless of initial model priors. This surfaces
                    counterarguments that homogeneous ensembles suppress.
                </li>
            </ul>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                This design extends FREE-MAD (discussed in the Comparison
                section), which also forces factional roles but does not include
                the Devil's Advocate or state locking components that Agora
                adds.
            </p>

            {/* ── Devil's Advocate ────────────────────────────────────────────── */}
            <h2
                id="devils-advocate"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Devil's Advocate Cross-Examination
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                A third agent — the{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    Devil's Advocate (DA)
                </strong>{" "}
                — is assigned to neither faction. Its role is to cross-examine
                both factions' arguments after each exchange round, with the
                explicit goal of forcing contradiction exposure. The DA:
            </p>

            <ul
                className="list-disc list-inside text-sm leading-relaxed mb-6 space-y-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    Identifies internal contradictions within each faction's
                    argument chain
                </li>
                <li>
                    Points out cases where a faction has implicitly conceded a
                    point while maintaining their stated position
                </li>
                <li>
                    Raises hypothetical counterexamples that stress-test both
                    factions' reasoning, not just the opposing faction
                </li>
                <li>
                    Does <em>not</em> advocate for a final answer — the DA's
                    output feeds the scoring stage but is not itself scored
                </li>
            </ul>

            <Callout type="info" title="DA prompt structure">
                The DA receives the full argument history from both factions but
                no faction identity labels. It sees pro arguments and con
                arguments as two anonymous streams. This prevents the DA from
                simply siding with the faction that produced more output.
            </Callout>

            {/* ── State Locking ───────────────────────────────────────────────── */}
            <h2
                id="state-locking"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                MAD-Oracle State Locking
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Inspired by the MAD-Oracle approach, Agora implements{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    claim-level state locking
                </strong>
                : when an agent makes a claim that is verifiably correct —
                either by external tool call (calculator, code execution,
                knowledge base lookup) or by unanimous DA + opposing faction
                acknowledgment — that claim is{" "}
                <strong style={{ color: "var(--text-primary)" }}>locked</strong>{" "}
                in the debate state.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                A locked claim cannot be contradicted by subsequent agent turns
                without providing affirmative counter-evidence. If an agent
                attempts to contradict a locked claim without evidence, the
                orchestrator:
            </p>

            <ol
                className="list-decimal list-inside text-sm leading-relaxed mb-6 space-y-1"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>Flags the turn as an unsupported contradiction</li>
                <li>
                    Reduces that agent's trajectory score for the round (see
                    Trajectory-Aware Scoring)
                </li>
                <li>
                    Appends the locked claim to the context with explicit
                    notation that it is immutable
                </li>
            </ol>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                State locking prevents the common failure pattern where a
                dominant agent re-asserts a false claim in round N+1 to undo a
                correct counter-argument made in round N. It forces the debate
                to make monotone progress on established facts even while
                contested claims remain open.
            </p>

            {/* ── Adaptive Termination ────────────────────────────────────────── */}
            <h2
                id="adaptive-termination"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                MACI Adaptive Termination
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Debate rounds continue until the mid-execution monitor
                determines that additional rounds are not producing new
                information. The termination condition (borrowed from the MACI
                framework's active controversy detection approach) is:
            </p>

            <div
                className="font-mono text-[13px] p-4 rounded-lg border border-[var(--border-default)] my-5 text-center"
                style={{
                    background: "var(--bg-subtle)",
                    color: "var(--accent-emerald)",
                }}
            >
                information_gain_delta &lt; θ for 2 consecutive rounds
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
                    θ
                </code>{" "}
                defaults to 0.05 and{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    information_gain_delta
                </code>{" "}
                is measured as the KL divergence between the agent position
                distribution in round N versus round N-1. A two-round grace
                period prevents premature termination during brief lulls in
                argument quality.
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Early termination has a concrete cost benefit: each debate round
                across a 5-agent group adds approximately N × (prompt +
                completion tokens). For tasks where 3 rounds suffice,
                terminating at round 3 instead of running a fixed 5-round
                schedule reduces token cost by 40% with no accuracy loss.
            </p>

            {/* ── Trajectory Scoring ──────────────────────────────────────────── */}
            <h2
                id="trajectory-scoring"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Trajectory-Aware Scoring
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The final answer is not simply the position held by the most
                agents in the last round. Agora weights each agent's
                contribution by its{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    argument trajectory score
                </strong>{" "}
                — a function of:
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
                        Claim accuracy rate
                    </strong>{" "}
                    — what fraction of verifiable claims made by this agent were
                    confirmed correct vs. flagged as unsupported
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        State-lock contribution
                    </strong>{" "}
                    — how many locked claims were first introduced by this agent
                    (positive signal)
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Unsupported contradiction count
                    </strong>{" "}
                    — how many times this agent attempted to contradict locked
                    claims without evidence (negative signal)
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        DA cross-examination survival
                    </strong>{" "}
                    — how many of this agent's arguments survived DA challenge
                    without being flagged as internally contradictory
                </li>
            </ul>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                This scoring rewards agents that built{" "}
                <em>
                    epistemically sound argument chains over the full debate
                </em>
                , not agents that simply stated a confident final position. An
                agent that stated a correct answer in round 1 but then made
                contradictory claims in rounds 2 and 3 receives a lower
                trajectory score than an agent that consistently built toward
                the correct position.
            </p>

            {/* ── Comparison ──────────────────────────────────────────────────── */}
            <h2
                id="comparison"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Comparison: FREE-MAD and ACC-Debate
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Agora's Factional Debate builds on two prior systems. The table
                below summarizes the feature comparison across the three
                approaches:
            </p>

            <div className="overflow-x-auto my-5 rounded-lg border border-[var(--border-default)]">
                <table className="w-full text-sm border-collapse">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            {[
                                "Feature",
                                "FREE-MAD",
                                "ACC-Debate",
                                "Agora Factional Debate",
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
                                "Factional role assignment",
                                "✓ Pre-assigned factions",
                                "✗ Free assignment",
                                "✓ Pre-assigned before question reveal",
                            ],
                            [
                                "Devil's Advocate role",
                                "✗ Not present",
                                "✗ Not present",
                                "✓ Dedicated DA cross-examines both factions",
                            ],
                            [
                                "State locking",
                                "✗ Not present",
                                "✗ Not present",
                                "✓ MAD-Oracle verified claim locking",
                            ],
                            [
                                "Adaptive termination",
                                "✗ Fixed round count",
                                "✓ Active controversy detection",
                                "✓ Entropy + information-gain threshold (MACI-style)",
                            ],
                            [
                                "Trajectory scoring",
                                "✗ Final position only",
                                "✗ Final position only",
                                "✓ Full argument trajectory weighted score",
                            ],
                            [
                                "On-chain audit",
                                "✗ Not present",
                                "✗ Not present",
                                "✓ Every argument hashed into Merkle tree",
                            ],
                        ].map((row) => (
                            <tr key={row[0]}>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px] font-mono"
                                    style={{ color: "var(--text-primary)" }}
                                >
                                    {row[0]}
                                </td>
                                {row.slice(1).map((cell, i) => (
                                    <td
                                        key={i}
                                        className="px-4 py-3 border-t border-[var(--border-default)] text-[13px]"
                                        style={{
                                            color: "var(--text-secondary)",
                                        }}
                                    >
                                        {cell}
                                    </td>
                                ))}
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
                ACC-Debate's active controversy detection — which routes debate
                only to genuinely contested claims — is analogous to Agora's
                entropy monitoring, but implemented at the task selection level
                rather than mid-execution. Agora monitors entropy during
                execution, enabling finer-grained switching: a task that appears
                uncontroversial may develop genuine disagreement mid-debate, and
                Agora can respond by continuing or escalating the mechanism.
            </p>
        </div>
    );
}
