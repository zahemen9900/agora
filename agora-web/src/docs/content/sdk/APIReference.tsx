import type { ReactNode } from "react";
import { CodeBlock } from "../../components/CodeBlock";
import { Callout } from "../../components/Callout";

/* ── Code samples ──────────────────────────────────────────────────── */

const authCurlCode = `# Obtain a JWT from WorkOS, then pass it as a Bearer token.
curl -X POST https://agora-api-b4auawqzbq-uc.a.run.app/tasks/ \\
  -H "Authorization: Bearer <YOUR_JWT>" \\
  -H "Content-Type: application/json" \\
  -d '{"task": "Should we adopt GraphQL or REST for our new API?"}'`;

const createTaskReq = `POST /tasks/
Content-Type: application/json
Authorization: Bearer <token>

{
  "task": "Should we adopt GraphQL or REST for our new API?",
  "mechanism": null,          // null → auto-select; or "debate" | "vote" | "delphi"
  "agent_count": 3,           // 3 | 5 | 7  (default: 3)
  "stakes": 0.0,              // SOL to escrow (default: 0.0)
  "solana_wallet": null       // required when stakes > 0
}`;

const createTaskRes = `HTTP/1.1 201 Created
Content-Type: application/json

{
  "task_id": "01HX9KPZQ2V8NHFR3JB5MGTD7E",
  "status": "pending",
  "created_at": "2025-01-15T14:32:07Z"
}`;

const runTaskReq = `POST /tasks/01HX9KPZQ2V8NHFR3JB5MGTD7E/run
Authorization: Bearer <token>`;

const runTaskRes = `HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "task_id": "01HX9KPZQ2V8NHFR3JB5MGTD7E",
  "status": "running",
  "mechanism_selected": "debate",
  "mechanism_selection_reason": "Complex technical trade-off; debate historically best for API design questions."
}`;

const getTaskRes = `HTTP/1.1 200 OK
Content-Type: application/json

{
  "task_id": "01HX9KPZQ2V8NHFR3JB5MGTD7E",
  "status": "completed",       // "pending" | "running" | "completed" | "failed"
  "mechanism_used": "debate",
  "final_answer": "REST is recommended for this use case...",
  "confidence": 0.89,
  "quorum_reached": true,
  "mechanism_switches": 0,
  "merkle_root": "7f3a9c2b1e4d8f6a0c5b3e9d2f1a7c4b8e0d6f3a1c9b5e7d2f4a6c8b0e1d3f5a",
  "solana_tx_hash": "5KkDpQr9mFzXcT8nBvP2wS7hYjLaRqNuGdIeOkWmAfHg4sJyCbEtVlZoUX6xMw1",
  "duration_ms": 18430,
  "created_at": "2025-01-15T14:32:07Z",
  "completed_at": "2025-01-15T14:32:25Z"
}`;

const streamSseExample = `GET /tasks/01HX9KPZQ2V8NHFR3JB5MGTD7E/stream
Authorization: Bearer <token>
Accept: text/event-stream

# Events are newline-delimited SSE frames:

event: mechanism_selected
data: {"mechanism": "debate", "reason": "Complex technical trade-off..."}

event: agent_output
data: {"agent_id": "agent_0", "faction": "pro_rest", "output": "REST is battle-tested...", "confidence": 0.82}

event: agent_output
data: {"agent_id": "agent_1", "faction": "pro_graphql", "output": "GraphQL eliminates over-fetching...", "confidence": 0.76}

event: cross_examination
data: {"examiner": "devil_advocate", "target": "pro_graphql", "output": "How do you handle N+1 queries without DataLoader?"}

event: convergence_update
data: {"confidence": 0.87, "leading_faction": "pro_rest", "quorum": false}

event: quorum_reached
data: {"mechanism": "debate", "confidence": 0.89, "leading_faction": "pro_rest"}

event: receipt_committed
data: {"merkle_root": "7f3a9c2b...", "solana_tx_hash": "5KkDpQr9..."}`;

const payTaskReq = `POST /tasks/01HX9KPZQ2V8NHFR3JB5MGTD7E/pay
Authorization: Bearer <token>
Content-Type: application/json

{
  "solana_wallet": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
}`;

const payTaskRes = `HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "released",
  "solana_tx_hash": "3mNpQrXwYzA9BcFdGhJkLnRsTuVwXy2ZaEbFcGdHeIfJg",
  "amount_sol": 0.05
}`;

const healthRes = `HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "ok",
  "version": "1.4.2",
  "solana_network": "devnet"
}`;

