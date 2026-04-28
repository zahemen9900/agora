import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, ScrollText } from "lucide-react";

import { CanvasView } from "../task/canvas/CanvasView";
import {
  buildBenchmarkOverviewGraph,
  type BenchmarkOverviewNode,
} from "../../lib/benchmarkCanvas";
import {
  buildDeliberationTimeline,
  deriveFinalAnswerFromEvents,
  type FinalAnswerState,
} from "../../lib/deliberationTimeline";
import type {
  BenchmarkDetailPayload,
  BenchmarkItemPayload,
  TaskEvent,
} from "../../lib/api";

const GRID_BG_DARK = [
  "linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)",
  "linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)",
].join(",");

const GRID_BG_LIGHT = [
  "linear-gradient(rgba(0,0,0,0.10) 1px, transparent 1px)",
  "linear-gradient(90deg, rgba(0,0,0,0.10) 1px, transparent 1px)",
].join(",");

const LANE_HEIGHT = 220;
const NODE_WIDTH = 254;
const NODE_HEIGHT = 148;
const NODE_GAP_X = 44;
const PADDING_X = 210;
const PADDING_Y = 72;

interface BenchmarkLiveCanvasProps {
  benchmarkId: string;
  benchmarkStatus: BenchmarkDetailPayload["status"] | null | undefined;
  items: BenchmarkItemPayload[];
  selectedItem: BenchmarkItemPayload | null;
  selectedItemTimeline: TaskEvent[];
  activeItemId: string | null;
  totalTokens: number;
  totalLatencyMs: number | null | undefined;
  dominantMechanism: string | null;
  layer: "overview" | "item";
  onLayerChange: (layer: "overview" | "item") => void;
  onSelectItem: (itemId: string) => void;
  onOpenLogs: () => void;
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  return Math.round(value).toLocaleString();
}

function formatLatency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return "";
  }
  return `${Math.round(value)} ms`;
}

const STATUS_STYLE: Record<string, { border: string; color: string; bg: string }> = {
  completed: { border: "rgba(52,211,153,0.55)",  color: "#6ee7b7", bg: "rgba(52,211,153,0.08)" },
  degraded:  { border: "rgba(251,191,36,0.55)",  color: "#fcd34d", bg: "rgba(251,191,36,0.08)" },
  failed:    { border: "rgba(248,113,113,0.55)", color: "#fca5a5", bg: "rgba(248,113,113,0.08)" },
  running:   { border: "rgba(34,211,238,0.65)",  color: "#67e8f9", bg: "rgba(34,211,238,0.10)" },
  summary:   { border: "rgba(167,139,250,0.55)", color: "#c4b5fd", bg: "rgba(167,139,250,0.08)" },
  pending:   { border: "rgba(148,163,184,0.35)", color: "#94a3b8", bg: "rgba(148,163,184,0.05)" },
};

function statusStyle(status: BenchmarkOverviewNode["status"]) {
  return STATUS_STYLE[status] ?? STATUS_STYLE.pending;
}



function mechanismPill(node: BenchmarkOverviewNode): string | null {
  if (node.mechanism && node.mechanism.trim()) {
    return titleCase(node.mechanism);
  }
  if (node.kind === "item" && (node.status === "pending" || node.status === "running")) {
    return "Pending mechanism";
  }
  return null;
}

function tokenPill(node: BenchmarkOverviewNode): string | null {
  if (node.totalTokens > 0) {
    return `${formatInt(node.totalTokens)} tok`;
  }
  return null;
}

function latencyPill(node: BenchmarkOverviewNode): string | null {
  const label = formatLatency(node.totalLatencyMs);
  return label || null;
}

function finalSummaryLine(node: BenchmarkOverviewNode): string {
  const parts = [node.question];
  if (node.totalTokens > 0) {
    parts.push(`${formatInt(node.totalTokens)} tokens`);
  }
  const latency = formatLatency(node.totalLatencyMs);
  if (latency) {
    parts.push(latency);
  }
  return parts.join(" · ");
}

