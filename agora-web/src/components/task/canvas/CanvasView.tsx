import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProviderGlyph } from "../../ProviderGlyph";
import type { ProviderName } from "../../../lib/modelProviders";

// Track which node IDs have already received their entrance animation so that
// re-renders caused by streaming (position/content updates) don't re-trigger it.
const _animatedNodeIds = new Set<string>();
import { GraphEdges } from "./GraphEdges";
import { GraphNodeCard, CanvasStreamText, NODE_WIDTH, NODE_HEIGHT, NODE_GAP_H, NODE_GAP_V } from "./GraphNodeCard";
import { QuorumOverlay } from "./QuorumOverlay";
import { useGraphLayout } from "./useGraphLayout";
import type { GraphNode, NodeKind } from "./canvasTypes";
import { usePostHog } from "@posthog/react";

interface TimelineEventLike {
  key: string; type: string; title: string; summary: string;
  agentId?: string; agentModel?: string; confidence?: number;
  stage?: string; isDraft?: boolean; details?: Record<string, unknown>;
}

interface CanvasViewProps {
  timeline: TimelineEventLike[];
  finalAnswer: { text: string; confidence: number; mechanism: string } | null;
  taskId: string | undefined;
  taskText?: string;
  mechanism: string;
  roundCount: number;
  eventCount: number;
  entropy?: number;
}

interface TransitionPill {
  id: string;
  node: GraphNode;
  outgoingCount: number;
  x: number;
  y: number;
  label: string;
  description: string;
}

// ─── Stage colors (shared) ────────────────────────────────────────────────────
const KIND_COLOR: Record<NodeKind, string> = {
  task:        "#6b7280",
  selector:    "#a78bfa",
  agent:       "#22d3ee",
  crossexam:   "#fbbf24",
  convergence: "#c084fc",
  switch:      "#fb923c",
  quorum:      "#34d399",
  receipt:     "#38bdf8",
};
function stageColor(kind: NodeKind, stage?: string): string {
  if (kind !== "agent") return KIND_COLOR[kind];
  if (stage?.includes("rebuttal")) return "#60a5fa";
  return "#22d3ee";
}

function transitionPillText(node: GraphNode): { label: string; description: string } {
  return {
    label: node.transitionLabel ?? node.stage.toUpperCase(),
    description: node.transitionDescription ?? `${node.title} advanced the graph.`,
  };
}

