import { useRef } from "react";
import type { GraphEdge } from "./canvasTypes";
import { NODE_WIDTH, NODE_HEIGHT } from "./GraphNodeCard";

interface GraphEdgesProps {
  edges: GraphEdge[];
  positions: Map<string, { x: number; y: number }>;
  nodeHeights: Map<string, number>;
  totalWidth: number;
  totalHeight: number;
}

function vPath(x1: number, y1: number, x2: number, y2: number): string {
  const cpy = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${cpy} ${x2},${cpy} ${x2},${y2}`;
}

function pathLength(x1: number, y1: number, x2: number, y2: number): number {
  // Approximate cubic bezier length via straight-line distance × 1.2 factor
  return Math.hypot(x2 - x1, y2 - y1) * 1.2;
}

export function GraphEdges({ edges, positions, nodeHeights, totalWidth, totalHeight }: GraphEdgesProps) {
  // Track which edge IDs we've already seen so draw-in only fires on new edges
  const seenRef = useRef<Set<string>>(new Set());

  return (
    <svg
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", overflow: "visible", zIndex: 0 }}
      width={totalWidth}
      height={totalHeight}
    >
      <defs>
        <style>{`
          @keyframes edge-flow {
            from { stroke-dashoffset: 20; }
            to   { stroke-dashoffset: 0; }
          }
          @keyframes edge-draw-in {
            from { stroke-dashoffset: 1; }
            to   { stroke-dashoffset: 0; }
          }
          @keyframes edge-dot-in {
            from { opacity: 0; transform: scale(0); }
            to   { opacity: 1; transform: scale(1); }
          }
        `}</style>
      </defs>

      {edges.map((edge) => {
        const fp = positions.get(edge.fromNodeId);
        const tp = positions.get(edge.toNodeId);
        if (!fp || !tp) return null;

        const sx = fp.x + NODE_WIDTH / 2;
        const sy = fp.y + (nodeHeights.get(edge.fromNodeId) ?? NODE_HEIGHT);
        const tx = tp.x + NODE_WIDTH / 2;
        const ty = tp.y;

        const d = vPath(sx, sy, tx, ty);
        const live = edge.isLive;
        const isNew = !seenRef.current.has(edge.id);
        if (isNew) seenRef.current.add(edge.id);

        const len = pathLength(sx, sy, tx, ty);

        return (
          <g key={edge.id}>
            {live ? (
              // Live edge: animated flowing dashes
              <path
                d={d}
                fill="none"
                stroke="rgba(34,211,238,0.55)"
                strokeWidth={2}
                strokeDasharray="7 4"
                style={{ animation: "edge-flow 0.55s linear infinite" }}
              />
            ) : (
              // Static edge: draw-in animation on first appearance
              <path
                d={d}
                fill="none"
                stroke="var(--border-strong)"
                strokeWidth={1.5}
                strokeDasharray={isNew ? String(len) : undefined}
                strokeDashoffset={isNew ? String(len) : undefined}
                style={isNew ? {
                  animation: `edge-draw-in 0.55s cubic-bezier(0.22,1,0.36,1) both`,
                } : undefined}
              />
            )}
            {/* Arrival dot at target */}
            <circle
              cx={tx}
              cy={ty}
              r={live ? 3.5 : 3}
              fill={live ? "#22d3ee" : "var(--border-strong)"}
              style={isNew ? {
                transformOrigin: `${tx}px ${ty}px`,
                animation: "edge-dot-in 0.3s cubic-bezier(0.22,1,0.36,1) 0.45s both",
              } : undefined}
            />
          </g>
        );
      })}
    </svg>
  );
}