const LANE_PALETTES = [
  { border: "rgba(34,211,238,0.38)",  glow: "rgba(34,211,238,0.10)",  label: "#67e8f9",  edge: "rgba(34,211,238,0.75)" },
  { border: "rgba(52,211,153,0.35)",  glow: "rgba(52,211,153,0.09)",  label: "#6ee7b7",  edge: "rgba(52,211,153,0.75)" },
  { border: "rgba(251,191,36,0.32)",  glow: "rgba(251,191,36,0.08)",  label: "#fcd34d",  edge: "rgba(251,191,36,0.75)" },
  { border: "rgba(167,139,250,0.35)", glow: "rgba(167,139,250,0.09)", label: "#c4b5fd",  edge: "rgba(167,139,250,0.75)" },
];

function lanePalette(index: number) {
  return LANE_PALETTES[index % LANE_PALETTES.length];
}

function viewStatusStyle(status: BenchmarkDetailPayload["status"] | null | undefined) {
  if (status === "completed") return { border: "rgba(52,211,153,0.55)",  bg: "rgba(52,211,153,0.10)",  color: "#6ee7b7" };
  if (status === "failed")    return { border: "rgba(248,113,113,0.55)", bg: "rgba(248,113,113,0.10)", color: "#fca5a5" };
  if (status === "running")  return { border: "rgba(34,211,238,0.65)",  bg: "rgba(34,211,238,0.10)",  color: "#67e8f9" };
  return { border: "rgba(148,163,184,0.35)", bg: "rgba(0,0,0,0.20)", color: "#94a3b8" };
}

function nodePosition(node: BenchmarkOverviewNode, laneCount: number, maxColIndex: number): { x: number; y: number } {
  if (node.kind === "final") {
    const centerLane = laneCount > 1 ? (laneCount - 1) / 2 : 0;
    return {
      x: PADDING_X + maxColIndex * (NODE_WIDTH + NODE_GAP_X),
      y: PADDING_Y + centerLane * LANE_HEIGHT,
    };
  }
  return {
    x: PADDING_X + node.colIndex * (NODE_WIDTH + NODE_GAP_X),
    y: PADDING_Y + node.laneIndex * LANE_HEIGHT,
  };
}

function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const startX = from.x + NODE_WIDTH;
  const startY = from.y + NODE_HEIGHT / 2;
  const endX = to.x;
  const endY = to.y + NODE_HEIGHT / 2;
  const delta = Math.max(80, (endX - startX) * 0.45);
  return `M ${startX} ${startY} C ${startX + delta} ${startY}, ${endX - delta} ${endY}, ${endX} ${endY}`;
}

function summaryRecord(item: BenchmarkItemPayload | null): Record<string, unknown> {
  if (!item || typeof item.summary !== "object" || item.summary === null || Array.isArray(item.summary)) {
    return {};
  }
  return item.summary as Record<string, unknown>;
}

function deriveItemFinalAnswer(
  item: BenchmarkItemPayload | null,
  events: TaskEvent[],
  fallbackMechanism: string,
): FinalAnswerState | null {
  const summary = summaryRecord(item);
  const summaryAnswer = typeof summary.final_answer === "string" ? summary.final_answer.trim() : "";
  if (summaryAnswer) {
    return {
      text: summaryAnswer,
      confidence: typeof summary.confidence === "number" ? summary.confidence : 0,
      mechanism: item?.mechanism ?? fallbackMechanism,
    };
  }
  return deriveFinalAnswerFromEvents(events, fallbackMechanism);
}

function deriveItemRoundCount(item: BenchmarkItemPayload | null, timeline: ReturnType<typeof buildDeliberationTimeline>): number {
  const summary = summaryRecord(item);
  if (typeof summary.rounds === "number" && Number.isFinite(summary.rounds) && summary.rounds > 0) {
    return Math.round(summary.rounds);
  }
  return timeline.reduce((max, event) => Math.max(max, event.segmentRound ?? 0), 1);
}

