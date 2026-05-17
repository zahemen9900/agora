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
                Agora is a tool-augmented multi-agent deliberation system. It
                selects between <strong style={{ color: "var(--text-primary)" }}>debate</strong>, <strong style={{ color: "var(--text-primary)" }}>vote</strong>,
                and <strong style={{ color: "var(--text-primary)" }}>delphi</strong>, can ground reasoning with search,
                URLs, files, and sandboxed Python, and returns auditable
                outputs with citations, evidence, telemetry, and Merkle-rooted
                receipts.
            </p>

            <Callout type="info" title="How to think about Agora">
                Agora is not just a prompt wrapper. The current product surface
                combines mechanism selection, multi-provider execution,
                tool-backed grounding, hosted task lifecycle APIs, benchmark
                runs, and receipt verification.
            </Callout>

            <h2
                id="what-you-can-do"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                What you can do today
            </h2>

            <ul
                className="text-sm leading-relaxed mb-6 space-y-3 pl-5 list-disc"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    Run hosted deliberation with Agora API keys and live task
                    streaming.
                </li>
                <li>
                    Run local BYOK deliberation with explicit Gemini,
                    Anthropic, and OpenRouter participant rosters.
                </li>
                <li>
                    Attach public URLs or hosted source files to a task.
                </li>
                <li>
                    Let agents use Brave search, URL analysis, PDF/image
                    analysis, and sandboxed Python.
                </li>
                <li>
                    Retrieve evidence items, citation metadata, model telemetry,
                    cost estimates, and Merkle-rooted receipts.
                </li>
                <li>
                    Launch and inspect hosted benchmark runs from the SDK.
                </li>
            </ul>

            <h2
                id="hosted-vs-local"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Hosted vs local
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div
                    className="rounded-xl border p-4"
                    style={{
                        borderColor: "var(--border-default)",
                        background: "var(--bg-elevated)",
                        borderLeft: "3px solid var(--accent-emerald)",
                    }}
                >
                    <h3
                        className="font-mono text-sm uppercase tracking-[0.08em] mb-2"
                        style={{ color: "var(--accent-emerald)" }}
                    >
                        Hosted SDK / API
                    </h3>
                    <p
                        className="text-sm leading-relaxed"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        Best when you need task persistence, live event streams,
                        uploads, source references, evidence surfaces, payment
                        lifecycle, and hosted benchmarks.
                    </p>
                </div>

                <div
                    className="rounded-xl border p-4"
                    style={{
                        borderColor: "var(--border-default)",
                        background: "var(--bg-elevated)",
                        borderLeft: "3px solid var(--accent-emerald)",
                    }}
                >
                    <h3
                        className="font-mono text-sm uppercase tracking-[0.08em] mb-2"
                        style={{ color: "var(--accent-emerald)" }}
                    >
                        Local BYOK SDK
                    </h3>
                    <p
                        className="text-sm leading-relaxed"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        Best when you want in-process orchestration, explicit
                        model rosters, direct LangGraph integration, or manual
                        embedding into your own CrewAI workflow without relying
                        on the hosted task lifecycle.
                    </p>
                </div>
            </div>

            <h2
                id="tool-stack"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Tool stack
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The current tool policy defaults are intentionally conservative:
                tools are enabled, but each agent is capped at{" "}
                <strong style={{ color: "var(--text-primary)" }}>4</strong>{" "}
                calls per task unless you override the policy. This keeps
                deliberation grounded without letting search or sandbox
                execution dominate the bill.
            </p>

            <ul
                className="text-sm leading-relaxed mb-6 space-y-2 pl-5 list-disc"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>Brave web search and URL-grounded synthesis</li>
                <li>OpenRouter-backed PDF and image analysis</li>
                <li>
                    Sandboxed Python with a real data stack: pandas, polars,
                    duckdb, pyarrow, spreadsheet readers, and standard analysis
                    libraries
                </li>
                <li>
                    Local text/code source inspection for attached files and
                    pre-registered source IDs
                </li>
            </ul>

            <h2
                id="quick-links"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Quick links
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
                <LinkCard
                    title="Quickstart"
                    description="Run your first hosted or local deliberation with the current SDK surface."
                    href="/docs/quickstart"
                />
                <LinkCard
                    title="Installation"
                    description="Install the SDK correctly, including extras and hosted/local setup."
                    href="/docs/installation"
                />
                <LinkCard
                    title="Python SDK"
                    description="Understand the real current SDK API: hosted tasks, local arbitration, benchmarks, and receipt verification."
                    href="/docs/sdk/python"
                />
                <LinkCard
                    title="API Reference"
                    description="See the current hosted REST surface, auth model, task payloads, and result shapes."
                    href="/docs/sdk/api-reference"
                />
            </div>
        </div>
    );
}
