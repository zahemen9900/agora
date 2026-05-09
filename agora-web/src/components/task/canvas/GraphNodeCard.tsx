import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProviderGlyph } from "../../ProviderGlyph";
import type { ProviderName } from "../../../lib/modelProviders";
import type { GraphNode, NodeKind, ToolActivity } from "./canvasTypes";
import { usePostHog } from "@posthog/react";

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 170;
export const NODE_GAP_H = 20;
export const NODE_GAP_V = 300;

const CANVAS_MARKDOWN_COMPONENTS = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p style={{ margin: "0 0 8px" }}>{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul style={{ margin: "0 0 8px", paddingLeft: "18px", listStyleType: "disc" }}>{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol style={{ margin: "0 0 8px", paddingLeft: "18px", listStyleType: "decimal" }}>{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li style={{ marginBottom: "3px" }}>{children}</li>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong style={{ fontWeight: 700, color: "var(--text-primary)" }}>{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em style={{ fontStyle: "italic", color: "inherit" }}>{children}</em>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = className?.includes("language-");
    return isBlock
      ? (
        <code
          style={{
            display: "block",
            fontFamily: "'Commit Mono', monospace",
            fontSize: "11px",
            background: "var(--bg-base)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "8px",
            padding: "10px 12px",
            overflowX: "auto",
            whiteSpace: "pre",
            color: "var(--text-secondary)",
            margin: "0 0 8px",
          }}
        >
          {children}
        </code>
      )
      : (
        <code
          style={{
            fontFamily: "'Commit Mono', monospace",
            fontSize: "11px",
            background: "var(--bg-base)",
            borderRadius: "4px",
            padding: "1px 5px",
            color: "var(--text-primary)",
          }}
        >
          {children}
        </code>
      );
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre style={{ margin: "0 0 8px", overflow: "hidden" }}>{children}</pre>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote
      style={{
        borderLeft: "2px solid var(--accent-emerald)",
        paddingLeft: "10px",
        margin: "0 0 8px",
        color: "var(--text-secondary)",
        fontStyle: "italic",
      }}
    >
      {children}
    </blockquote>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ color: "var(--accent-emerald)", textDecoration: "underline", textUnderlineOffset: "2px" }}
    >
      {children}
    </a>
  ),
  hr: () => <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle)", margin: "10px 0" }} />,
};