function deriveItemEntropy(item: BenchmarkItemPayload | null, timeline: ReturnType<typeof buildDeliberationTimeline>): number | undefined {
  const summary = summaryRecord(item);
  if (typeof summary.latest_entropy === "number" && Number.isFinite(summary.latest_entropy)) {
    return summary.latest_entropy;
  }
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const value = timeline[index].details?.disagreement_entropy;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function BenchmarkLiveCanvas({
  benchmarkId,
  benchmarkStatus,
  items,
  selectedItem,
  selectedItemTimeline,
  activeItemId,
  totalTokens,
  totalLatencyMs,
  dominantMechanism,
  layer,
  onLayerChange,
  onSelectItem,
  onOpenLogs,
}: BenchmarkLiveCanvasProps) {
  // Theme-aware grid — app sets data-theme="light" on <html>
  const [isDarkMode, setIsDarkMode] = useState(
    () => document.documentElement.getAttribute("data-theme") !== "light"
  );
  useEffect(() => {
    const check = () => setIsDarkMode(document.documentElement.getAttribute("data-theme") !== "light");
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  const graph = useMemo(() => buildBenchmarkOverviewGraph(items, {
    benchmarkId,
    benchmarkStatus,
    activeItemId,
    totalTokens,
    totalLatencyMs,
    dominantMechanism,
  }), [activeItemId, benchmarkId, benchmarkStatus, dominantMechanism, items, totalLatencyMs, totalTokens]);

  const positions = useMemo(() => {
    const next = new Map<string, { x: number; y: number }>();
    const maxColIndex = Math.max(...graph.nodes.map((node) => node.colIndex), 1);
    for (const node of graph.nodes) {
      next.set(node.id, nodePosition(node, Math.max(graph.laneOrder.length, 1), maxColIndex));
    }
    return next;
  }, [graph.laneOrder.length, graph.nodes]);

  const maxColIndex = useMemo(
    () => Math.max(...graph.nodes.map((node) => node.colIndex), 1),
    [graph.nodes],
  );
  const canvasWidth = PADDING_X + (maxColIndex + 1) * (NODE_WIDTH + NODE_GAP_X) + 180;
  const canvasHeight = PADDING_Y + Math.max(graph.laneOrder.length, 1) * LANE_HEIGHT + 120;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(0.82);
  const dragRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const hasFitRef = useRef(false);
  const [transform, setTransform] = useState({ x: 60, y: 40, scale: 0.82 });
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    hasFitRef.current = false;
  }, [benchmarkId, graph.nodes.length, layer]);

  const fitToContent = useCallback(() => {
    if (!containerRef.current) {
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const scaleW = (rect.width - 64) / canvasWidth;
    const scaleH = (rect.height - 64) / canvasHeight;
    const scale = Math.min(0.95, scaleW, scaleH);
    setTransform({
      x: Math.max(24, (rect.width - canvasWidth * scale) / 2),
      y: 28,
      scale,
    });
  }, [canvasHeight, canvasWidth]);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((current) => !current);
    window.setTimeout(() => {
      fitToContent();
    }, 80);
  }, [fitToContent]);

  useEffect(() => {
    if (layer !== "overview" || hasFitRef.current) {
      return;
    }
    const handle = window.setTimeout(() => {
      fitToContent();
      hasFitRef.current = true;
    }, 60);
    return () => window.clearTimeout(handle);
  }, [fitToContent, layer]);

  useEffect(() => {
    scaleRef.current = transform.scale;
  }, [transform.scale]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }
    dragRef.current = { lastX: event.clientX, lastY: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) {
      return;
    }
    const dx = event.clientX - dragRef.current.lastX;
    const dy = event.clientY - dragRef.current.lastY;
    dragRef.current = { lastX: event.clientX, lastY: event.clientY };
    setTransform((current) => ({
      ...current,
      x: current.x + dx,
      y: current.y + dy,
    }));
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  useEffect(() => {
    if (layer !== "overview") {
      return;
    }
    const node = containerRef.current;
    if (!node) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const factor = event.deltaY > 0 ? 0.95 : 1.05;
      setTransform((current) => {
        const nextScale = Math.min(2.1, Math.max(0.35, current.scale * factor));
        const ratio = nextScale / current.scale;
        return {
          x: cursorX - ratio * (cursorX - current.x),
          y: cursorY - ratio * (cursorY - current.y),
          scale: nextScale,
        };
      });
    };
    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", handleWheel);
    };
  }, [layer]);

  const itemTimeline = useMemo(
    () => buildDeliberationTimeline(
      selectedItemTimeline,
      selectedItem?.mechanism ?? dominantMechanism ?? "debate",
    ),
    [dominantMechanism, selectedItem?.mechanism, selectedItemTimeline],
  );
  const itemFinalAnswer = useMemo(
    () => deriveItemFinalAnswer(
      selectedItem,
      selectedItemTimeline,
      selectedItem?.mechanism ?? dominantMechanism ?? "debate",
    ),
    [dominantMechanism, selectedItem, selectedItemTimeline],
  );
  const itemRoundCount = useMemo(
    () => deriveItemRoundCount(selectedItem, itemTimeline),
    [itemTimeline, selectedItem],
  );
  const itemEntropy = useMemo(
    () => deriveItemEntropy(selectedItem, itemTimeline),
    [itemTimeline, selectedItem],
  );

  if (layer === "item" && selectedItem) {
    const ss = statusStyle(selectedItem.status);
    return (
      <div className="relative flex h-full min-h-[680px] flex-col">
        {/* ── Item header ──────────────────────────────────── */}
        <div style={{ borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-elevated)", padding: "10px 16px 12px", display: "flex", flexDirection: "column", gap: "10px", flexShrink: 0 }}>
          {/* Row 1: back + controls */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-2"
              onClick={() => onLayerChange("overview")}
            >
              <ArrowLeft size={13} />
              Back to benchmark map
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{
                borderRadius: "100px",
                border: `1px solid ${ss.border}`,
                background: ss.bg,
                color: ss.color,
                fontFamily: "'Commit Mono', monospace",
                fontSize: "10px",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "3px 10px",
              }}>
                {selectedItem.status}
              </span>
              <button
                type="button"
                className="btn-secondary inline-flex items-center gap-2"
                onClick={onOpenLogs}
              >
                <ScrollText size={13} />
                Open logs
              </button>
            </div>
          </div>
          {/* Row 2: breadcrumb + question */}
          <div style={{ display: "flex", alignItems: "baseline", gap: "10px", minWidth: 0 }}>
            <div style={{
              flexShrink: 0,
              fontFamily: "'Commit Mono', monospace",
              fontSize: "9px",
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              whiteSpace: "nowrap",
              padding: "2px 8px",
              borderRadius: "6px",
              border: "1px solid var(--border-subtle)",
              background: "var(--bg-base)",
            }}>
              Item {selectedItem.item_index + 1} · {titleCase(selectedItem.phase ?? "benchmark")} · {titleCase(selectedItem.run_kind ?? "run")}
            </div>
            <p style={{
              flex: 1,
              minWidth: 0,
              fontSize: "13px",
              color: "var(--text-primary)",
              lineHeight: 1.5,
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              margin: 0,
            }}>
              {selectedItem.question}
            </p>
          </div>
        </div>
        <CanvasView
          timeline={itemTimeline}
          finalAnswer={itemFinalAnswer}
          taskId={selectedItem.item_id}
          taskText={selectedItem.question}
          mechanism={selectedItem.mechanism ?? itemFinalAnswer?.mechanism ?? dominantMechanism ?? "debate"}
          roundCount={itemRoundCount}
          eventCount={selectedItemTimeline.length}
          entropy={itemEntropy}
        />
      </div>
    );
  }


  const completedCount = items.filter((item) => item.status === "completed").length;
  const activeCount = items.filter((item) => item.status === "running" || item.status === "queued").length;
  const laneCount = Math.max(graph.laneOrder.length, 1);

  return (
    <div
      className="flex flex-col"
      style={isFullscreen
        ? { position: "fixed", inset: 0, zIndex: 9999, background: "var(--bg-base)" }
        : { minHeight: "680px" }}
    >
      {/* ── Toolbar ─────────────────────────────────────── */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px", borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-elevated)", padding: "10px 16px" }}>
        {(() => { const s = viewStatusStyle(benchmarkStatus); return (
          <span style={{ borderRadius: "20px", border: `1px solid ${s.border}`, background: s.bg, color: s.color, fontFamily: "'Commit Mono',monospace", fontSize: "10px", letterSpacing: "0.1em", textTransform: "uppercase", padding: "4px 12px" }}>
            {benchmarkStatus ?? "queued"}
          </span>
        ); })()}
        {[
          ["Lanes", laneCount],
          ["Items", items.length],
          ["Active", activeCount],
          ["Done", completedCount],
        ].map(([label, val]) => (
          <span key={String(label)} style={{ fontFamily: "'Commit Mono',monospace", fontSize: "10px", color: "var(--text-secondary)" }}>
            <span style={{ color: "var(--text-muted)", marginRight: 4 }}>{label}</span>{val}
          </span>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontFamily: "'Commit Mono',monospace", fontSize: "10px", color: "var(--text-muted)" }}>Drag · Scroll to zoom</span>
          <button type="button" onClick={fitToContent} title="Fit to content" style={iconBtn}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <circle cx="7" cy="7" r="2.5" /><line x1="7" y1="0.5" x2="7" y2="3.5" /><line x1="7" y1="10.5" x2="7" y2="13.5" /><line x1="0.5" y1="7" x2="3.5" y2="7" /><line x1="10.5" y1="7" x2="13.5" y2="7" />
            </svg>
          </button>
          <button type="button" onClick={toggleFullscreen} title={isFullscreen ? "Exit fullscreen" : "Fullscreen"} style={iconBtn}>
            {isFullscreen
              ? <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8" /></svg>
              : <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M4 1H1v3M8 1h3v3M1 8v3h3M8 11h3V8" /></svg>}
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        className="relative flex-1 overflow-hidden"
        style={{
          background: "var(--bg-base)",
          backgroundImage: isDarkMode ? GRID_BG_DARK : GRID_BG_LIGHT,
          backgroundSize: "28px 28px",
          touchAction: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            transformOrigin: "0 0",
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            width: canvasWidth,
            height: canvasHeight,
          }}
        >
          <svg width={canvasWidth} height={canvasHeight} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            <defs>
              {LANE_PALETTES.map((_, i) => (
                <filter key={i} id={`glow-${i}`} x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              ))}
            </defs>
            {graph.edges.map((edge) => {
              const from = positions.get(edge.fromNodeId);
              const to = positions.get(edge.toNodeId);
              if (!from || !to) return null;
              const laneIdx = graph.laneOrder.indexOf(
                graph.nodes.find((n) => n.id === edge.fromNodeId)?.laneKey ?? ""
              );
              const pal = LANE_PALETTES[Math.max(0, laneIdx) % LANE_PALETTES.length];
              return (
                <path
                  key={edge.id}
                  d={edgePath(from, to)}
                  fill="none"
                  stroke={pal.edge}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  filter={`url(#glow-${Math.max(0, laneIdx) % LANE_PALETTES.length})`}
                />
              );
            })}
          </svg>

          {graph.laneOrder.map((laneKey, index) => {
            const pal = lanePalette(index);
            const laneLabel = graph.nodes.find((n) => n.laneKey === laneKey)?.laneLabel ?? laneKey;
            return (
              <div key={laneKey}>
                {/* Lane band */}
                <div style={{
                  position: "absolute", left: 8,
                  top: PADDING_Y + index * LANE_HEIGHT - 14,
                  width: canvasWidth - 240,
                  height: NODE_HEIGHT + 36,
                  borderRadius: "14px",
                  border: `1px solid ${pal.border}`,
                  background: `linear-gradient(90deg, ${pal.glow}, transparent 60%)`,
                }} />
                {/* Lane label */}
                <div style={{ position: "absolute", left: 20, top: PADDING_Y + index * LANE_HEIGHT + 14, width: 160 }}>
                  <div style={{
                    borderRadius: "8px",
                    border: `1px solid ${pal.border}`,
                    background: "var(--bg-elevated)",
                    padding: "7px 11px",
                    backdropFilter: "blur(8px)",
                  }}>
                    <div style={{ fontFamily: "'Commit Mono',monospace", fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase", color: pal.label }}>{laneLabel}</div>
                  </div>
                </div>
              </div>
            );
          })}

          {graph.nodes.map((node) => {
            const position = positions.get(node.id);
            if (!position) return null;
            const isItem = node.kind === "item";
            const ss = statusStyle(node.status);
            const mechPill = mechanismPill(node);
            const tokPill = tokenPill(node);
            const latPill = latencyPill(node);
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => { if (!isItem) return; onSelectItem(node.id); onLayerChange("item"); }}
                style={{
                  position: "absolute",
                  left: position.x,
                  top: position.y,
                  width: node.kind === "final" ? NODE_WIDTH + 20 : NODE_WIDTH,
                  minHeight: node.kind === "final" ? NODE_HEIGHT + 20 : NODE_HEIGHT,
                  background: node.isActive
                    ? "rgba(34,211,238,0.07)"
                    : "var(--bg-elevated)",
                  border: node.isActive
                    ? "1px solid rgba(34,211,238,0.6)"
                    : `1px solid var(--border-default)`,
                  borderRadius: "10px",
                  boxShadow: node.isActive
                    ? "0 0 0 1px rgba(34,211,238,0.18), 0 8px 32px rgba(0,0,0,0.18)"
                    : "0 4px 20px rgba(0,0,0,0.12)",
                  cursor: isItem ? "pointer" : "default",
                  textAlign: "left",
                  padding: 0,
                  overflow: "hidden",
                  transition: "border-color 0.18s ease, box-shadow 0.18s ease",
                  display: "flex",
                  flexDirection: "column",
                }}
                onMouseEnter={(e) => {
                  if (!isItem || node.isActive) return;
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(34,211,238,0.35)";
                  (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 8px 32px rgba(0,0,0,0.14)";
                }}
                onMouseLeave={(e) => {
                  if (!isItem || node.isActive) return;
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-default)";
                  (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 4px 20px rgba(0,0,0,0.12)";
                }}
              >
                {/* Mechanism accent bar */}
                <div style={{ height: "3px", background: ss.border, opacity: 0.85 }} />
                <div style={{ padding: "10px 12px", flex: 1, display: "flex", flexDirection: "column" }}>
                  {/* Header row */}
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flex: 1 }}>
                      {node.itemNumber ? (
                        <>
                          <span style={{ flexShrink: 0, borderRadius: "20px", border: "1px solid var(--border-default)", background: "var(--bg-base)", padding: "2px 8px", fontFamily: "'Commit Mono',monospace", fontSize: "9px", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)" }}>{node.itemNumber}</span>
                          <span style={{ fontFamily: "'Commit Mono',monospace", fontSize: "9px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.subtitle}</span>
                        </>
                      ) : (
                        <span style={{ fontFamily: "'Commit Mono',monospace", fontSize: "9px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{node.title}</span>
                      )}
                    </div>
                    <span style={{ flexShrink: 0, borderRadius: "20px", border: `1px solid ${ss.border}`, background: ss.bg, color: ss.color, fontFamily: "'Commit Mono',monospace", fontSize: "8.5px", letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 8px" }}>{node.status}</span>
                  </div>
                  {/* Question text */}
                  <p style={{ flex: 1, fontSize: "12px", lineHeight: 1.55, color: "var(--text-primary)", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", marginBottom: 8 }}>
                    {node.kind === "final" ? finalSummaryLine(node) : node.question}
                  </p>
                  {/* Footer pills */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }}>
                    {node.kind === "item" ? (
                      <>
                        {mechPill && <span style={{ borderRadius: "20px", border: "1px solid var(--border-default)", background: "var(--bg-base)", padding: "2px 8px", fontFamily: "'Commit Mono',monospace", fontSize: "8.5px", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-secondary)" }}>{mechPill}</span>}
                        {tokPill && <span style={{ borderRadius: "20px", border: "1px solid var(--border-default)", background: "var(--bg-base)", padding: "2px 8px", fontFamily: "'Commit Mono',monospace", fontSize: "8.5px", letterSpacing: "0.06em", color: "var(--text-secondary)" }}>{tokPill}</span>}
                        {latPill && <span style={{ borderRadius: "20px", border: "1px solid var(--border-default)", background: "var(--bg-base)", padding: "2px 8px", fontFamily: "'Commit Mono',monospace", fontSize: "8.5px", letterSpacing: "0.06em", color: "var(--text-muted)" }}>{latPill}</span>}
                      </>
                    ) : (
                      <>
                        {dominantMechanism && <span style={{ borderRadius: "20px", border: "1px solid var(--border-default)", background: "var(--bg-base)", padding: "2px 8px", fontFamily: "'Commit Mono',monospace", fontSize: "8.5px", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-secondary)" }}>{titleCase(dominantMechanism)}</span>}
                        <span style={{ borderRadius: "20px", border: "1px solid var(--border-default)", background: "var(--bg-base)", padding: "2px 8px", fontFamily: "'Commit Mono',monospace", fontSize: "8.5px", letterSpacing: "0.06em", color: "var(--text-secondary)" }}>{completedCount}/{items.length} done</span>
                      </>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const iconBtn: CSSProperties = {
  background: "var(--bg-base)",
  border: "1px solid var(--border-default)",
  borderRadius: "7px",
  padding: "5px 7px",
  cursor: "pointer",
  color: "var(--text-muted)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