const jsClientCode = `const BASE_URL = "https://agora-api-b4auawqzbq-uc.a.run.app";
const JWT = "your-workos-jwt";

// 1. Create the task
const { task_id } = await fetch(\`\${BASE_URL}/tasks/\`, {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${JWT}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ task: "Should we migrate to a monorepo?" }),
}).then((r) => r.json());

// 2. Start execution
await fetch(\`\${BASE_URL}/tasks/\${task_id}/run\`, {
  method: "POST",
  headers: { Authorization: \`Bearer \${JWT}\` },
});

// 3. Stream live events
const es = new EventSource(
  \`\${BASE_URL}/tasks/\${task_id}/stream?token=\${JWT}\`
);

es.addEventListener("quorum_reached", (e) => {
  const data = JSON.parse(e.data);
  console.log("Quorum at confidence:", data.confidence);
});

es.addEventListener("receipt_committed", (e) => {
  const { merkle_root, solana_tx_hash } = JSON.parse(e.data);
  console.log("On-chain proof:", solana_tx_hash);
  es.close();
});

es.onerror = () => es.close();`;

const sseEvents = [
    {
        event: "mechanism_selected",
        description:
            "Fired once at the start of execution. Contains the chosen mechanism and the selector's reasoning string.",
    },
    {
        event: "agent_output",
        description:
            "Fired for each agent output. Includes agent_id, faction (debate only), the output text, and self-reported confidence.",
    },
    {
        event: "cross_examination",
        description:
            "Fired for each Devil's Advocate cross-examination round in the debate mechanism.",
    },
    {
        event: "convergence_update",
        description:
            "Fired after each deliberation round with the current aggregate confidence and leading faction or answer.",
    },
    {
        event: "mechanism_switch",
        description:
            "Fired if the mechanism selector switches mechanism mid-execution. Includes the from/to mechanism and the reason.",
    },
    {
        event: "quorum_reached",
        description:
            "Fired when the convergence threshold is met. Includes final mechanism, confidence, and leading answer.",
    },
    {
        event: "receipt_committed",
        description:
            "Final event. Fired after the Merkle root has been written to Solana. Includes merkle_root and solana_tx_hash.",
    },
];