function SplitTransitionPill({
  pill,
  onOpen,
}: {
  pill: TransitionPill;
  onOpen: (nodeId: string) => void;
}) {
    const posthog = usePostHog();
  const color = stageColor(pill.node.kind, pill.node.stage);
  return (
    <button
      type="button"
      data-no-drag
      title={pill.description}
      aria-label={`${pill.label}: ${pill.description}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(e: any) => { posthog?.capture('canvasview_action_clicked'); const handler = (event: any) => {
                        event.stopPropagation();
                        onOpen(pill.node.id);
                      }; if (typeof handler === 'function') (handler as any)(e); }}
      style={{
        position: "absolute",
        left: pill.x,
        top: pill.y,
        transform: "translate(-50%, -50%)",
        zIndex: 4,
        maxWidth: "220px",
        border: `1px solid ${color}`,
        borderRadius: "999px",
        background: "rgba(8, 13, 18, 0.92)",
        color,
        padding: "5px 10px",
        boxShadow: `0 0 0 3px rgba(0,0,0,0.28), 0 8px 22px rgba(0,0,0,0.32)`,
        fontFamily: "'Commit Mono', monospace",
        fontSize: "9px",
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        cursor: "pointer",
        pointerEvents: "auto",
      }}
    >
      {pill.label}
      <span
        aria-hidden="true"
        style={{
          marginLeft: "7px",
          color: "var(--text-muted)",
          fontWeight: 500,
          letterSpacing: 0,
        }}
      >
        x{pill.outgoingCount}
      </span>
    </button>
  );
}

// ─── Expanded card modal (Top Right, Slimmer) ──────────────────────────────────
const MODAL_STYLE_ID = "canvas-modal-kf";
function injectModalKeyframes() {
  if (typeof document === "undefined" || document.getElementById(MODAL_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = MODAL_STYLE_ID;
  s.textContent = `
    @keyframes canvas-modal-in {
      from { opacity: 0; transform: translateX(20px) scale(0.96); }
      to   { opacity: 1; transform: translateX(0)    scale(1);    }
    }
    @keyframes canvas-node-in {
      from { opacity: 0; transform: scale(0.85) translateY(12px); }
      to   { opacity: 1; transform: scale(1)    translateY(0);    }
    }
  `;
  document.head.appendChild(s);
}

function ExpandedCardModal({ node, onClose }: { node: GraphNode; onClose: () => void }) {
    const posthog = usePostHog();
  const color = stageColor(node.kind, node.stage);
  const t = node.telemetry;
  const [showTelemetry, setShowTelemetry] = useState(false);

  useEffect(() => { injectModalKeyframes(); }, []);

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      data-modal="true"
      style={{
        position: "absolute",
        top: "20px",
        right: "20px",
        width: "400px",
        maxHeight: "calc(100% - 60px)",
        background: "var(--bg-elevated)",
        border: `1.5px solid ${color}`,
        borderRadius: "20px",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        boxShadow: `0 24px 60px rgba(0,0,0,0.45), 0 0 0 1px var(--border-subtle)`,
        zIndex: 2000,
        pointerEvents: "auto",
        backdropFilter: "blur(20px)",
        animation: "canvas-modal-in 0.28s cubic-bezier(0.22,1,0.36,1) both",
      }}
    >
      {/* Header */}
      <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
        {node.provider && (
          <div style={{ width: "16px", height: "16px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <ProviderGlyph provider={node.provider as ProviderName} size={16} />
          </div>
        )}
        <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "11px", fontWeight: 600, color, textTransform: "uppercase", letterSpacing: "0.08em", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.agentModel ?? node.title}</span>
        <button
          onClick={(e: any) => { posthog?.capture('canvasview_clicked'); const handler = (e: any) => { e.stopPropagation(); onClose(); }; if (typeof handler === 'function') (handler as any)(e); }}
          style={{ 
            background: "var(--bg-base)", 
            border: "1px solid var(--border-default)", 
            borderRadius: "50%", 
            cursor: "pointer", 
            color: "var(--text-muted)", 
            fontSize: "16px", 
            width: "28px", 
            height: "28px", 
            display: "flex", 
            alignItems: "center", 
            justifyContent: "center", 
            transition: "all 0.15s ease",
            padding: 0,
            lineHeight: 1,
          }}
        >×</button>
      </div>

      {/* Scrollable content */}
      <div style={{ overflowY: "auto", flex: 1, padding: "20px", position: "relative" }}>
        {node.transitionDescription && (
          <div style={{ marginBottom: "18px", padding: "12px 14px", background: "var(--bg-base)", border: `1px solid ${color}88`, borderRadius: "8px" }}>
            <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "9px", color, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "6px", fontWeight: 700 }}>
              {node.transitionLabel ?? "Transition"}
            </div>
            <div style={{ fontSize: "12px", lineHeight: 1.55, color: "var(--text-secondary)" }}>
              {node.transitionDescription}
            </div>
          </div>
        )}

        <div style={{ marginBottom: "20px" }}>
          {node.status === "active" ? (
            <CanvasStreamText
              text={node.content || "—"}
              isActive
              fontSize="13px"
              color="var(--text-primary)"
            />
          ) : (
            <div style={{ fontSize: "13px", lineHeight: 1.65, color: "var(--text-primary)" }}>
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{
                  p: ({ children }) => <p style={{ margin: "0 0 10px" }}>{children}</p>,
                  h1: ({ children }) => <h1 style={{ fontSize: "16px", fontWeight: 700, margin: "0 0 8px", color: "var(--text-primary)" }}>{children}</h1>,
                  h2: ({ children }) => <h2 style={{ fontSize: "14px", fontWeight: 700, margin: "0 0 8px", color: "var(--text-primary)" }}>{children}</h2>,
                  h3: ({ children }) => <h3 style={{ fontSize: "13px", fontWeight: 600, margin: "0 0 6px", color: "var(--text-primary)" }}>{children}</h3>,
                  ul: ({ children }) => <ul style={{ margin: "0 0 10px", paddingLeft: "18px", listStyleType: "disc" }}>{children}</ul>,
                  ol: ({ children }) => <ol style={{ margin: "0 0 10px", paddingLeft: "18px", listStyleType: "decimal" }}>{children}</ol>,
                  li: ({ children }) => <li style={{ marginBottom: "3px" }}>{children}</li>,
                  strong: ({ children }) => <strong style={{ fontWeight: 700, color: "var(--text-primary)" }}>{children}</strong>,
                  em: ({ children }) => <em style={{ fontStyle: "italic", color: "var(--text-secondary)" }}>{children}</em>,
                  blockquote: ({ children }) => <blockquote style={{ borderLeft: "2px solid var(--accent-emerald)", paddingLeft: "10px", margin: "0 0 10px", color: "var(--text-secondary)", fontStyle: "italic" }}>{children}</blockquote>,
                  code: (props) => {
                    const { children, className } = props as { children?: React.ReactNode; className?: string };
                    const isBlock = className?.includes("language-");
                    return isBlock
                      ? <code style={{ display: "block", fontFamily: "'Commit Mono', monospace", fontSize: "11px", background: "var(--bg-base)", border: "1px solid var(--border-subtle)", borderRadius: "8px", padding: "10px 12px", overflowX: "auto", whiteSpace: "pre", color: "var(--text-secondary)", margin: "0 0 10px" }}>{children}</code>
                      : <code style={{ fontFamily: "'Commit Mono', monospace", fontSize: "11px", background: "var(--bg-base)", borderRadius: "4px", padding: "1px 5px", color: "var(--text-primary)" }}>{children}</code>;
                  },
                  pre: ({ children }) => <pre style={{ margin: "0 0 10px", overflow: "hidden" }}>{children}</pre>,
                  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" style={{ color: "var(--accent-emerald)", textDecoration: "underline", textUnderlineOffset: "2px" }}>{children}</a>,
                  hr: () => <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle)", margin: "12px 0" }} />,
                }}
              >
                {node.content || "—"}
              </Markdown>
            </div>
          )}
        </div>

        {/* Thinking stream */}
        {node.thinkingContent && (
          <details style={{ marginBottom: "20px" }}>
            <summary style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)", cursor: "pointer", userSelect: "none", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "8px" }}>▼</span> THINKING ({node.thinkingContent.length} chars)
            </summary>
            <div style={{ marginTop: "10px", padding: "12px", background: "var(--bg-base)", borderRadius: "12px", border: "1px solid var(--border-subtle)", fontSize: "11px", fontFamily: "'Commit Mono', monospace", color: "var(--text-muted)", whiteSpace: "pre-wrap", lineHeight: 1.55 }}>
              {node.thinkingContent}
            </div>
          </details>
        )}

        {/* Telemetry section */}
        {(t || node.confidence !== undefined) && (
          <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "16px" }}>
            <div
              onClick={(e) => { e.stopPropagation(); setShowTelemetry(!showTelemetry); }}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", marginBottom: showTelemetry ? "12px" : "0" }}
            >
              <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.1em", fontWeight: 600 }}>TELEMETRY</div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {!showTelemetry && <span style={{ fontSize: "10px", color: "var(--text-muted)", opacity: 0.7 }}>View telemetry</span>}
                <div style={{ 
                  width: "20px", height: "20px", borderRadius: "50%", background: "var(--bg-base)", border: "1px solid var(--border-subtle)",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: "9px", color: "var(--text-muted)",
                  transform: showTelemetry ? "rotate(180deg)" : "none", transition: "transform 0.2s ease"
                }}>▼</div>
              </div>
            </div>

            {showTelemetry && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginTop: "12px" }}>
                {node.confidence !== undefined && <CompactMetaTile label="Confidence" value={`${(node.confidence * 100).toFixed(1)}%`} />}
                {t?.inputTokens !== undefined && t?.outputTokens !== undefined && <CompactMetaTile label="Tokens (In/Out)" value={`${t.inputTokens}/${t.outputTokens}`} />}
                {t?.thinkingTokens !== undefined && <CompactMetaTile label="Thinking" value={String(t.thinkingTokens)} />}
                {t?.latencyMs !== undefined && <CompactMetaTile label="Latency" value={`${(t.latencyMs / 1000).toFixed(1)}s`} />}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom-edge fade — clips to the modal's border-radius via parent overflow:hidden */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: "72px",
          background: "linear-gradient(to bottom, transparent 0%, var(--bg-elevated) 100%)",
          pointerEvents: "none",
          zIndex: 10,
          borderRadius: "0 0 18px 18px",
        }}
      />
    </div>
  );
}

function CompactMetaTile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "10px 14px", background: "var(--bg-base)", borderRadius: "12px", border: "1px solid var(--border-subtle)" }}>
      <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "9px", color: "var(--text-muted)", marginBottom: "4px", letterSpacing: "0.05em" }}>{label.toUpperCase()}</div>
      <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "12px", color: "var(--text-primary)", fontWeight: 500 }}>{value}</div>
    </div>
  );
}

// ─── Status / toolbar ─────────────────────────────────────────────────────────
function StatusBar({ mechanism, roundCount, eventCount, entropy, nodeCount, isFullscreen, onFullscreen, onReset }: {
  mechanism: string; roundCount: number; eventCount: number; entropy?: number; nodeCount: number;
  isFullscreen: boolean; onFullscreen: () => void; onReset: () => void;
}) {
    const posthog = usePostHog();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "14px", padding: "8px 14px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0, flexWrap: "wrap", rowGap: "5px" }}>
      <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", padding: "3px 10px", borderRadius: "100px", background: "rgba(34,211,238,0.10)", color: "#22d3ee", border: "1px solid rgba(34,211,238,0.3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        {mechanism || "DEBATE"}
      </span>
      <Dot /><Stat label="Round" value={String(roundCount || 1)} />
      <Dot /><Stat label="Nodes" value={String(nodeCount)} />
      <Dot /><Stat label="Events" value={String(eventCount)} />
      {entropy !== undefined && <><Dot /><Stat label="Entropy" value={entropy.toFixed(2)} /></>}
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-muted)" }}>Drag · Scroll to zoom</span>
        <button onClick={(e: any) => { posthog?.capture('canvasview_fit_to_content_clicked'); const handler = onReset; if (typeof handler === 'function') (handler as any)(e); }} title="Fit to content" style={iconBtn}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <circle cx="7" cy="7" r="2.5" />
            <line x1="7" y1="0.5" x2="7" y2="3.5" />
            <line x1="7" y1="10.5" x2="7" y2="13.5" />
            <line x1="0.5" y1="7" x2="3.5" y2="7" />
            <line x1="10.5" y1="7" x2="13.5" y2="7" />
          </svg>
        </button>
        <button onClick={(e: any) => { posthog?.capture('canvasview_action_clicked'); const handler = onFullscreen; if (typeof handler === 'function') (handler as any)(e); }} title={isFullscreen ? "Exit fullscreen" : "Fullscreen"} style={iconBtn}>
          {isFullscreen
            ? <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8" /></svg>
            : <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M4 1H1v3M8 1h3v3M1 8v3h3M8 11h3V8" /></svg>
          }
        </button>
      </div>
    </div>
  );
}
const iconBtn: React.CSSProperties = { background: "var(--bg-base)", border: "1px solid var(--border-default)", borderRadius: "7px", padding: "5px 7px", cursor: "pointer", color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center" };
function Stat({ label, value }: { label: string; value: string }) {
  return <span style={{ fontFamily: "'Commit Mono', monospace", fontSize: "10px", color: "var(--text-secondary)" }}><span style={{ color: "var(--text-muted)", marginRight: "4px" }}>{label}</span>{value}</span>;
}
function Dot() { return <span style={{ color: "var(--border-strong)", fontSize: "10px" }}>·</span>; }

// ─── Empty state ───────────────────────────────────────────────────────────────
function EmptyCanvas({ awaitingStream }: { awaitingStream: boolean }) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "16px", color: "var(--text-muted)", pointerEvents: "none" }}>
      {awaitingStream ? (
        <>
          <style>{`@keyframes c-orbit{from{transform:rotate(0deg) translateX(22px) rotate(0deg)}to{transform:rotate(360deg) translateX(22px) rotate(-360deg)}}`}</style>
          <div style={{ position: "relative", width: "56px", height: "56px" }}>
            <div style={{ position: "absolute", inset: 0, border: "1.5px dashed var(--border-default)", borderRadius: "50%", opacity: 0.5 }} />
            <div style={{ position: "absolute", top: "50%", left: "50%", width: "8px", height: "8px", borderRadius: "50%", background: "#34d399", marginTop: "-4px", marginLeft: "-4px", animation: "c-orbit 2.2s linear infinite" }} />
          </div>
        </>
      ) : (
        <div style={{
          width: "56px",
          height: "56px",
          borderRadius: "50%",
          border: "1.5px solid var(--border-default)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'Commit Mono', monospace",
          fontSize: "18px",
          color: "#f59e0b",
        }}>
          !
        </div>
      )}
      <div style={{ textAlign: "center" }}>
        <div style={{ fontFamily: "'Commit Mono', monospace", fontSize: "11px", letterSpacing: "0.06em", marginBottom: "6px" }}>
          {awaitingStream ? "AWAITING STREAM" : "EVENT HISTORY MISSING"}
        </div>
        <div style={{ fontSize: "12px" }}>
          {awaitingStream
            ? "Nodes will appear as the deliberation runs"
            : "We have the result, but the event graph is still being recovered."}
        </div>
      </div>
    </div>
  );
}

// ─── Drag state ───────────────────────────────────────────────────────────────
type DragState =
  | { kind: "none" }
  | { kind: "pan"; lastX: number; lastY: number }
  | { kind: "card"; nodeId: string; lastX: number; lastY: number };

// ─── Canvas crosshatch grid (Theme aware) ────────────────────────────────────
const GRID_BG_LIGHT = `
  linear-gradient(rgba(0,0,0,0.12) 1px, transparent 1px),
  linear-gradient(90deg, rgba(0,0,0,0.12) 1px, transparent 1px)
`.trim();
const GRID_BG_DARK = `
  linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px),
  linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)
`.trim();

// ─── Main component ───────────────────────────────────────────────────────────
export function CanvasView({ timeline, finalAnswer, taskId, taskText, mechanism, roundCount, eventCount, entropy }: CanvasViewProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const hasFitRef     = useRef(false);
  const scaleRef      = useRef(1);
  const drag          = useRef<DragState>({ kind: "none" });

  const [transform, setTransform] = useState({ x: 60, y: 60, scale: 0.85 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cardOffsets, setCardOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);

  // Track actual rendered card heights so edge source Y exits from the real card bottom.
  const [nodeHeights, setNodeHeights] = useState(() => new Map<string, number>());
  const resizeObsRef = useRef<ResizeObserver | null>(null);

  const ensureResizeObserver = useCallback(() => {
    if (!resizeObsRef.current && typeof ResizeObserver !== "undefined") {
      resizeObsRef.current = new ResizeObserver((entries) => {
        setNodeHeights((prev) => {
          let next: Map<string, number> | null = null;
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.cardId;
            if (!id) continue;
            const h = Math.round(e.contentRect.height);
            if ((next ?? prev).get(id) !== h) {
              next ??= new Map(prev);
              next.set(id, h);
            }
          }
          return next ?? prev;
        });
      });
    }
    return resizeObsRef.current;
  }, []);

  const observeNodeCard = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    ensureResizeObserver()?.observe(el);
  }, [ensureResizeObserver]);

  useEffect(() => {
    const observer = resizeObsRef.current;
    return () => {
      observer?.disconnect();
      resizeObsRef.current = null;
    };
  }, []);
  // Detect theme for grid — app uses data-theme="light" on <html>
  const [isDarkMode, setIsDarkMode] = useState(
    () => document.documentElement.getAttribute("data-theme") !== "light"
  );
  useEffect(() => {
    const checkTheme = () => {
      setIsDarkMode(document.documentElement.getAttribute("data-theme") !== "light");
    };
    checkTheme();
    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => { scaleRef.current = transform.scale; }, [transform.scale]);

  const { nodes, edges } = useGraphLayout(timeline, { taskText, taskId });

  const byRow = useMemo(() => {
    const m = new Map<number, GraphNode[]>();
    for (const n of nodes) {
      const arr = m.get(n.row) ?? [];
      arr.push(n);
      m.set(n.row, arr);
    }
    return m;
  }, [nodes]);

  const maxRowWidth = useMemo(() => {
    let w = 0;
    for (const arr of byRow.values()) {
      const rw = arr.length * NODE_WIDTH + Math.max(0, arr.length - 1) * NODE_GAP_H;
      if (rw > w) w = rw;
    }
    return Math.max(w, NODE_WIDTH);
  }, [byRow]);

  const basePos = useCallback((node: GraphNode) => {
    const rowNodes = byRow.get(node.row) ?? [];
    const rowWidth = rowNodes.length * NODE_WIDTH + Math.max(0, rowNodes.length - 1) * NODE_GAP_H;
    const offsetX = (maxRowWidth - rowWidth) / 2;
    return {
      x: offsetX + node.col * (NODE_WIDTH + NODE_GAP_H),
      y: node.row * (NODE_HEIGHT + NODE_GAP_V),
    };
  }, [byRow, maxRowWidth]);

  const finalPos = useCallback((node: GraphNode) => {
    const b = basePos(node);
    const off = cardOffsets[node.id] ?? { dx: 0, dy: 0 };
    return { x: b.x + off.dx, y: b.y + off.dy };
  }, [basePos, cardOffsets]);

  const positions = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of nodes) m.set(n.id, finalPos(n));
    return m;
  }, [nodes, finalPos]);

  const splitTransitionPills = useMemo<TransitionPill[]>(() => {
    const outgoingCounts = new Map<string, number>();
    for (const edge of edges) {
      outgoingCounts.set(edge.fromNodeId, (outgoingCounts.get(edge.fromNodeId) ?? 0) + 1);
    }

    return nodes.flatMap((node) => {
      const outgoingCount = outgoingCounts.get(node.id) ?? 0;
      if (outgoingCount < 2) {
        return [];
      }
      const pos = positions.get(node.id);
      if (!pos) {
        return [];
      }
      const { label, description } = transitionPillText(node);
      return [{
        id: `transition:${node.id}`,
        node,
        outgoingCount,
        x: pos.x + NODE_WIDTH / 2,
        y: pos.y + (nodeHeights.get(node.id) ?? NODE_HEIGHT) + 16,
        label,
        description,
      }];
    });
  }, [edges, nodeHeights, nodes, positions]);

  const maxRow = nodes.reduce((m, n) => Math.max(m, n.row), 0);
  const canvasW = maxRowWidth + 160;
  const canvasH = (maxRow + 1) * (NODE_HEIGHT + NODE_GAP_V) + 160;

  const fitToContent = useCallback(() => {
    if (!containerRef.current || nodes.length <= 1) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const PADDING = 80;
    const scaleW = (rect.width  - PADDING) / canvasW;
    const scaleH = (rect.height - PADDING) / canvasH;
    const scale  = Math.min(0.9, scaleW, scaleH);
    const x = (rect.width  - canvasW * scale) / 2;
    const y = PADDING / 2;
    setTransform({ x, y, scale });
  }, [canvasW, canvasH, nodes.length]);

  useEffect(() => {
    if (hasFitRef.current || nodes.length <= 1) return;
    const id = setTimeout(() => { fitToContent(); hasFitRef.current = true; }, 80);
    return () => clearTimeout(id);
  }, [nodes.length, fitToContent]);

  useEffect(() => {
    hasFitRef.current = false;
    _animatedNodeIds.clear();
  }, [taskId]);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((v) => {
      if (!v) setTimeout(() => fitToContent(), 60);
      return !v;
    });
  }, [fitToContent]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-modal="true"]')) return;

    const cardEl = target.closest<HTMLElement>("[data-card-id]");
    const isInteractive = !!target.closest("button, details, summary, input, a, [data-no-drag]");

    if (cardEl && !isInteractive) {
      drag.current = { kind: "card", nodeId: cardEl.dataset.cardId!, lastX: e.clientX, lastY: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } else if (!cardEl && !isInteractive) {
      drag.current = { kind: "pan", lastX: e.clientX, lastY: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const cur = drag.current;
    if (cur.kind === "none") return;
    const dx = e.clientX - cur.lastX;
    const dy = e.clientY - cur.lastY;
    drag.current = { ...cur, lastX: e.clientX, lastY: e.clientY };

    if (cur.kind === "pan") {
      setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
    } else {
      const s = scaleRef.current;
      setCardOffsets((o) => {
        const prev = o[cur.nodeId] ?? { dx: 0, dy: 0 };
        return { ...o, [cur.nodeId]: { dx: prev.dx + dx / s, dy: prev.dy + dy / s } };
      });
    }
  }, []);

  const onPointerUp = useCallback(() => { drag.current = { kind: "none" }; }, []);

  const onWheel = useCallback((e: WheelEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-modal="true"]')) return;

    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.95 : 1.05;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setTransform((t) => {
      const ns = Math.min(2.5, Math.max(0.2, t.scale * factor));
      const r  = ns / t.scale;
      return { x: cx - r * (cx - t.x), y: cy - r * (cy - t.y), scale: ns };
    });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const isEmpty = nodes.length <= 1;
  const awaitingStream = isEmpty && !finalAnswer;
  const expandedNode = expandedNodeId ? nodes.find((n) => n.id === expandedNodeId) ?? null : null;

  return (
    <div style={isFullscreen
      ? { position: "fixed", inset: 0, zIndex: 9999, display: "flex", flexDirection: "column", background: "var(--bg-base)" }
      : { display: "flex", flexDirection: "column", height: "100%", minHeight: "600px", position: "relative" }
    }>
      <StatusBar
        mechanism={mechanism} roundCount={roundCount} eventCount={eventCount}
        entropy={entropy} nodeCount={nodes.length}
        isFullscreen={isFullscreen} onFullscreen={toggleFullscreen}
        onReset={fitToContent}
      />

      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        style={{
          flex: 1, overflow: "hidden", position: "relative", touchAction: "none",
          backgroundColor: "var(--bg-base)",
          backgroundImage: isDarkMode ? GRID_BG_DARK : GRID_BG_LIGHT,
          backgroundSize: "28px 28px",
          cursor: "grab",
        }}
      >
        {isEmpty ? <EmptyCanvas awaitingStream={awaitingStream} /> : (
          <div style={{
            position: "absolute", transformOrigin: "0 0",
            transform: `translate(${transform.x}px,${transform.y}px) scale(${transform.scale})`,
            width: canvasW, height: canvasH, willChange: "transform",
          }}>
            <GraphEdges edges={edges} positions={positions} nodeHeights={nodeHeights} totalWidth={canvasW} totalHeight={canvasH} />
            {splitTransitionPills.map((pill) => (
              <SplitTransitionPill
                key={pill.id}
                pill={pill}
                onOpen={setExpandedNodeId}
              />
            ))}
            {nodes.map((node: GraphNode) => {
              const { x, y } = finalPos(node);
              const isNew = !_animatedNodeIds.has(node.id);
              if (isNew) _animatedNodeIds.add(node.id);
              return (
                <div
                  key={node.id}
                  data-card-id={node.id}
                  ref={observeNodeCard}
                  style={{
                    position: "absolute",
                    left: x,
                    top: y,
                    zIndex: 1,
                    animation: isNew
                      ? "canvas-node-in 0.38s cubic-bezier(0.22,1,0.36,1) both"
                      : undefined,
                  }}
                >
                  <GraphNodeCard
                    node={node}
                    onShowMore={() => setExpandedNodeId(node.id)}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Expanded card overlay (Top Right) */}
        {expandedNode && (
          <ExpandedCardModal
            node={expandedNode}
            onClose={() => setExpandedNodeId(null)}
          />
        )}

        {/* Ensure QuorumOverlay is seen as a modal to prevent canvas interference */}
        <div data-modal="true">
          <QuorumOverlay finalAnswer={finalAnswer} taskId={taskId} />
        </div>
      </div>
    </div>
  );
}