// ─── Keyframe injection ───────────────────────────────────────────────────────
const CANVAS_STYLE_ID = "canvas-node-kf";
function injectCanvasKeyframes() {
  if (typeof document === "undefined" || document.getElementById(CANVAS_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = CANVAS_STYLE_ID;
  s.textContent = `
    @keyframes canvas-card-in {
      from { opacity: 0; transform: scale(0.88) translateY(10px); }
      to   { opacity: 1; transform: scale(1)    translateY(0);    }
    }
    @keyframes canvas-text-fade {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes canvas-cursor-blink {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0; }
    }
    @keyframes canvas-live-glow {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.55; }
    }
    @keyframes canvas-active-border {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.5; }
    }
  `;
  document.head.appendChild(s);
}

// ─── Stage-aware colors ────────────────────────────────────────────────────────
const KIND_COLOR: Record<NodeKind, string> = {
  task:        "#6b7280",
  selector:    "#a78bfa",
  agent:       "#22d3ee",
  tool:        "#5eead4",
  crossexam:   "#fbbf24",
  convergence: "#c084fc",
  switch:      "#fb923c",
  quorum:      "#34d399",
  receipt:     "#38bdf8",
};

const STAGE_COLOR: Record<string, string> = {
  opening:             "#22d3ee",
  opening_statement:   "#22d3ee",
  rebuttal:            "#60a5fa",
  cross_examination:   "#fbbf24",
  synthesis:           "#818cf8",
  output:              "#22d3ee",
};

function nodeColor(node: GraphNode): string {
  if (node.status === "error") return "#f87171";
  if (node.kind === "tool") {
    if (node.toolStatus === "failed") return "#f87171";
    if (node.toolStatus === "retrying") return "#fbbf24";
    if (node.toolStatus === "success") return "#34d399";
    return "#38bdf8";
  }
  if (node.kind !== "agent") return KIND_COLOR[node.kind];
  for (const [key, color] of Object.entries(STAGE_COLOR)) {
    if (node.stage?.toLowerCase().includes(key)) return color;
  }
  return KIND_COLOR.agent;
}

function glowColor(node: GraphNode): string {
  const c = nodeColor(node);
  if (node.kind === "quorum") return "rgba(52,211,153,0.28)";
  if (node.kind === "tool") {
    if (node.toolStatus === "failed") return "rgba(248,113,113,0.18)";
    if (node.toolStatus === "retrying") return "rgba(251,191,36,0.18)";
    return `${c}26`;
  }
  if (node.status === "active") return `${c}30`;
  if (node.status === "thinking") return "rgba(251,191,36,0.20)";
  return "transparent";
}

// ─── Streaming text (same chunk-based fade as the logs view) ──────────────────
export function CanvasStreamText({
  text,
  isActive,
  fontSize = "12px",
  color = "var(--text-secondary)",
  fontStyle = "normal",
}: {
  text: string;
  isActive: boolean;
  fontSize?: string;
  color?: string;
  fontStyle?: "normal" | "italic";
}) {
  const seenLenRef = useRef(0);
  const [chunks, setChunks] = useState<Array<{ id: number; text: string }>>([]);
  const chunkIdRef = useRef(0);

  useEffect(() => {
    injectCanvasKeyframes();
  }, []);

  useEffect(() => {
    if (!isActive) {
      seenLenRef.current = text.length;
      setChunks([]);
      return;
    }
    if (text.length <= seenLenRef.current) return;
    const delta = text.slice(seenLenRef.current);
    seenLenRef.current = text.length;
    const id = ++chunkIdRef.current;
    setChunks((prev) => [...prev, { id, text: delta }].slice(-10));
  }, [text, isActive]);

  const keptLen = chunks.reduce((acc, c) => acc + c.text.length, 0);
  const stableText = text.slice(0, Math.max(0, text.length - keptLen));

  return (
    <span style={{ fontSize, color, lineHeight: 1.55, whiteSpace: "pre-wrap", fontStyle }}>
      {stableText}
      {chunks.map((chunk) => (
        <span
          key={chunk.id}
          style={{ animation: "canvas-text-fade 0.42s ease-in-out both" }}
        >
          {chunk.text}
        </span>
      ))}
    </span>
  );
}

export function CanvasMarkdownText({
  text,
  fontSize = "12px",
  color = "var(--text-secondary)",
  italic = false,
}: {
  text: string;
  fontSize?: string;
  color?: string;
  italic?: boolean;
}) {
  return (
    <div
      style={{
        fontSize,
        color,
        lineHeight: 1.55,
        whiteSpace: "normal",
        fontStyle: italic ? "italic" : "normal",
        overflowWrap: "anywhere",
      }}
    >
      <Markdown remarkPlugins={[remarkGfm]} components={CANVAS_MARKDOWN_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}

// ─── Provider image ───────────────────────────────────────────────────────────
function ProviderImg({ provider, size = 16 }: { provider?: string; size?: number }) {
  if (!provider || provider === "other") return null;
  return (
    <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <ProviderGlyph provider={provider as ProviderName} size={size} />
    </div>
  );
}

// ─── Telemetry popover ────────────────────────────────────────────────────────
function TelRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "14px", marginBottom: "5px" }}>
      <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)" }}>{label}</span>
      <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-primary)" }}>{value}</span>
    </div>
  );
}

