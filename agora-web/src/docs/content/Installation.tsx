import { CodeBlock } from "../components/CodeBlock";
import { Callout } from "../components/Callout";

const pipInstall = `pip install agora-sdk`;

const pipLangGraph = `pip install "agora-sdk[langgraph]"`;

const pipCrewAI = `pip install "agora-sdk[crewai]"`;

const pipAll = `pip install "agora-sdk[all]"`;

const sourceInstall = `# 1. Clone the repository
git clone https://github.com/agora-protocol/agora-sdk.git
cd agora-sdk

# 2. Create a virtual environment (requires uv)
uv venv .venv
source .venv/bin/activate   # Windows: .venv\\Scripts\\activate

# 3. Install in editable mode with dev dependencies
uv pip install -e ".[dev]"`;

const envFile = `# .env — add to your project root (never commit this file)

# Required: Agora API endpoint
AGORA_API_URL=https://agora-api-b4auawqzbq-uc.a.run.app

# Required for on-chain features: Helius RPC URL (get one at helius.dev)
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Optional: Solana network (mainnet-beta | devnet | localnet)
SOLANA_NETWORK=devnet

# Optional: GCP project ID (for internal Cloud Run deployments)
GOOGLE_CLOUD_PROJECT=your-gcp-project-id`;

const envLoad = `from dotenv import load_dotenv
import os

load_dotenv()

from agora.sdk import AgoraArbitrator

arbitrator = AgoraArbitrator(
    api_url=os.environ["AGORA_API_URL"],
)`;

const dockerCompose = `# docker-compose.yml
services:
  agora-dev:
    image: python:3.11-slim
    working_dir: /app
    volumes:
      - .:/app
    environment:
      - AGORA_API_URL=https://agora-api-b4auawqzbq-uc.a.run.app
      - SOLANA_NETWORK=devnet
    command: pip install agora-sdk && python main.py`;

const verifyInstall = `python -c "from agora.sdk import AgoraArbitrator; print('agora-sdk OK')"`;

