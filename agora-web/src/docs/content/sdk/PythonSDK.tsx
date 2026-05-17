import { CodeBlock } from "../../components/CodeBlock";
import { Callout } from "../../components/Callout";
import { ParamTable } from "../../components/ParamTable";

const installCode = `pip install agora-arbitrator-sdk`;

const quickstartHostedCode = `from agora.sdk import AgoraArbitrator

arbitrator = AgoraArbitrator(auth_token="agora_live_your_public_id.your_secret")
result = await arbitrator.arbitrate("Should we use microservices or a monolith?")

print(result.mechanism)  # e.g. "debate"
print(result.final_answer)
await arbitrator.aclose()`;

const quickstartLocalCode = `from agora.sdk import AgoraArbitrator

async def my_agent(user_prompt: str) -> dict:
    return {
        "answer": "Modular monolith",
        "confidence": 0.78,
        "predicted_group_answer": "Modular monolith",
        "reasoning": "Lower coordination overhead at small team size.",
    }

arbitrator = AgoraArbitrator(mechanism="vote", agent_count=3)
result = await arbitrator.arbitrate(
    "What architecture should a three-engineer startup use?",
    agents=[my_agent, my_agent, my_agent],
)

print(result.final_answer)
print(result.merkle_root)`;

const constructorCode = `from agora.sdk import AgoraArbitrator

arbitrator = AgoraArbitrator(
    auth_token="agora_live_xxxxx.yyyyy",  # hosted mode
    agent_count=4,
    mechanism=None,                       # auto-select by default
)`;

const hostedLifecycleCode = `created = await arbitrator.create_task(
    task="Should we expand to LATAM next quarter?",
    agent_count=4,
    source_urls=["https://www.imf.org/"],
    enable_tools=True,
)

result = await arbitrator.run_task(created.task_id)

print(result.mechanism)
print(result.final_answer)
print(result.tool_usage_summary)
print(result.citation_items[:3])`;

const localCode = `result = await arbitrator.arbitrate(
    task="Should we adopt TypeScript across the entire codebase?",
    stakes=0.0,
)

print(result.mechanism_used)
print(result.final_answer)
print(result.confidence)
print(result.quorum_reached)
print(result.merkle_root)
print(result.total_latency_ms)
print(result.tool_usage_summary)
print(result.citation_items)`;

const verifyCode = `verification = await arbitrator.verify_receipt(
    result,
    strict=False,  # strict=True also requires rpc_url + hosted task metadata
)
print(verification)`;

const streamCode = `async for event in arbitrator.stream_task_events("task_01j..."):
    print(event["event"], event["data"])`;

const benchmarkCode = `started = await arbitrator.run_benchmark(
    training_per_category=2,
    holdout_per_category=2,
    agent_count=4,
)

status = await arbitrator.wait_for_benchmark_run(started.run_id)
detail = await arbitrator.get_benchmark_detail(started.run_id)

print(status.status)
print(detail.total_tokens)
print(detail.total_latency_ms)`;