function TelemetryPopover({ node, onClose }: { node: GraphNode; onClose: () => void }) {
    const posthog = usePostHog();
  const t = node.telemetry;
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        right: 0,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)",
        borderRadius: "10px",
        padding: "12px 14px",
        minWidth: "200px",
        zIndex: 200,
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        animation: "canvas-card-in 0.2s cubic-bezier(0.22,1,0.36,1) both",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
        <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.08em" }}>TELEMETRY</span>
        <button onClick={(e: any) => { posthog?.capture('graphnodecard_clicked'); const handler = onClose; if (typeof handler === 'function') (handler as any)(e); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "14px", lineHeight: 1 }}>×</button>
      </div>
      {node.reason && (
        <div style={{ marginBottom: "10px", padding: "8px 10px", background: "var(--bg-base)", borderRadius: "8px", border: "1px solid var(--border-subtle)" }}>
          <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "9px", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: "5px" }}>REASON</div>
          <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-primary)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{node.reason}</div>
        </div>
      )}
      {node.confidence !== undefined && <TelRow label="Confidence" value={`${(node.confidence * 100).toFixed(1)}%`} />}
      {t?.totalTokens    !== undefined && <TelRow label="Total tokens"    value={t.totalTokens.toLocaleString()} />}
      {t?.inputTokens    !== undefined && <TelRow label="Input tokens"    value={t.inputTokens.toLocaleString()} />}
      {t?.outputTokens   !== undefined && <TelRow label="Output tokens"   value={t.outputTokens.toLocaleString()} />}
      {t?.thinkingTokens !== undefined && <TelRow label="Thinking tokens" value={t.thinkingTokens.toLocaleString()} />}
      {t?.latencyMs      !== undefined && <TelRow label="Latency"         value={`${Math.round(t.latencyMs)} ms`} />}
      {t?.usdCost        !== undefined && <TelRow label="Est. cost"       value={`$${t.usdCost.toFixed(6)}`} />}
    </div>
  );
}

// ─── Info popover ─────────────────────────────────────────────────────────────
function InfoPopover({ label, value, onClose }: { label: string; value: string; onClose: () => void }) {
    const posthog = usePostHog();
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        left: 0,
        right: 0,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)",
        borderRadius: "10px",
        padding: "10px 12px",
        zIndex: 200,
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        animation: "canvas-card-in 0.2s cubic-bezier(0.22,1,0.36,1) both",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
        <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.08em" }}>{label}</span>
        <button onClick={(e: any) => { posthog?.capture('graphnodecard_clicked'); const handler = onClose; if (typeof handler === 'function') (handler as any)(e); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "14px", lineHeight: 1 }}>×</button>
      </div>
      <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-primary)", wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: GraphNode["status"] }) {
  if (status !== "active" && status !== "thinking") return null;
  const isThinking = status === "thinking";
  const label = isThinking ? "THINKING" : "LIVE";
  const color = isThinking ? "#fbbf24" : "#22d3ee";
  return (
    <span style={{
      fontFamily: "'Commit Mono', monospace",
      fontSize: "9px",
      padding: "2px 7px",
      borderRadius: "100px",
      border: `1px solid ${color}55`,
      background: `${color}18`,
      color,
      flexShrink: 0,
      animation: "canvas-live-glow 1.6s ease-in-out infinite",
    }}>
      {label}
    </span>
  );
}

function toolStatusLabel(status: GraphNode["toolStatus"]): string {
  if (status === "failed") return "FAILED";
  if (status === "retrying") return "RETRYING";
  if (status === "success") return "COMPLETE";
  return "RUNNING";
}

function toolActivityTone(status: GraphNode["toolStatus"]): { border: string; text: string; bg: string } {
  if (status === "failed") {
    return { border: "rgba(248,113,113,0.38)", text: "#fca5a5", bg: "rgba(248,113,113,0.08)" };
  }
  if (status === "retrying") {
    return { border: "rgba(251,191,36,0.34)", text: "#fcd34d", bg: "rgba(251,191,36,0.08)" };
  }
  if (status === "success") {
    return { border: "rgba(52,211,153,0.32)", text: "#34d399", bg: "rgba(52,211,153,0.08)" };
  }
  return { border: "rgba(56,189,248,0.34)", text: "#7dd3fc", bg: "rgba(56,189,248,0.08)" };
}

