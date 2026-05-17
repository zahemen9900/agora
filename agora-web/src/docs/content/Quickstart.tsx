import { CodeBlock } from "../components/CodeBlock";
import { Callout } from "../components/Callout";
import { Steps, Step } from "../components/Steps";
import { LinkCard } from "../components/LinkCard";

const installCode = `pip install agora-arbitrator-sdk`;

const hostedCode = `import asyncio
from agora.sdk import AgoraArbitrator


async def main() -> None:
    async with AgoraArbitrator(
        auth_token="agora_live_xxxxx.yyyyy",
    ) as arbitrator:
        created = await arbitrator.create_task(
            task="Should we expand the product to APAC in the next two quarters?",
            agent_count=4,
            source_urls=["https://www.imf.org/"],
        )

        result = await arbitrator.run_task(created.task_id)

        print(result.task_id)
        print(result.mechanism)           # "debate" | "vote" | "delphi"
        print(result.final_answer)
        print(result.confidence)
        print(result.quorum_reached)
        print(result.merkle_root)
        print(result.latency_ms)
        print(result.tool_usage_summary)
        print(result.citation_items[:2])


asyncio.run(main())`;

const localCode = `import asyncio
from agora.sdk import AgoraArbitrator
from agora.types import LocalModelSpec, LocalProviderKeys


async def main() -> None:
    async with AgoraArbitrator(
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
        agent_count=4,
    ) as arbitrator:
        result = await arbitrator.arbitrate(
            "Should a 4-engineer startup adopt microservices or stay on a monolith?"
        )

        print(result.mechanism_used)
        print(result.final_answer)
        print(result.total_latency_ms)
        print(result.tool_usage_summary)
        print(result.citation_items)


asyncio.run(main())`;

const verifyCode = `verification = await arbitrator.verify_receipt(
    result,
    strict=False,  # strict=True also requires rpc_url + hosted task metadata
)
print(verification)
# {
#   "valid": True,
#   "merkle_match": True,
#   "hosted_metadata_match": True,
#   "on_chain_match": None
# }`;

const exampleOutput = `task_01j...
debate
Expand to APAC only if the launch can preserve regulatory clarity and underwriting discipline...
0.87
True
1ef9d9c4...
18420.0
HostedToolUsageSummary(total_tool_calls=3, successful_tool_calls=3, failed_tool_calls=0, ...)
[HostedCitationItem(title="IMF ...", url="https://www.imf.org/", ...)]`;

export function Quickstart() {
    const IC = ({ children }: { children: string }) => (
        <code
            className="font-mono text-[12px] px-1.5 py-0.5 rounded"
            style={{ background: "var(--bg-subtle)", color: "var(--accent-emerald)" }}
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
                Getting Started
            </p>

            <h1
                className="text-3xl md:text-4xl font-mono font-bold mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Quickstart
            </h1>

            <p
                className="text-base leading-relaxed mb-6"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The fastest useful path is hosted mode: install the SDK, pass
                an Agora API key, create a task, and run it. If you want
                complete provider control, the second example shows local BYOK
                mode.
            </p>

            <Callout type="info" title="Current defaults">
                The current default agent count is{" "}
                <strong style={{ color: "var(--text-primary)" }}>4</strong>,
                tools are enabled, and the default per-agent tool budget is{" "}
                <strong style={{ color: "var(--text-primary)" }}>4</strong>.
            </Callout>

            <Steps>
                <Step number={1} title="Install the SDK">
                    <CodeBlock code={installCode} language="bash" />
                </Step>

                <Step number={2} title="Run a hosted deliberation">
                    <CodeBlock code={hostedCode} language="python" />
                    <p
                        className="text-sm leading-relaxed mb-3"
                        style={{
                            fontFamily: "'Hanken Grotesk', sans-serif",
                            color: "var(--text-secondary)",
                        }}
                    >
                        This is the path you want if you need hosted sources,
                        task lifecycle state, live event streams, citations,
                        evidence, and benchmark compatibility.
                    </p>
                    <CodeBlock
                        code={exampleOutput}
                        language="text"
                        filename="example output"
                    />
                </Step>

                <Step number={3} title="Verify the receipt if you need auditability">
                    <CodeBlock code={verifyCode} language="python" />
                </Step>
            </Steps>

            <h2
                id="local-byok"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Local BYOK example
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Use this mode when you want to pick the exact provider roster
                yourself and run deliberation in-process rather than through the
                hosted task API.
            </p>

            <CodeBlock code={localCode} language="python" />

            <h2
                id="what-you-get-back"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                What you get back
            </h2>

            <ul
                className="text-sm leading-relaxed mb-6 space-y-2 pl-5 list-disc"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                <li>
                    Hosted runs return task-scoped payloads with <IC>mechanism</IC>,{" "}
                    <IC>sources</IC>, <IC>tool_usage_summary</IC>,{" "}
                    <IC>evidence_items</IC>, and <IC>citation_items</IC>.
                </li>
                <li>
                    Local runs return <IC>DeliberationResult</IC> objects with{" "}
                    <IC>mechanism_used</IC>, <IC>total_latency_ms</IC>, and normalized
                    evidence/citation fields.
                </li>
                <li>Both paths can produce verifiable Merkle-rooted receipts.</li>
            </ul>

            <Callout type="tip" title="Streaming">
                Both hosted and local runs support event streaming. Use{" "}
                <IC>stream_task_events()</IC> on the hosted path for real-time
                selector decisions, tool calls, agent deltas, and receipt events.
            </Callout>

            <Callout type="warning" title="Receipt verification modes">
                The SDK defaults to strict receipt verification. For the normal
                hosted quickstart, use <IC>strict=False</IC> unless you have
                also configured <IC>rpc_url</IC> and want a full on-chain check.
            </Callout>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-8">
                <LinkCard
                    title="Installation"
                    description="Package names, extras, hosted auth, and local BYOK setup."
                    href="/docs/installation"
                />
                <LinkCard
                    title="Python SDK"
                    description="Full method-level breakdown of the current SDK surface."
                    href="/docs/sdk/python"
                />
            </div>
        </div>
    );
}
