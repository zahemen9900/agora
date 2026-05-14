import type { ReactNode } from "react";
import { CodeBlock } from "../../components/CodeBlock";
import { Callout } from "../../components/Callout";

const baseUrl = `https://agora-api-b4auawqzbq-uc.a.run.app`;

const authCurlCode = `curl -X POST https://agora-api-b4auawqzbq-uc.a.run.app/tasks/ \\
  -H "Authorization: Bearer agora_live_xxxxx.yyyyy" \\
  -H "Content-Type: application/json" \\
  -d '{
    "task": "Should we adopt GraphQL or REST for our new API?",
    "agent_count": 4,
    "source_urls": ["https://www.imf.org/"],
    "enable_tools": true
  }'`;

const createTaskReq = `POST /tasks/
Content-Type: application/json
Authorization: Bearer <token>

{
  "task": "Should we adopt GraphQL or REST for our new API?",
  "mechanism_override": null,
  "agent_count": 4,
  "stakes": 0.0,
  "allow_mechanism_switch": true,
  "allow_offline_fallback": true,
  "quorum_threshold": 0.6,
  "source_urls": ["https://www.imf.org/"],
  "source_file_ids": [],
  "enable_tools": true,
  "tool_policy": {
    "enabled": true,
    "allow_search": true,
    "allow_url_analysis": true,
    "allow_file_analysis": true,
    "allow_code_execution": true,
    "max_tool_calls_per_agent": 4,
    "max_urls_per_call": 5,
    "max_files_per_call": 3,
    "execution_timeout_seconds": 20
  }
}`;

const createTaskRes = `HTTP/1.1 201 Created
Content-Type: application/json

{
  "task_id": "01J...",
  "mechanism": "debate",
  "confidence": 0.82,
  "reasoning": "Multi-factor tradeoff; debate is the strongest default.",
  "selector_reasoning_hash": "7f3a9c2b...",
  "status": "pending",
  "selector_source": "llm_reasoning",
  "selector_fallback_path": [],
  "mechanism_override_source": null
}`;

const runTaskRes = `HTTP/1.1 200 OK
Content-Type: application/json

{
  "task_id": "01J...",
  "mechanism": "debate",
  "final_answer": "REST is the better fit for this team right now...",
  "confidence": 0.89,
  "quorum_reached": true,
  "merkle_root": "1ef9d9c4...",
  "decision_hash": "5f9d6b0...",
  "agent_count": 4,
  "latency_ms": 18420.0,
  "sources": [
    {
      "source_id": "src_01...",
      "kind": "url",
      "display_name": "www.imf.org",
      "mime_type": "text/html",
      "size_bytes": 0,
      "source_url": "https://www.imf.org/"
    }
  ],
  "tool_usage_summary": {
    "total_tool_calls": 3,
    "successful_tool_calls": 3,
    "failed_tool_calls": 0,
    "tool_counts": {
      "search_online": 2,
      "execute_python": 1
    }
  },
  "evidence_items": [],
  "citation_items": [],
  "selector_source": "llm_reasoning",
  "selector_fallback_path": [],
  "mechanism_override_source": null
}`;

const getTaskRes = `HTTP/1.1 200 OK
Content-Type: application/json

{
  "task_id": "01J...",
  "status": "completed",
  "mechanism": "debate",
  "enable_tools": true,
  "agent_count": 4,
  "payment_status": "none",
  "solana_tx_hash": null,
  "chain_operations": {},
  "result": {
    "task_id": "01J...",
    "mechanism": "debate",
    "final_answer": "REST is the better fit for this team right now...",
    "confidence": 0.89,
    "quorum_reached": true,
    "merkle_root": "1ef9d9c4...",
    "latency_ms": 18420.0,
    "tool_usage_summary": {
      "total_tool_calls": 3,
      "successful_tool_calls": 3,
      "failed_tool_calls": 0,
      "tool_counts": {
        "search_online": 2,
        "execute_python": 1
      }
    },
    "citation_items": []
  }
}`;

const streamSseExample = `GET /tasks/01J.../stream
Authorization: Bearer <token>
Accept: text/event-stream

event: mechanism_selected
data: {"mechanism":"debate","reason":"Multi-factor tradeoff"}

event: tool_call_started
data: {"tool_name":"search_online","tool_call_id":"tool_01..."}

event: tool_call_completed
data: {"tool_name":"search_online","tool_call_id":"tool_01...","summary":"Retrieved Brave search results"}

event: sandbox_execution_started
data: {"tool_name":"execute_python","tool_call_id":"tool_02..."}

event: agent_output_delta
data: {"agent_id":"agent-1","content":"REST remains the stronger fit..."}

event: receipt_committed
data: {"merkle_root":"1ef9d9c4...","solana_tx_hash":null}`;