function toolActivityLabel(name: string): string {
  return name.replace(/_/g, " ").trim().toUpperCase();
}

function isSandboxActivity(activity: ToolActivity): boolean {
  const name = activity.name.toLowerCase();
  return (
    name.includes("execute_python")
    || name.includes("python")
    || name.includes("sandbox")
    || typeof activity.details?.python_code_preview === "string"
    || typeof activity.details?.stdout_preview === "string"
    || typeof activity.details?.stderr_preview === "string"
  );
}

function sandboxActivityDetail(activity: ToolActivity): string {
  const stdoutPreview = typeof activity.details?.stdout_preview === "string"
    ? activity.details.stdout_preview.trim()
    : "";
  const stderrPreview = typeof activity.details?.stderr_preview === "string"
    ? activity.details.stderr_preview.trim()
    : "";
  const resultPreview = typeof activity.details?.result_preview === "string"
    ? activity.details.result_preview.trim()
    : "";
  const summary = activity.summary.trim();

  if (stderrPreview) return stderrPreview;
  if (stdoutPreview) return stdoutPreview;
  if (resultPreview) return resultPreview;
  return summary;
}

// ─── Icon button ──────────────────────────────────────────────────────────────
function QBtn({ onClick }: { onClick: () => void }) {
    const posthog = usePostHog();
  return (
    <button
      onClick={(e: any) => { posthog?.capture('graphnodecard_clicked'); const handler = (evt: any) => { evt.stopPropagation(); onClick(); }; if (typeof handler === 'function') (handler as any)(e); }}
      style={{
        background: "var(--bg-base)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "50%",
        width: "16px",
        height: "16px",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-muted)",
        fontSize: "9px",
        fontFamily: "'Commit Mono', monospace",
        flexShrink: 0,
        lineHeight: 1,
      }}
    >?</button>
  );
}

// ─── Main card ────────────────────────────────────────────────────────────────
interface GraphNodeCardProps { node: GraphNode; onShowMore?: () => void; }

const PREVIEW_LIMIT = 160;

