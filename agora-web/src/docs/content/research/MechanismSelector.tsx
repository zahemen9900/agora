import { CodeBlock } from "../../components/CodeBlock";
import { Callout } from "../../components/Callout";

const thompsonCode = `import numpy as np

class ThompsonSamplingBandit:
    def __init__(self, mechanisms: list[str]):
        self.alpha = {m: 1.0 for m in mechanisms}  # Beta prior α
        self.beta  = {m: 1.0 for m in mechanisms}  # Beta prior β

    def select(self, task_category: str) -> str:
        samples = {m: np.random.beta(self.alpha[m], self.beta[m])
                   for m in self.alpha}
        return max(samples, key=samples.get)

    def update(self, mechanism: str, reward: float):
        self.alpha[mechanism] += reward
        self.beta[mechanism]  += (1 - reward)


# Usage example
bandit = ThompsonSamplingBandit(["debate", "vote", "delphi", "moa"])

# Select mechanism for a task
selected = bandit.select(task_category="factual_qa")
print(f"Selected: {selected}")

# After task completes, update with binary reward
bandit.update(mechanism=selected, reward=1.0)  # 1.0 = solved, 0.0 = failed`;

const monitorCode = `def check_switch_condition(
    history: list[dict],
    entropy_threshold: float = 0.1,
    gain_threshold: float = 0.05,
) -> bool:
    """
    Returns True if a mechanism switch should be triggered.
    Condition: entropy rising AND info_gain_delta < threshold
    for 2 consecutive rounds.
    """
    if len(history) < 2:
        return False

    last_two = history[-2:]
    entropy_rising = all(
        r["disagreement_entropy"] > r_prev["disagreement_entropy"]
        for r, r_prev in zip(last_two[1:], last_two)
    )
    gain_stalled = all(
        r["information_gain_delta"] < gain_threshold
        for r in last_two
    )
    return entropy_rising and gain_stalled`;