const sourceInitReq = `POST /sources/upload-init
Authorization: Bearer <token>
Content-Type: application/json

{
  "filename": "market-analysis.xlsx",
  "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "size_bytes": 128734
}`;

const benchmarkReq = `POST /benchmarks/run
Authorization: Bearer <token>
Content-Type: application/json

{
  "training_per_category": 2,
  "holdout_per_category": 2,
  "agent_count": 4,
  "live_agents": true
}`;

const healthRes = `HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "ok",
  "version": "0.1.0a21",
  "solana_network": "devnet"
}`;

export function APIReference() {
    const IC = ({ children }: { children: ReactNode }) => (
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

    const Method = ({ method }: { method: "GET" | "POST" }) => {
        const color =
            method === "GET" ? "var(--accent-emerald)" : "var(--accent-amber)";
        const bg =
            method === "GET"
                ? "var(--accent-emerald-soft)"
                : "var(--accent-amber-soft)";
        return (
            <span
                className="font-mono text-[11px] px-2 py-0.5 rounded uppercase tracking-wider font-bold"
                style={{ background: bg, color }}
            >
                {method}
            </span>
        );
    };

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
                API Reference
            </h1>

            <p
                className="text-base leading-relaxed mb-6"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The hosted REST API is the transport behind the Python SDK. Use
                it directly if you need browser-integrated workflows, non-Python
                clients, or explicit control of task/source/benchmark lifecycle
                calls.
            </p>

            <h2
                id="base-url"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Base URL
            </h2>

            <CodeBlock code={baseUrl} language="text" filename="base URL" />

            <h2
                id="authentication"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Authentication
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The system supports two bearer-token patterns:
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
                        Agora API keys
                    </strong>{" "}
                    for SDKs, CI, and server-to-server callers
                </li>
                <li>
                    <strong style={{ color: "var(--text-primary)" }}>
                        WorkOS JWTs
                    </strong>{" "}
                    for dashboard/browser user flows
                </li>
            </ul>

            <CodeBlock code={authCurlCode} language="bash" />

            <Callout type="tip" title="What to use in practice">
                For programmatic integrations, use Agora API keys. JWT-only
                language in older docs is outdated.
            </Callout>

            <h2
                id="task-endpoints"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Task endpoints
            </h2>

            <div className="space-y-8">
                <section>
                    <div className="flex items-center gap-3 mb-3">
                        <Method method="POST" />
                        <h3
                            className="text-lg font-mono font-semibold"
                            style={{ color: "var(--text-primary)" }}
                        >
                            /tasks/
                        </h3>
                    </div>
                    <CodeBlock code={createTaskReq} language="json" filename="request" />
                    <CodeBlock code={createTaskRes} language="json" filename="response" />
                </section>

                <section>
                    <div className="flex items-center gap-3 mb-3">
                        <Method method="POST" />
                        <h3
                            className="text-lg font-mono font-semibold"
                            style={{ color: "var(--text-primary)" }}
                        >
                            /tasks/{"{id}"}/run
                        </h3>
                    </div>
                    <CodeBlock code={runTaskRes} language="json" filename="response" />
                </section>

                <section>
                    <div className="flex items-center gap-3 mb-3">
                        <Method method="GET" />
                        <h3
                            className="text-lg font-mono font-semibold"
                            style={{ color: "var(--text-primary)" }}
                        >
                            /tasks/{"{id}"}
                        </h3>
                    </div>
                    <CodeBlock code={getTaskRes} language="json" filename="response" />
                </section>
            </div>

            <h2
                id="streaming"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Streaming
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Live deliberation is exposed through SSE. The current stream
                includes selector decisions, tool calls, sandbox activity,
                planner output, agent deltas, and receipt-related events.
            </p>

            <CodeBlock code={streamSseExample} language="text" filename="SSE example" />

            <h2
                id="sources"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Source endpoints
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Hosted uploads are a first-class part of the product. Files are
                registered through the sources flow, then attached to tasks via{" "}
                <IC>source_file_ids</IC>.
            </p>

            <CodeBlock code={sourceInitReq} language="json" filename="upload-init request" />

            <h2
                id="benchmarks"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Benchmarks
            </h2>

            <CodeBlock code={benchmarkReq} language="json" filename="benchmark request" />

            <h2
                id="health"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Health
            </h2>

            <CodeBlock code={healthRes} language="json" filename="GET /health" />
        </div>
    );
}