export function Installation() {
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
                Installation
            </h1>

            <p
                className="text-base leading-relaxed mb-6"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The Agora Python SDK is published to PyPI as{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    agora-sdk
                </code>
                . It supports both a minimal core install and optional extras
                for LangGraph and CrewAI integrations.
            </p>

            {/* ── Requirements ──────────────────────────────────────────────── */}
            <h2
                id="requirements"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Requirements
            </h2>

            <div className="overflow-x-auto my-5 rounded-lg border border-[var(--border-default)]">
                <table className="w-full text-sm border-collapse">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            <th
                                className="text-left px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.07em]"
                                style={{ color: "var(--text-tertiary)" }}
                            >
                                Dependency
                            </th>
                            <th
                                className="text-left px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.07em]"
                                style={{ color: "var(--text-tertiary)" }}
                            >
                                Version
                            </th>
                            <th
                                className="text-left px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.07em]"
                                style={{ color: "var(--text-tertiary)" }}
                            >
                                Notes
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {[
                            {
                                dep: "Python",
                                ver: "≥ 3.11",
                                note: "Required. 3.12 recommended.",
                            },
                            {
                                dep: "pip / uv",
                                ver: "Any",
                                note: "uv recommended for speed.",
                            },
                            {
                                dep: "Agora API URL",
                                ver: "—",
                                note: "Provided — see env setup below.",
                            },
                            {
                                dep: "Helius RPC URL",
                                ver: "—",
                                note: "Optional; required for on-chain verification.",
                            },
                            {
                                dep: "Solana wallet",
                                ver: "—",
                                note: "Optional; required for staked arbitration.",
                            },
                        ].map(({ dep, ver, note }) => (
                            <tr
                                key={dep}
                                className="border-t border-[var(--border-default)]"
                            >
                                <td
                                    className="px-4 py-3 font-mono text-[13px]"
                                    style={{ color: "var(--accent-emerald)" }}
                                >
                                    {dep}
                                </td>
                                <td
                                    className="px-4 py-3 font-mono text-[12px]"
                                    style={{ color: "var(--text-secondary)" }}
                                >
                                    {ver}
                                </td>
                                <td
                                    className="px-4 py-3 text-[13px]"
                                    style={{
                                        fontFamily:
                                            "'Hanken Grotesk', sans-serif",
                                        color: "var(--text-secondary)",
                                    }}
                                >
                                    {note}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* ── Install from PyPI ─────────────────────────────────────────── */}
            <h2
                id="install-from-pypi"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Install from PyPI
            </h2>

            <h3
                id="core"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                Core (no extras)
            </h3>

            <p
                className="text-sm leading-relaxed mb-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Installs{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    AgoraArbitrator
                </code>
                ,{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    AgoraNode
                </code>
                , and all verification utilities. Sufficient for the quickstart
                and most production use cases.
            </p>
            <CodeBlock code={pipInstall} language="bash" />

            <h3
                id="with-langgraph"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                With LangGraph support
            </h3>
            <p
                className="text-sm leading-relaxed mb-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Adds{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    langgraph
                </code>{" "}
                and{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    langchain-core
                </code>{" "}
                as dependencies, enabling the{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    AgoraNode
                </code>{" "}
                StateGraph integration.
            </p>
            <CodeBlock code={pipLangGraph} language="bash" />

            <h3
                id="with-crewai"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                With CrewAI support
            </h3>
            <p
                className="text-sm leading-relaxed mb-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Adds{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    crewai
                </code>{" "}
                and exposes{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    AgoraCrewAITool
                </code>{" "}
                for use as a native CrewAI tool.
            </p>
            <CodeBlock code={pipCrewAI} language="bash" />

            <h3
                id="all-extras"
                className="text-lg font-mono font-semibold mt-6 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                All extras
            </h3>
            <CodeBlock code={pipAll} language="bash" />

            {/* ── From source ───────────────────────────────────────────────── */}
            <h2
                id="from-source"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Install from Source
            </h2>

            <p
                className="text-sm leading-relaxed mb-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Use this path if you want to contribute to the SDK, inspect
                internals, or pin to a specific commit. The project uses{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    uv
                </code>{" "}
                for dependency management — install it with{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    pip install uv
                </code>{" "}
                first.
            </p>

            <CodeBlock code={sourceInstall} language="bash" />

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
                    dev
                </code>{" "}
                extra includes{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    pytest
                </code>
                ,{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    ruff
                </code>
                , and{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    mypy
                </code>{" "}
                for linting, type-checking, and running the test suite.
            </p>

            {/* ── Environment setup ─────────────────────────────────────────── */}
            <h2
                id="environment-setup"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Environment Setup
            </h2>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Create a{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    .env
                </code>{" "}
                file in your project root with the following variables. Never
                commit this file — add it to{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    .gitignore
                </code>
                .
            </p>

            <CodeBlock code={envFile} language="bash" filename=".env" />

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Load the variables in your application with{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    python-dotenv
                </code>{" "}
                (
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    pip install python-dotenv
                </code>
                ):
            </p>

            <CodeBlock code={envLoad} language="python" />

            <Callout type="info" title="Docker local development">
                If you prefer running Agora inside Docker, you can pass the
                environment variables via your{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    docker-compose.yml
                </code>{" "}
                without any code changes:
                <div className="mt-3">
                    <CodeBlock
                        code={dockerCompose}
                        language="yaml"
                        filename="docker-compose.yml"
                    />
                </div>
                The SDK reads all configuration from environment variables — no
                config files or constructor arguments are required when the
                environment is set up correctly.
            </Callout>

            {/* ── Verify the install ────────────────────────────────────────── */}
            <h2
                id="verify-installation"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Verify the Installation
            </h2>

            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Run the following one-liner to confirm the SDK installed
                correctly:
            </p>

            <CodeBlock code={verifyInstall} language="bash" />

            <p
                className="text-sm leading-relaxed"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                If you see{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    agora-sdk OK
                </code>
                , you're ready. Head to the{" "}
                <a
                    href="/docs/quickstart"
                    style={{ color: "var(--accent-emerald)" }}
                >
                    Quickstart
                </a>{" "}
                to run your first arbitration.
            </p>
        </div>
    );
}