/* ── Component ─────────────────────────────────────────────────────── */

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
                The Agora REST API is the underlying transport for the Python
                SDK. You can call it directly for non-Python environments or to
                build custom integrations. All endpoints return JSON. Real-time
                deliberation progress is available via SSE.
            </p>

            {/* ── Base URL ──────────────────────────────────────────────────── */}
            <h2
                id="base-url"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Base URL
            </h2>

            <CodeBlock
                code="https://agora-api-b4auawqzbq-uc.a.run.app"
                language="text"
                filename="base URL"
            />

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                All paths below are relative to this base URL. The API is hosted
                on Google Cloud Run in the <IC>us-central1</IC> region and
                auto-scales to zero between requests.
            </p>

            {/* ── Authentication ────────────────────────────────────────────── */}
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
                All endpoints except <IC>GET /health</IC> require a
                WorkOS-issued JWT passed as a <IC>Bearer</IC> token in the{" "}
                <IC>Authorization</IC> header. JWTs are obtained via the Agora
                web app's authentication flow.
            </p>

            <CodeBlock code={authCurlCode} language="bash" />

            <Callout type="warning" title="JWT expiry">
                WorkOS JWTs expire after 24 hours. The Python SDK handles token
                refresh automatically. If you're calling the API directly,
                refresh your token before making requests if the current one is
                more than 23 hours old.
            </Callout>

            {/* ── Endpoints ─────────────────────────────────────────────────── */}
            <h2
                id="endpoints"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                Endpoints
            </h2>

            {/* POST /tasks/ */}
            <h3
                id="post-tasks"
                className="text-lg font-mono font-semibold mt-6 mb-3 flex items-center gap-3"
                style={{ color: "var(--text-primary)" }}
            >
                <Method method="POST" /> /tasks/
            </h3>
            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Creates a new deliberation task. Returns a <IC>task_id</IC> and{" "}
                <IC>status: "pending"</IC>. The task does not start executing
                until you call <IC>POST /tasks/{"{task_id}"}/run</IC>.
            </p>
            <CodeBlock
                code={createTaskReq}
                language="http"
                filename="request"
            />
            <CodeBlock
                code={createTaskRes}
                language="http"
                filename="response"
            />

            {/* POST /tasks/{id}/run */}
            <h3
                id="post-tasks-run"
                className="text-lg font-mono font-semibold mt-8 mb-3 flex items-center gap-3"
                style={{ color: "var(--text-primary)" }}
            >
                <Method method="POST" /> /tasks/{"{task_id}"}/run
            </h3>
            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Starts the deliberation pipeline for a pending task. Responds
                immediately with <IC>202 Accepted</IC> — use the stream endpoint
                or poll <IC>GET /tasks/{"{task_id}"}</IC> to track progress.
            </p>
            <CodeBlock code={runTaskReq} language="http" filename="request" />
            <CodeBlock code={runTaskRes} language="http" filename="response" />

            {/* GET /tasks/{id} */}
            <h3
                id="get-task"
                className="text-lg font-mono font-semibold mt-8 mb-3 flex items-center gap-3"
                style={{ color: "var(--text-primary)" }}
            >
                <Method method="GET" /> /tasks/{"{task_id}"}
            </h3>
            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Returns the current state of a task. When <IC>status</IC> is{" "}
                <IC>"completed"</IC>, the response includes the full result
                including <IC>final_answer</IC>, <IC>merkle_root</IC>, and{" "}
                <IC>solana_tx_hash</IC>.
            </p>
            <CodeBlock
                code={getTaskRes}
                language="http"
                filename="response (completed)"
            />

            {/* GET /tasks/{id}/stream */}
            <h3
                id="get-task-stream"
                className="text-lg font-mono font-semibold mt-8 mb-3 flex items-center gap-3"
                style={{ color: "var(--text-primary)" }}
            >
                <Method method="GET" /> /tasks/{"{task_id}"}/stream
            </h3>
            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Server-Sent Events stream for a task. Returns a{" "}
                <IC>text/event-stream</IC> response with one event per
                deliberation step. The connection closes after the{" "}
                <IC>receipt_committed</IC> event. Can also be consumed against a
                completed task to replay the full event log.
            </p>
            <CodeBlock
                code={streamSseExample}
                language="http"
                filename="SSE stream example"
            />

            {/* POST /tasks/{id}/pay */}
            <h3
                id="post-tasks-pay"
                className="text-lg font-mono font-semibold mt-8 mb-3 flex items-center gap-3"
                style={{ color: "var(--text-primary)" }}
            >
                <Method method="POST" /> /tasks/{"{task_id}"}/pay
            </h3>
            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Releases the escrowed SOL for a staked arbitration task. Only
                valid for completed tasks where <IC>stakes {">"} 0</IC> was set
                at creation time.
            </p>
            <CodeBlock code={payTaskReq} language="http" filename="request" />
            <CodeBlock code={payTaskRes} language="http" filename="response" />

            {/* GET /health */}
            <h3
                id="get-health"
                className="text-lg font-mono font-semibold mt-8 mb-3 flex items-center gap-3"
                style={{ color: "var(--text-primary)" }}
            >
                <Method method="GET" /> /health
            </h3>
            <p
                className="text-sm leading-relaxed mb-3"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                Health check endpoint. No authentication required. Returns the
                API version and current Solana network. Useful for connectivity
                checks and uptime monitoring.
            </p>
            <CodeBlock code={healthRes} language="http" filename="response" />

            {/* ── SSE Event Types ───────────────────────────────────────────── */}
            <h2
                id="sse-event-types"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                SSE Event Types
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                All SSE events have a <IC>type</IC> field (the SSE{" "}
                <IC>event:</IC> line) and a JSON-encoded <IC>data</IC> field.
                Events are emitted in chronological order.
            </p>

            <div className="overflow-x-auto my-5 rounded-lg border border-[var(--border-default)]">
                <table className="w-full text-sm border-collapse">
                    <thead>
                        <tr style={{ background: "var(--bg-elevated)" }}>
                            {["Event", "Description"].map((h) => (
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
                        {sseEvents.map(({ event, description }) => (
                            <tr
                                key={event}
                                className="border-t border-[var(--border-default)]"
                                onMouseEnter={(e) => {
                                    (
                                        e.currentTarget as HTMLTableRowElement
                                    ).style.background = "var(--bg-elevated)";
                                }}
                                onMouseLeave={(e) => {
                                    (
                                        e.currentTarget as HTMLTableRowElement
                                    ).style.background = "";
                                }}
                            >
                                <td
                                    className="px-4 py-3 font-mono text-[13px] whitespace-nowrap align-top"
                                    style={{ color: "var(--accent-emerald)" }}
                                >
                                    {event}
                                </td>
                                <td
                                    className="px-4 py-3 text-[13px] leading-relaxed"
                                    style={{
                                        fontFamily:
                                            "'Hanken Grotesk', sans-serif",
                                        color: "var(--text-secondary)",
                                    }}
                                >
                                    {description}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* ── JavaScript EventSource Client ─────────────────────────────── */}
            <h2
                id="javascript-client"
                className="text-xl font-mono font-semibold mt-10 mb-4"
                style={{ color: "var(--text-primary)" }}
            >
                JavaScript EventSource Client
            </h2>

            <p
                className="text-sm leading-relaxed mb-4"
                style={{
                    fontFamily: "'Hanken Grotesk', sans-serif",
                    color: "var(--text-secondary)",
                }}
            >
                The example below shows how to create a task, start it, and
                consume the SSE stream from a browser or Node.js environment
                using the native <IC>EventSource</IC> API. For server-side
                Node.js, use the <IC>eventsource</IC> npm package as a polyfill.
            </p>

            <CodeBlock code={jsClientCode} language="typescript" />

            <Callout type="info" title="EventSource and auth headers">
                The browser <IC>EventSource</IC> API does not support custom
                headers. Pass your JWT as a <IC>token</IC> query parameter for
                the stream endpoint, as shown above. For all other endpoints,
                use the standard <IC>Authorization: Bearer</IC> header.
            </Callout>
        </div>
    );
}
