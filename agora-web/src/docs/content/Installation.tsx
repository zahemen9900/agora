import { CodeBlock } from "../components/CodeBlock";
import { Callout } from "../components/Callout";

const pipInstall = `pip install agora-arbitrator-sdk`;

const pipLangGraph = `pip install "agora-arbitrator-sdk[langgraph]"`;

const pipCrewAI = `pip install "agora-arbitrator-sdk[crewai]"`;

const pipAll = `pip install "agora-arbitrator-sdk[langgraph,crewai]"`;

const sourceInstall = `git clone https://github.com/zahemen9900/agora.git
cd agora

python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"`;

const hostedExample = `from agora.sdk import AgoraArbitrator

arbitrator = AgoraArbitrator(
    auth_token="agora_live_xxxxx.yyyyy",
)`;

const localExample = `from agora.sdk import AgoraArbitrator
from agora.types import LocalModelSpec, LocalProviderKeys

arbitrator = AgoraArbitrator(
    local_models=[
        LocalModelSpec(provider="gemini", model="gemini-3.1-flash-lite-preview"),
        LocalModelSpec(provider="anthropic", model="claude-sonnet-4-6"),
        LocalModelSpec(provider="openrouter", model="qwen/qwen3.5-flash-02-23"),
        LocalModelSpec(provider="gemini", model="gemini-3-flash-preview"),
    ],
    local_provider_keys=LocalProviderKeys(
        gemini_api_key="...",
        anthropic_api_key="...",
        openrouter_api_key="...",
    ),
)`;

const overrideEnv = `# Optional only if you intentionally want a non-canonical backend.
export AGORA_ALLOW_API_URL_OVERRIDE=1
export AGORA_API_URL=https://your-custom-hosted-endpoint`;

const verifyInstall = `python -c "from agora.sdk import AgoraArbitrator; print('agora-arbitrator-sdk OK')"`;

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
                className="text-base leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The published Python package is{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    agora-arbitrator-sdk
                </code>
                . It supports a minimal core install and optional extras for LangGraph and CrewAI.
            </p>

            <Callout type="warning" title="Package renamed">
                Any docs, scripts, or pip invocations that reference{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-amber)",
                    }}
                >
                    agora-sdk
                </code>{" "}
                are stale. The correct package name is{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-amber)",
                    }}
                >
                    agora-arbitrator-sdk
                </code>
                .
            </Callout>

            <h2
                id="requirements"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Requirements
            </h2>

            <ul
                className="text-sm leading-relaxed mb-6 space-y-2 pl-5 list-disc"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>Python 3.11 or newer</li>
                <li>
                    Hosted mode: an Agora API key or other bearer token for the
                    hosted backend
                </li>
                <li>
                    Local mode: explicit provider credentials for the models you
                    want in the roster
                </li>
                <li>
                    Solana/RPC configuration only if you need chain-aware
                    verification beyond the default hosted flow
                </li>
            </ul>

            <h2
                id="install-from-pypi"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Install from PyPI
            </h2>

            <CodeBlock code={pipInstall} language="bash" />

            <h3
                id="extras"
                className="text-lg font-mono font-semibold mt-8 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                Extras
            </h3>

            <div className="space-y-4">
                <CodeBlock code={pipLangGraph} language="bash" filename="LangGraph" />
                <CodeBlock code={pipCrewAI} language="bash" filename="CrewAI" />
                <CodeBlock code={pipAll} language="bash" filename="Both extras" />
            </div>

            <h2
                id="hosted-mode"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Hosted mode
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Hosted mode uses the canonical Agora backend by default. You do
                not need to set an API URL unless you are intentionally testing
                against a non-canonical deployment.
            </p>

            <CodeBlock code={hostedExample} language="python" />

            <Callout type="info" title="Hosted auth model">
                For programmatic use, prefer Agora API keys such as{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    agora_live_...
                    </code>
                . Browser/dashboard flows still use WorkOS JWTs, but the SDK is
                designed around machine-friendly bearer tokens.
            </Callout>

            <h2
                id="local-mode"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Local BYOK mode
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Local mode runs the orchestrator inside your process. You are
                responsible for the participant roster and provider keys.
            </p>

            <CodeBlock code={localExample} language="python" />

            <h2
                id="api-overrides"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                API URL overrides
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The SDK intentionally resists arbitrary hosted endpoint
                overrides. A custom hosted backend is only honored when{" "}
                <code
                    className="font-mono text-[12px] px-1.5 py-0.5 rounded"
                    style={{
                        background: "var(--bg-subtle)",
                        color: "var(--accent-emerald)",
                    }}
                >
                    AGORA_ALLOW_API_URL_OVERRIDE=1
                </code>{" "}
                is set.
            </p>

            <CodeBlock code={overrideEnv} language="bash" />

            <h2
                id="install-from-source"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Install from source
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Clone the main repository and install the SDK in editable mode. Python 3.11+ is required.
            </p>

            <CodeBlock code={sourceInstall} language="bash" />

            <h2
                id="verify"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Verify the install
            </h2>

            <CodeBlock code={verifyInstall} language="bash" />

            <p
                className="text-sm leading-relaxed mt-4"
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
                    agora-arbitrator-sdk OK
                </code>
                , you're ready. Head to the{" "}
                <a href="/docs/quickstart" style={{ color: "var(--accent-emerald)" }}>
                    Quickstart
                </a>{" "}
                to run your first deliberation.
            </p>
        </div>
    );
}