export function MechanismSelector() {
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
                Mechanism Selector
            </h1>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    Mechanism Selector
                </strong>{" "}
                is the meta-level decision component that runs before any
                deliberation begins. Its job is to examine the incoming task and
                choose the mechanism — Debate, Vote, Delphi, or MoA — most
                likely to produce a correct, efficient outcome given the task's
                characteristics. It combines a Thompson Sampling contextual
                bandit (for data-driven exploration) with an LLM reasoning agent
                (for structured justification) and a mid-execution monitor (for
                adaptive switching).
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Critically, the selector's chain-of-thought justification is
                SHA-256 hashed and committed on-chain before the deliberation
                starts. This means the mechanism choice is locked in and
                auditable — the system cannot retroactively claim it always
                intended to use a different mechanism.
            </p>

            {/* ── Thompson Sampling ───────────────────────────────────────────── */}
            <h2
                id="thompson-sampling"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Thompson Sampling Basics
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Thompson Sampling is a Bayesian algorithm for the multi-armed
                bandit problem. For each mechanism, the bandit maintains a{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    Beta(α, β) posterior
                </strong>{" "}
                over its success probability. At selection time, it draws one
                sample from each posterior and picks the mechanism with the
                highest sample. This naturally balances{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    exploration
                </strong>{" "}
                (mechanisms with high uncertainty get sampled widely) and{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    exploitation
                </strong>{" "}
                (mechanisms with consistently high α get selected more often).
            </p>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Agora maintains separate Beta posteriors per{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    (mechanism, task_category)
                </code>{" "}
                pair — not a single global posterior. This means the bandit
                learns that Debate works well for adversarial legal questions
                while Vote works better for factual retrieval, without
                conflating the two contexts.
            </p>

            <CodeBlock
                code={thompsonCode}
                language="python"
                filename="selector/thompson_bandit.py"
            />

            <Callout type="info" title="Prior initialization">
                Both α and β are initialized to 1.0, which gives a uniform
                Beta(1,1) prior — equivalent to no prior preference. As tasks
                complete, posteriors converge toward mechanisms that actually
                solve the task category.
            </Callout>

            {/* ── Task Features ───────────────────────────────────────────────── */}
            <h2
                id="task-features"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Task Feature Extraction
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Before the bandit samples, the incoming task is featurized. Four
                features are extracted and used to select the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    task_category
                </code>{" "}
                that indexes into the bandit's posterior map:
            </p>

            <div className="overflow-x-auto my-5 rounded-lg border border-[var(--border-default)]">
                <table className="w-full text-sm border-collapse">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            {["Feature", "Range", "High value → favors"].map(
                                (h) => (
                                    <th
                                        key={h}
                                        className="text-left px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.07em]"
                                        style={{
                                            color: "var(--text-tertiary)",
                                        }}
                                    >
                                        {h}
                                    </th>
                                ),
                            )}
                        </tr>
                    </thead>
                    <tbody>
                        {[
                            [
                                "complexity_score",
                                "0 – 1",
                                "Debate (multi-step reasoning benefits from argument)",
                            ],
                            [
                                "subjectivity",
                                "0 – 1",
                                "Delphi (values-laden tasks require anonymous iteration)",
                            ],
                            [
                                "answer_space_size",
                                "integer",
                                "Vote (large answer spaces handled by ISP aggregation)",
                            ],
                            [
                                "expected_disagreement",
                                "0 – 1",
                                "Debate or Delphi (disagreement warrants deliberation)",
                            ],
                        ].map(([feature, range, favor]) => (
                            <tr key={feature}>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px] font-mono"
                                    style={{ color: "var(--accent-emerald)" }}
                                >
                                    {feature}
                                </td>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px] font-mono"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {range}
                                </td>
                                <td
                                    className="px-4 py-3 border-t border-[var(--border-default)] text-[13px]"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {favor}
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
                Features are extracted by a lightweight classifier that runs on
                the task prompt before the reasoning agent produces its
                justification. The feature vector is not passed to the LLM
                directly — the LLM sees the raw task and produces its own
                assessment, which is then reconciled with the bandit's sample to
                produce the final selection.
            </p>

            {/* ── LLM Reasoning Wrapper ───────────────────────────────────────── */}
            <h2
                id="llm-reasoning"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                LLM Reasoning Wrapper
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The Thompson Sampling bandit provides a statistically grounded
                mechanism ranking, but it cannot articulate <em>why</em> a
                mechanism was chosen — which matters for auditability. Wrapping
                the bandit is an LLM reasoning agent that:
            </p>

            <ol
                className="list-decimal list-inside text-sm leading-relaxed mb-6 space-y-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    Receives the task text and the bandit's ranked mechanism
                    list (with sampled values)
                </li>
                <li>
                    Produces a{" "}
                    <strong style={{ color: "var(--text-primary)" }}>
                        chain-of-thought justification
                    </strong>{" "}
                    explaining why the top-ranked mechanism is appropriate for
                    this specific task
                </li>
                <li>
                    May override the bandit's top choice if its reasoning
                    identifies a strong contraindication (e.g., the bandit
                    sampled Vote but the task is clearly values-laden and
                    requires Delphi)
                </li>
                <li>
                    Outputs the final mechanism selection as a structured JSON
                    object containing the chosen mechanism, confidence, and the
                    full CoT text
                </li>
            </ol>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The CoT JSON object is then SHA-256 hashed. This hash is
                submitted to the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    record_mechanism_selection
                </code>{" "}
                on-chain instruction as{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    selector_reasoning_hash
                </code>
                . The full CoT text is stored in GCS, verifiable against the
                on-chain hash.
            </p>

            <Callout type="warning" title="Override frequency">
                LLM overrides of the bandit's top sample should be rare as the
                system accumulates experience. A high override rate (more than
                ~15% of tasks) is a signal that the bandit's task categorization
                is misaligned with how the LLM perceives task types —
                investigate the feature extractor.
            </Callout>

            {/* ── Mid-Execution Monitor ───────────────────────────────────────── */}
            <h2
                id="mid-execution"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Mid-Execution Checkpoints
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Mechanism selection does not end when the deliberation starts.
                The{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    mid-execution state monitor
                </strong>{" "}
                runs after each deliberation round and evaluates two signals:
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
                        disagreement_entropy
                    </code>{" "}
                    — Shannon entropy over agent position distribution. Rising
                    entropy means agents are diverging rather than converging.
                </li>
                <li>
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        information_gain_delta
                    </code>{" "}
                    — marginal information contributed by the last round
                    relative to the round before. Near-zero delta means the
                    mechanism has stopped producing new signal.
                </li>
            </ul>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                A switch is triggered when{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    both conditions hold for 2 consecutive rounds
                </strong>
                : entropy is rising AND information gain is below threshold.
                Single-round dips are tolerated to avoid premature switches
                caused by natural mid-debate volatility.
            </p>

            <CodeBlock
                code={monitorCode}
                language="python"
                filename="orchestrator/monitor.py"
            />

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                When a switch is triggered, the monitor logs its rationale to
                GCS and calls{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    record_mechanism_switch
                </code>{" "}
                on-chain with the SHA-256 hash of that rationale. The
                deliberation then resumes using the new mechanism, inheriting
                the partial progress from the prior rounds.
            </p>

            {/* ── Reward Loop ──────────────────────────────────────────────────── */}
            <h2
                id="reward-loop"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Reward Loop
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                After a task completes, the bandit receives a{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    binary reward signal
                </strong>
                :
            </p>

            <ul
                className="list-disc list-inside text-sm leading-relaxed mb-4 space-y-1"
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
                        reward = 1.0
                    </code>{" "}
                    — quorum reached, task completed, payment released
                </li>
                <li>
                    <code
                        className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                        style={{
                            background: "var(--bg-subtle)",
                            color: "var(--accent-emerald)",
                        }}
                    >
                        reward = 0.0
                    </code>{" "}
                    — task failed (no quorum, timeout, or mechanism switch
                    exhausted retries)
                </li>
            </ul>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The reward updates both{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    alpha[mechanism]
                </code>{" "}
                and{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    beta[mechanism]
                </code>{" "}
                for the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    task_category
                </code>{" "}
                that was active. If a mechanism switch occurred mid-task, the
                reward is attributed to the <em>final</em> mechanism used, since
                that is the one that determined task outcome. The switched-away
                mechanism receives no update for that task.
            </p>

            <Callout type="tip" title="Cold-start behavior">
                With only a handful of tasks per category, the Beta posteriors
                remain wide and the bandit explores aggressively. This is the
                intended behavior — the system needs diverse mechanism exposure
                early. Exploitation dominates only after approximately 20–30
                completions per category, at which point posterior variance has
                tightened sufficiently.
            </Callout>

            {/* ── Research Foundation ─────────────────────────────────────────── */}
            <h2
                id="papers"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Research Foundation
            </h2>

            <h3
                id="papers-barp"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                BaRP (2025)
            </h3>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The BaRP paper demonstrates that a bandit-based mechanism router
                achieves a{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                    12.46% improvement
                </strong>{" "}
                over offline classifiers trained on static mechanism-task
                mappings. The key insight is that offline classifiers cannot
                adapt to distribution shift — as task characteristics evolve
                over time, a static mapping degrades. The bandit's online
                posterior updates maintain performance as the task distribution
                changes. Agora's selector is directly inspired by the BaRP
                architecture, extending it with the LLM reasoning wrapper and
                on-chain commitment.
            </p>

            <h3
                id="papers-coconama"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                CoCoMaMa
            </h3>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                CoCoMaMa addresses the extensibility problem: how to add new
                mechanisms to the router without retraining the entire selector
                model. It treats mechanism addition as a cold-start bandit arm —
                new mechanisms begin with uniform Beta(1,1) priors and
                accumulate reward signal as they are tried. This is precisely
                how Agora handles new mechanism plugins: no retraining, no model
                update, just a new arm added to the bandit with default priors.
            </p>
        </div>
    );
}