export function PythonSDK() {
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

    return (
        <div>
            <p
                className="font-mono text-[11px] uppercase tracking-[0.1em] mb-3"
                style={{ color: "var(--accent-emerald)" }}
            >
                SDK Reference
            </p>

            <h1
                className="text-3xl md:text-4xl font-mono font-bold mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Python SDK
            </h1>

            <p
                className="text-base leading-relaxed mb-6"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The Python SDK exposes one primary client,{" "}
                <IC>AgoraArbitrator</IC>. It supports two distinct execution
                modes:
            </p>

            <ul
                className="text-sm leading-relaxed mb-6 space-y-2 pl-5 list-disc"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Hosted mode
                    </strong>{" "}
                    for persisted tasks, event streaming, sources, tools,
                    evidence, citations, and benchmarks
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        Local BYOK mode
                    </strong>{" "}
                    for in-process orchestration with explicit provider rosters
                </li>
            </ul>

            {/* ── Installation ── */}
            <h2
                id="installation"
                className="text-xl font-mono font-semibold mt-10 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                Installation
            </h2>

            <CodeBlock code={installCode} language="bash" />

            <Callout type="warning" title="Package renamed">
                Install the SDK as{" "}
                <IC>agora-arbitrator-sdk</IC>. Old references to{" "}
                <IC>agora-sdk</IC> are stale.
            </Callout>

            {/* ── Quickstart ── */}
            <h2
                id="quickstart"
                className="text-xl font-mono font-semibold mt-10 mb-3"
                style={{ color: "var(--text-primary)" }}
            >
                Quickstart
            </h2>

            <p
                className="text-sm leading-relaxed mb-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <strong style={{ color: "var(--text-primary)" }}>Hosted mode</strong> — one{" "}
                <IC>await</IC> call, full verifiable deliberation. Requires an API key.
            </p>

            <CodeBlock code={quickstartHostedCode} language="python" />

            <p
                className="text-sm leading-relaxed mb-2"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <strong style={{ color: "var(--text-primary)" }}>Local callable mode</strong> — bring
                your own agents. No API key required; runs fully in-process.
            </p>

            <CodeBlock code={quickstartLocalCode} language="python" />

            <h2
                id="agora-arbitrator"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                AgoraArbitrator
            </h2>

            <CodeBlock code={constructorCode} language="python" />

            <ParamTable
                params={[
                    {
                        name: "api_url",
                        type: "str | None",
                        required: false,
                        default: "canonical hosted backend",
                        description:
                            "Hosted API base URL. Non-canonical overrides are blocked unless AGORA_ALLOW_API_URL_OVERRIDE=1 is set.",
                    },
                    {
                        name: "auth_token",
                        type: "str | None",
                        required: false,
                        default: "None",
                        description:
                            "Bearer token for hosted mode. In practice this should usually be an Agora API key for programmatic callers.",
                    },
                    {
                        name: "mechanism",
                        type: '"debate" | "vote" | "delphi" | None',
                        required: false,
                        default: "None",
                        description:
                            "Force a mechanism or let the selector choose automatically.",
                    },
                    {
                        name: "agent_count",
                        type: "int",
                        required: false,
                        default: "4",
                        description:
                            "Default participant count. Hosted requests currently allow 1 through 12.",
                    },
                    {
                        name: "allow_mechanism_switch",
                        type: "bool",
                        required: false,
                        default: "True",
                        description:
                            "Allow the runtime to switch mechanisms mid-run when convergence signals say the original choice was wrong.",
                    },
                    {
                        name: "allow_offline_fallback",
                        type: "bool",
                        required: false,
                        default: "True",
                        description:
                            "Permit deterministic/provider fallback paths when a live model call fails.",
                    },
                    {
                        name: "quorum_threshold",
                        type: "float",
                        required: false,
                        default: "0.6",
                        description:
                            "Convergence threshold used in hosted and local runs.",
                    },
                ]}
            />

            <h2
                id="hosted-task-lifecycle"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Hosted task lifecycle
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Hosted mode is the full product surface. Use{" "}
                <IC>create_task()</IC>, <IC>run_task()</IC>,{" "}
                <IC>get_task_status()</IC>, and{" "}
                <IC>stream_task_events()</IC> when you want persistence, live
                events, citations, attachments, and the benchmark-compatible
                lifecycle.
            </p>

            <CodeBlock code={hostedLifecycleCode} language="python" />

            <ParamTable
                params={[
                    {
                        name: "source_urls",
                        type: "list[str]",
                        required: false,
                        default: "[]",
                        description:
                            "Public URLs available to the hosted tool stack.",
                    },
                    {
                        name: "source_file_ids",
                        type: "list[str]",
                        required: false,
                        default: "[]",
                        description:
                            "IDs of files already registered through the hosted sources flow.",
                    },
                    {
                        name: "enable_tools",
                        type: "bool",
                        required: false,
                        default: "True",
                        description:
                            "Enable Brave search, URL analysis, multimodal analysis, and sandbox execution.",
                    },
                    {
                        name: "tool_policy",
                        type: "HostedToolPolicy",
                        required: false,
                        default: "runtime defaults",
                        description:
                            "Override tool budget and limits. Default per-agent budget is currently 4.",
                    },
                    {
                        name: "tier_model_overrides",
                        type: "HostedTierModelOverrides",
                        required: false,
                        default: "None",
                        description:
                            "Override hosted pro/flash/openrouter/claude lanes for one run.",
                    },
                ]}
            />

            <h2
                id="local-arbitration"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Local arbitration
            </h2>

            <CodeBlock code={localCode} language="python" />

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Local runs return the core{" "}
                <IC>DeliberationResult</IC> model. Important fields include{" "}
                <IC>mechanism_used</IC>, <IC>total_latency_ms</IC>,{" "}
                <IC>tool_usage_summary</IC>, <IC>evidence_items</IC>,{" "}
                <IC>citation_items</IC>, and <IC>sources</IC>.
            </p>

            <h2
                id="receipt-verification"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Receipt verification
            </h2>

            <CodeBlock code={verifyCode} language="python" />

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                In practice there are two verification modes.{" "}
                <IC>strict=False</IC> recomputes the Merkle root and compares
                against hosted receipt metadata when available.{" "}
                <IC>strict=True</IC> also requires a configured{" "}
                <IC>rpc_url</IC> so the SDK can verify the on-chain receipt path
                directly.
            </p>

            <h2
                id="streaming"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Event streaming
            </h2>

            <CodeBlock code={streamCode} language="python" />

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Hosted task events include planner/tool activity, citations,
                sandbox updates, selector decisions, mechanism switches, and the
                final receipt-related events. Use streaming if you care about
                UX or fine-grained observability.
            </p>

            <h2
                id="benchmarks"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Hosted benchmarks
            </h2>

            <CodeBlock code={benchmarkCode} language="python" />

            <Callout type="tip" title="Know the surface differences">
                Hosted result models use fields such as{" "}
                <IC>mechanism</IC> and <IC>latency_ms</IC>. Local results use{" "}
                <IC>mechanism_used</IC> and <IC>total_latency_ms</IC>. They are
                intentionally similar, but they are not interchangeable field
                names.
            </Callout>
        </div>
    );
}