function looksLikeJson(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

export function GraphNodeCard({ node, onShowMore }: GraphNodeCardProps) {
    const posthog = usePostHog();
  const [thinkingOpen,  setThinkingOpen]  = useState(false);
  const [telemetryOpen, setTelemetryOpen] = useState(false);
  const [infoOpen,      setInfoOpen]      = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => { injectCanvasKeyframes(); }, []);

  const inlineToolActivities = node.toolActivities ?? [];

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [inlineToolActivities]);

  const color = nodeColor(node);
  const glow  = glowColor(node);
  const isActive   = node.status === "active";
  const isThinking = node.status === "thinking";
  const isStreaming = isActive || isThinking;

  const isReceipt    = node.kind === "receipt";
  const isTask       = node.kind === "task";
  const isToolNode   = node.kind === "tool";
  const isSandboxTool = isToolNode && (
    node.toolName?.toLowerCase().includes("execute") ||
    node.toolName?.toLowerCase().includes("python") ||
    node.toolName?.toLowerCase().includes("sandbox")
  );
  const hasInlineToolActivities = !isToolNode && inlineToolActivities.length > 0;
  const hasThinking  = typeof node.thinkingContent === "string" && node.thinkingContent.length > 0;
  const inlineThinking = (!node.content || !node.content.trim()) && hasThinking
    ? node.thinkingContent ?? ""
    : "";
  const rawContent = node.content || inlineThinking || (hasInlineToolActivities ? "" : "—");
  const rawSupport = node.supportContent?.trim() || "";

  // Always cap the card preview at PREVIEW_LIMIT chars —
  // during streaming AND after completion.
  const previewSource = rawSupport ? `${rawContent}\n${rawSupport}` : rawContent;
  const exceedsLimit = !isReceipt && previewSource.length > PREVIEW_LIMIT;
  const previewText  = exceedsLimit
    ? previewSource.slice(0, PREVIEW_LIMIT)
    : (isReceipt && previewSource.length > 24 ? previewSource.slice(0, 24) + "…" : previewSource);

  const hasTelemetry = !!node.telemetry || node.confidence !== undefined;

  const infoLabel   = isTask ? "TASK ID"   : "FULL HASH";
  const infoValue   = isTask ? (node.taskId ?? "—") : rawContent;
  const showInfoBtn = isTask ? !!node.taskId : isReceipt && rawContent.length > 24;

  return (
    <div
      data-node-card="true"
      style={{
        width: NODE_WIDTH,
        background: "var(--bg-elevated)",
        border: `1.5px solid ${isActive ? color : `${color}88`}`,
        borderRadius: "14px",
        padding: "13px 14px 12px",
        display: "flex",
        flexDirection: "column",
        gap: "9px",
        boxShadow: `0 0 0 4px ${glow}, 0 4px 24px rgba(0,0,0,0.32)`,
        transition: "box-shadow 0.3s ease, border-color 0.3s ease",
        zIndex: 1,
        userSelect: "none",
        animation: "canvas-card-in 0.35s cubic-bezier(0.22,1,0.36,1) both",
        // Active cards get a subtle animated left accent
        borderLeft: isActive ? `3px solid ${color}` : undefined,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "7px", minWidth: 0, cursor: "grab" }}>
        <ProviderImg provider={node.provider} size={15} />
        <span style={{
          fontFamily: "'Commit Mono', monospace",
          fontSize: "9px",
          color,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          animation: isActive ? "canvas-active-border 2s ease-in-out infinite" : undefined,
        }}>
          {isToolNode ? (node.toolName ?? node.title) : (node.agentModel ?? node.title)}
        </span>
        {isToolNode ? (
          <span
            style={{
              fontFamily: "'Commit Mono', monospace",
              fontSize: "9px",
              padding: "2px 7px",
              borderRadius: "999px",
              border: `1px solid ${color}55`,
              background: `${color}12`,
              color,
              flexShrink: 0,
              letterSpacing: "0.08em",
            }}
          >
            {toolStatusLabel(node.toolStatus)}
          </span>
        ) : null}
        <StatusBadge status={node.status} />
      </div>

      {isToolNode ? (
        <div
          style={{
            border: `1px solid ${color}${isSandboxTool ? "55" : "40"}`,
            background: `linear-gradient(135deg, ${color}${isSandboxTool ? "1a" : "14"} 0%, transparent 100%)`,
            borderRadius: "12px",
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: "5px",
          }}
        >
          {isSandboxTool && (
            <div style={{
              fontFamily: "'Commit Mono', monospace",
              fontSize: "8px",
              color: `${color}99`,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}>
              Sandbox
            </div>
          )}
          <div
            style={{
              fontFamily: "'Commit Mono', monospace",
              fontSize: "9px",
              color,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {isSandboxTool ? `$ ${node.toolName ?? "execute"}` : (node.toolName ?? "tool operation")}
          </div>
          <div
            style={{
              fontFamily: "'Commit Mono', monospace",
              fontSize: "10px",
              color: "var(--text-muted)",
              lineHeight: 1.45,
            }}
          >
            {node.toolStatus === "failed"
              ? (isSandboxTool ? "Script exited with a non-zero code." : "Execution returned an error state.")
              : node.toolStatus === "retrying"
                ? (isSandboxTool ? "Retrying with corrected code." : "Retrying with corrected inputs.")
                : node.toolStatus === "success"
                  ? (isSandboxTool ? "Script ran to completion and returned output." : "Operation finished and returned structured evidence.")
                  : (isSandboxTool ? "Script is running in an isolated sandbox." : "Operation is running and streaming incremental output.")}
          </div>
        </div>
      ) : null}

      {hasInlineToolActivities ? (
        <div
          style={{
            position: "relative",
            border: `1px solid ${color}33`,
            background: "var(--bg-base)",
            borderRadius: "12px",
            overflow: "hidden",
          }}
        >
          {/* Top blur */}
          <div
            aria-hidden
            style={{
              position: "absolute", top: 0, left: 0, right: 0, height: "22px",
              background: "linear-gradient(to bottom, var(--bg-base), transparent)",
              pointerEvents: "none", zIndex: 2,
            }}
          />
          <div
            ref={streamRef}
            data-no-drag
            data-no-zoom
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              padding: "8px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              maxHeight: "118px",
              overflowY: "auto",
            }}
          >
            {inlineToolActivities.map((activity) => {
              const tone = toolActivityTone(activity.status);
              const sandboxActivity = isSandboxActivity(activity);
              const detailText = sandboxActivityDetail(activity);
              return (
                <div
                  key={activity.id}
                  style={{
                    border: `1px solid ${tone.border}`,
                    background: tone.bg,
                    borderRadius: "10px",
                    padding: "7px 8px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "5px",
                  }}
                >
                  {sandboxActivity ? (
                    <div
                      style={{
                        fontFamily: "'Commit Mono', monospace",
                        fontSize: "8px",
                        color: `${tone.text}AA`,
                        letterSpacing: "0.14em",
                        textTransform: "uppercase",
                      }}
                    >
                      Sandbox
                    </div>
                  ) : null}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                    <span
                      style={{
                        fontFamily: "'Commit Mono', monospace",
                        fontSize: "9px",
                        color: tone.text,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {sandboxActivity ? `$ ${activity.name}` : toolActivityLabel(activity.name)}
                    </span>
                    <span
                      style={{
                        fontFamily: "'Commit Mono', monospace",
                        fontSize: "8px",
                        color: tone.text,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        border: `1px solid ${tone.border}`,
                        borderRadius: "999px",
                        padding: "2px 5px",
                        background: "var(--bg-base)",
                        flexShrink: 0,
                      }}
                    >
                      {toolStatusLabel(activity.status)}
                    </span>
                  </div>
                  <div
                    style={{
                      fontFamily: "'Commit Mono', monospace",
                      fontSize: "10px",
                      color: "var(--text-muted)",
                      lineHeight: 1.45,
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {detailText}
                  </div>
                </div>
              );
            })}
          </div>
          {/* Bottom blur */}
          <div
            aria-hidden
            style={{
              position: "absolute", bottom: 0, left: 0, right: 0, height: "22px",
              background: "linear-gradient(to top, var(--bg-base), transparent)",
              pointerEvents: "none", zIndex: 2,
            }}
          />
        </div>
      ) : null}

      {/* Body — always capped at PREVIEW_LIMIT; "show more" opens the modal */}
      <div style={{
        position: "relative",
        minHeight: `${Math.max(36, Math.ceil(previewText.length / 42) * 20)}px`,
        transition: "min-height 0.38s ease-out",
      }}>
        {isStreaming ? (
          inlineThinking ? (
            <>
              <CanvasMarkdownText
                text={previewText}
                fontSize="12px"
                color="var(--text-muted)"
                italic
              />
              {exceedsLimit && (
                <span
                  data-no-drag
                  onClick={(e) => { e.stopPropagation(); onShowMore?.(); }}
                  style={{ color: "var(--text-muted)", marginLeft: "4px", fontSize: "11px", cursor: "pointer" }}
                >… show more</span>
              )}
            </>
          ) : (
            <>
              <CanvasStreamText
                text={previewText}
                isActive={!exceedsLimit}
                fontSize={isThinking ? "11px" : "12px"}
                color={isThinking ? "var(--text-muted)" : "var(--text-secondary)"}
                fontStyle={isThinking ? "italic" : "normal"}
              />
              {exceedsLimit && (
                <span
                  data-no-drag
                  onClick={(e) => { e.stopPropagation(); onShowMore?.(); }}
                  style={{ color: "var(--text-muted)", marginLeft: "4px", fontSize: "11px", cursor: "pointer" }}
                >… show more</span>
              )}
            </>
          )
        ) : (
          <>
            {inlineThinking ? (
              <CanvasMarkdownText
                text={previewText}
                fontSize="12px"
                color="var(--text-muted)"
                italic
              />
            ) : looksLikeJson(rawContent) ? (
              <span
                style={{
                  display: "block",
                  fontFamily: "'Commit Mono', monospace",
                  fontSize: "10px",
                  color: "var(--text-secondary)",
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  wordBreak: "break-all",
                }}
              >
                {previewText}
              </span>
            ) : (
              <CanvasMarkdownText
                text={previewText}
                fontSize="12px"
                color="var(--text-secondary)"
              />
            )}
            {exceedsLimit && (
              <span
                data-no-drag
                onClick={(e) => { e.stopPropagation(); onShowMore?.(); }}
                style={{ color: "var(--text-muted)", marginLeft: "4px", fontSize: "11px", cursor: "pointer" }}
              >… show more</span>
            )}
          </>
        )}
        {infoOpen && (
          <InfoPopover label={infoLabel} value={infoValue} onClose={() => setInfoOpen(false)} />
        )}
      </div>

      {/* Thinking toggle */}
      {hasThinking && (
        <div>
          <button
            onClick={(e: any) => { posthog?.capture('graphnodecard_thinking_chars_clicked'); const handler = () => setThinkingOpen((v) => !v); if (typeof handler === 'function') (handler as any)(e); }}
            style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", padding: 0, color: "var(--text-muted)", opacity: 0.65, fontFamily: "'Commit Mono', monospace", fontSize: "9px" }}
          >
            <span style={{ transform: thinkingOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s ease", display: "inline-block" }}>▶</span>
            thinking ({node.thinkingContent!.length} chars)
          </button>
          {thinkingOpen && (
            <div style={{
              marginTop: "6px", padding: "8px",
              background: "var(--bg-base)",
              borderRadius: "8px",
              border: "1px solid var(--border-subtle)",
              fontSize: "10px",
              fontFamily: "'Commit Mono', monospace",
              color: "var(--text-muted)",
              maxHeight: "120px",
              overflowY: "auto",
              wordBreak: "break-word",
              animation: "canvas-card-in 0.2s cubic-bezier(0.22,1,0.36,1) both",
            }}>
              <CanvasMarkdownText
                text={node.thinkingContent ?? ""}
                fontSize="10px"
                color="var(--text-muted)"
                italic
              />
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "8px", display: "flex", alignItems: "center", gap: "7px", position: "relative" }}>
        {isToolNode ? (
          <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color }}>
            {node.toolStatus === "failed" ? "error" : node.toolStatus === "retrying" ? "retry loop" : "op stream"}
          </span>
        ) : null}
        {node.confidence !== undefined && (
          <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)" }}>
            {(node.confidence * 100).toFixed(0)}% conf
          </span>
        )}
        {node.telemetry?.totalTokens !== undefined && (
          <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)" }}>
            {node.telemetry.totalTokens.toLocaleString()} tok
          </span>
        )}
        {node.telemetry?.latencyMs !== undefined && (
          <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)" }}>
            {Math.round(node.telemetry.latencyMs)}ms
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: "5px", alignItems: "center" }}>
          {showInfoBtn   && <QBtn onClick={() => setInfoOpen((v) => !v)} />}
          {hasTelemetry  && <QBtn onClick={() => setTelemetryOpen((v) => !v)} />}
        </div>
        {telemetryOpen && <TelemetryPopover node={node} onClose={() => setTelemetryOpen(false)} />}
      </div>
    </div>
  );
}
