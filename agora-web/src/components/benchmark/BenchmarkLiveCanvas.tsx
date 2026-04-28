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

const GRID_BG_DARK = `
  linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px),
  linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)
`.trim();

const LANE_HEIGHT = 196;
const NODE_WIDTH = 236;
const NODE_HEIGHT = 132;
const NODE_GAP_X = 34;
const PADDING_X = 196;
const PADDING_Y = 64;

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

function statusTone(status: BenchmarkOverviewNode["status"]): string {
  if (status === "completed") return "border-emerald-400/45 text-emerald-300 bg-emerald-400/10";
  if (status === "degraded") return "border-amber-400/45 text-amber-300 bg-amber-400/10";
  if (status === "failed") return "border-red-400/45 text-red-300 bg-red-400/10";
  if (status === "running") return "border-cyan-400/45 text-cyan-300 bg-cyan-400/10";
  if (status === "summary") return "border-violet-400/45 text-violet-300 bg-violet-400/10";
  return "border-border-subtle text-text-secondary bg-void";
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

function laneAccent(index: number): string {
  const colors = [
    "rgba(34, 211, 238, 0.32)",
    "rgba(52, 211, 153, 0.28)",
    "rgba(251, 191, 36, 0.24)",
    "rgba(168, 85, 247, 0.24)",
  ];
  return colors[index % colors.length];
}

function viewTone(status: BenchmarkDetailPayload["status"] | null | undefined): string {
  if (status === "completed") return "border-emerald-400/35 bg-emerald-400/10 text-emerald-300";
  if (status === "failed") return "border-red-400/35 bg-red-400/10 text-red-300";
  if (status === "running") return "border-cyan-400/35 bg-cyan-400/10 text-cyan-300";
  return "border-border-subtle bg-black/20 text-text-secondary";
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
    return (
      <div className="relative flex h-full min-h-[680px] flex-col">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle bg-[var(--bg-elevated)] px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-2"
              onClick={() => onLayerChange("overview")}
            >
              <ArrowLeft size={14} />
              Back to benchmark map
            </button>
            <div>
              <div className="mono text-[10px] text-text-muted">
                ITEM {selectedItem.item_index + 1} · {titleCase(selectedItem.phase ?? "benchmark")} · {titleCase(selectedItem.run_kind ?? "run")}
              </div>
              <div className="text-sm text-text-primary">{selectedItem.question}</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2 py-1 mono text-[10px] ${statusTone(selectedItem.status)}`}>
              {selectedItem.status}
            </span>
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-2"
              onClick={onOpenLogs}
            >
              <ScrollText size={14} />
              Open logs
            </button>
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
      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle bg-[var(--bg-elevated)] px-4 py-3">
        <span className={`rounded-full border px-3 py-1 mono text-[10px] uppercase tracking-[0.08em] ${viewTone(benchmarkStatus)}`}>
          {benchmarkStatus ?? "queued"}
        </span>
        <span className="mono text-[10px] text-text-secondary">Lanes {laneCount}</span>
        <span className="mono text-[10px] text-text-secondary">Items {items.length}</span>
        <span className="mono text-[10px] text-text-secondary">Active {activeCount}</span>
        <span className="mono text-[10px] text-text-secondary">Done {completedCount}</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="mono text-[10px] text-text-muted">Drag · Scroll to zoom</span>
          <button type="button" onClick={fitToContent} title="Fit to content" style={iconBtn}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <circle cx="7" cy="7" r="2.5" />
              <line x1="7" y1="0.5" x2="7" y2="3.5" />
              <line x1="7" y1="10.5" x2="7" y2="13.5" />
              <line x1="0.5" y1="7" x2="3.5" y2="7" />
              <line x1="10.5" y1="7" x2="13.5" y2="7" />
            </svg>
          </button>
          <button type="button" onClick={toggleFullscreen} title={isFullscreen ? "Exit fullscreen" : "Fullscreen"} style={iconBtn}>
            {isFullscreen
              ? <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8" /></svg>
              : <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M4 1H1v3M8 1h3v3M1 8v3h3M8 11h3V8" /></svg>}
          </button>
        </div>
      </div>
      <div className="border-b border-border-subtle bg-[rgba(10,14,18,0.95)] px-4 py-4">
        <div className="mono text-[10px] tracking-[0.08em] text-text-muted">BENCHMARK MAP</div>
        <div className="mt-1 max-w-4xl text-sm leading-6 text-text-primary">
          {items.length > 0
            ? "Each lane tracks one benchmark phase and run kind. Click any item to drop into its live deliberation."
            : "The run is queued. Benchmark items will appear here as soon as execution state is materialized."}
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
          background: "#0b1117",
          backgroundImage: GRID_BG_DARK,
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
            {graph.edges.map((edge) => {
              const from = positions.get(edge.fromNodeId);
              const to = positions.get(edge.toNodeId);
              if (!from || !to) {
                return null;
              }
              return (
                <path
                  key={edge.id}
                  d={edgePath(from, to)}
                  fill="none"
                  stroke="rgba(34, 211, 238, 0.72)"
                  strokeWidth={2}
                  strokeDasharray="7 5"
                  strokeLinecap="round"
                />
              );
            })}
          </svg>

          {graph.laneOrder.map((laneKey, index) => (
            <div key={laneKey}>
              <div
                style={{
                  position: "absolute",
                  left: 8,
                  top: PADDING_Y + index * LANE_HEIGHT - 12,
                  width: canvasWidth - 260,
                  height: NODE_HEIGHT + 30,
                  borderRadius: "16px",
                  border: `1px solid ${laneAccent(index)}`,
                  background: "linear-gradient(90deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 24,
                  top: PADDING_Y + index * LANE_HEIGHT + 18,
                  width: 150,
                }}
              >
                <div
                  style={{
                    borderRadius: "10px",
                    border: `1px solid ${laneAccent(index)}`,
                    background: "rgba(7, 11, 16, 0.72)",
                    padding: "10px 12px",
                  }}
                >
                  <div className="mono text-[9px] uppercase tracking-[0.08em] text-text-muted">
                    {graph.nodes.find((node) => node.laneKey === laneKey)?.laneLabel ?? laneKey}
                  </div>
                </div>
              </div>
            </div>
          ))}

          {graph.nodes.map((node) => {
            const position = positions.get(node.id);
            if (!position) {
              return null;
            }
            const isItem = node.kind === "item";
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => {
                  if (!isItem) {
                    return;
                  }
                  onSelectItem(node.id);
                  onLayerChange("item");
                }}
                style={{
                  position: "absolute",
                  left: position.x,
                  top: position.y,
                  width: node.kind === "final" ? NODE_WIDTH + 18 : NODE_WIDTH,
                  minHeight: node.kind === "final" ? NODE_HEIGHT + 16 : NODE_HEIGHT,
                }}
                className={`rounded-md border p-3 text-left transition ${
                  node.isActive
                    ? "border-cyan-300/80 bg-cyan-400/12 shadow-[0_0_0_1px_rgba(34,211,238,0.2),0_16px_40px_rgba(0,0,0,0.32)]"
                    : "border-border-subtle/90 bg-[rgba(13,19,26,0.94)] shadow-[0_16px_40px_rgba(0,0,0,0.28)] hover:border-cyan-400/55 hover:bg-[rgba(15,22,30,0.98)]"
                } ${isItem ? "cursor-pointer" : "cursor-default"}`}
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {node.itemNumber ? (
                      <>
                        <span className="shrink-0 rounded-full border border-border-subtle/90 bg-black/20 px-2.5 py-1 mono text-[9px] uppercase tracking-[0.08em] text-text-primary">
                          {node.itemNumber}
                        </span>
                        <div className="min-w-0">
                          <div className="text-xs text-text-primary">{node.subtitle}</div>
                        </div>
                      </>
                    ) : (
                      <div className="min-w-0">
                        <div className="mono text-[9px] uppercase tracking-[0.06em] text-text-muted">{node.title}</div>
                        <div className="text-xs text-text-primary">{node.subtitle}</div>
                      </div>
                    )}
                  </div>
                  <span className={`shrink-0 rounded-full border px-2 py-1 mono text-[9px] uppercase tracking-[0.05em] ${statusTone(node.status)}`}>
                    {node.status}
                  </span>
                </div>
                <p className="mb-3 line-clamp-3 text-[13px] leading-6 text-text-primary">
                  {node.kind === "final"
                    ? finalSummaryLine(node)
                    : node.question}
                </p>
                <div className="flex flex-wrap gap-2 border-t border-border-subtle/70 pt-2">
                  {node.kind === "item" ? (
                    <>
                      {mechanismPill(node) ? (
                        <span className="rounded-full border border-border-subtle/80 bg-black/18 px-2.5 py-1 mono text-[9px] uppercase tracking-[0.06em] text-text-secondary">
                          {mechanismPill(node)}
                        </span>
                      ) : null}
                      {tokenPill(node) ? (
                        <span className="rounded-full border border-border-subtle/80 bg-black/18 px-2.5 py-1 mono text-[9px] uppercase tracking-[0.06em] text-text-secondary">
                          {tokenPill(node)}
                        </span>
                      ) : null}
                      {latencyPill(node) ? (
                        <span className="rounded-full border border-border-subtle/80 bg-black/18 px-2.5 py-1 mono text-[9px] uppercase tracking-[0.06em] text-text-secondary">
                          {latencyPill(node)}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <>
                      {dominantMechanism ? (
                        <span className="rounded-full border border-border-subtle/80 bg-black/18 px-2.5 py-1 mono text-[9px] uppercase tracking-[0.06em] text-text-secondary">
                          {titleCase(dominantMechanism)}
                        </span>
                      ) : null}
                      <span className="rounded-full border border-border-subtle/80 bg-black/18 px-2.5 py-1 mono text-[9px] uppercase tracking-[0.06em] text-text-secondary">
                        {completedCount}/{items.length} done
                      </span>
                    </>
                  )}
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
