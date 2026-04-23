import { useEffect, useRef } from "react";

interface MerkleTreeProps {
  rootHash: string | null;
  leaves: string[];
}

const STYLE_ID = "merkle-tree-keyframes";

function injectKeyframes() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes mt-fade-in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes mt-line-draw {
      from { stroke-dashoffset: 1; }
      to   { stroke-dashoffset: 0; }
    }
    @keyframes mt-glow-pulse {
      0%, 100% { filter: drop-shadow(0 0 6px rgba(34,211,138,0.6)); }
      50%       { filter: drop-shadow(0 0 14px rgba(34,211,138,0.9)); }
    }
    @keyframes mt-root-pop {
      0%   { transform: scale(0.85); opacity: 0; }
      70%  { transform: scale(1.04); opacity: 1; }
      100% { transform: scale(1);    opacity: 1; }
    }
  `;
  document.head.appendChild(s);
}

function truncate(hash: string, n = 8): string {
  if (!hash) return "—";
  return `${hash.slice(0, n)}…`;
}

// ─── Bucketing ────────────────────────────────────────────────────────────────
// Always produce exactly a power-of-2 number of visual leaf boxes (max 8).
// If more leaves than MAX_VISUAL exist they are bucketed; the full list is
// shown in the legend below.

const MAX_VISUAL = 8;

interface DisplayItem {
  label: string;
  hash: string;
  isBucket: boolean;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function buildDisplayItems(leaves: string[]): DisplayItem[] {
  if (leaves.length === 0) return [];
  const raw: DisplayItem[] = [];
  const bucketSize = leaves.length > MAX_VISUAL ? Math.ceil(leaves.length / MAX_VISUAL) : 1;
  for (let i = 0; i < leaves.length; i += bucketSize) {
    const chunk = leaves.slice(i, Math.min(i + bucketSize, leaves.length));
    const start = i + 1;
    const end = i + chunk.length;
    raw.push({
      label: chunk.length === 1 ? `H${start}` : `H${start}–${end}`,
      hash: chunk[0] ?? "",
      isBucket: chunk.length > 1,
    });
  }
  // Pad to next power of 2
  const target = nextPow2(raw.length);
  while (raw.length < target) raw.push({ label: "", hash: "", isBucket: false });
  return raw;
}

// ─── Tree layout ──────────────────────────────────────────────────────────────
// level 0 = leaves (bottom), level `depth` = root (top).
// Each node at (level, pos) spans 2^level leaves: from pos*2^level to (pos+1)*2^level - 1.
// Its center-x is the average of the centers of those leaves.

interface TreeEdge {
  x1: number; y1: number;  // child top-center
  x2: number; y2: number;  // parent bottom-center
  delay: number;
  len: number;
}

interface TreeNode {
  cx: number;   // center x
  ty: number;   // top y
  level: number;
  pos: number;
  label: string;
  hash: string;
  isBucket: boolean;
  isRoot: boolean;
  delay: number;
}

function buildTreeLayout(
  items: DisplayItem[],
  NODE_W: number,
  H_GAP: number,
  LEVEL_H: number,
  NODE_H: number,
  SVG_PAD: number,
): { nodes: TreeNode[]; edges: TreeEdge[]; svgWidth: number; svgHeight: number } {
  const n = items.length; // power of 2
  if (n === 0) return { nodes: [], edges: [], svgWidth: 360, svgHeight: 200 };

  const depth = Math.log2(n); // e.g. 3 for 8 leaves
  const totalLevels = depth + 1;

  const leafSpan = n * NODE_W + (n - 1) * H_GAP;
  const svgWidth = Math.max(leafSpan + SVG_PAD * 2, 360);
  const offsetX = (svgWidth - leafSpan) / 2;
  const svgHeight = totalLevels * LEVEL_H + NODE_H + 40;

  // Center-x of node at (level, pos): average of its first and last leaf's centers
  function cx(level: number, pos: number): number {
    const span = Math.pow(2, level);
    const firstLeaf = pos * span;
    const lastLeaf = firstLeaf + span - 1;
    const c0 = offsetX + firstLeaf * (NODE_W + H_GAP) + NODE_W / 2;
    const c1 = offsetX + lastLeaf  * (NODE_W + H_GAP) + NODE_W / 2;
    return (c0 + c1) / 2;
  }

  // Top-y of nodes at bottom-up level (level 0 = leaves at bottom)
  function ty(level: number): number {
    return svgHeight - NODE_H - 20 - level * LEVEL_H;
  }

  const nodes: TreeNode[] = [];
  const edges: TreeEdge[] = [];

  // Leaf level (level 0)
  items.forEach((item, pos) => {
    if (!item.label) return; // padding
    nodes.push({
      cx: cx(0, pos),
      ty: ty(0),
      level: 0,
      pos,
      label: item.label,
      hash: item.hash,
      isBucket: item.isBucket,
      isRoot: false,
      delay: 0.1 + pos * 0.06,
    });
  });

  // Intermediate levels (1 to depth-1) + root (depth)
  const baseLeafDelay = 0.1 + n * 0.06 + 0.1;
  for (let level = 1; level <= depth; level++) {
    const nodesAtLevel = n / Math.pow(2, level);
    for (let pos = 0; pos < nodesAtLevel; pos++) {
      const isRoot = level === depth;
      nodes.push({
        cx: cx(level, pos),
        ty: ty(level),
        level,
        pos,
        label: isRoot ? "MERKLE ROOT" : `H(${pos * 2 + 1},${pos * 2 + 2})`,
        hash: "",
        isBucket: false,
        isRoot,
        delay: baseLeafDelay + (level - 1) * 0.12 + pos * 0.06,
      });
    }
  }

  // Edges: every non-root node connects to its parent
  for (let level = 0; level < depth; level++) {
    const nodesAtLevel = n / Math.pow(2, level);
    for (let pos = 0; pos < nodesAtLevel; pos++) {
      // Skip padding slots (items[pos] with no label at level 0)
      if (level === 0 && !items[pos]?.label) continue;
      const parentLevel = level + 1;
      const parentPos = Math.floor(pos / 2);
      const childCx = cx(level, pos);
      const childTy = ty(level);
      const parentCx = cx(parentLevel, parentPos);
      const parentBottomY = ty(parentLevel) + NODE_H;
      const len = Math.hypot(parentCx - childCx, parentBottomY - childTy);
      edges.push({
        x1: childCx,
        y1: childTy,
        x2: parentCx,
        y2: parentBottomY,
        len,
        delay: baseLeafDelay + (level) * 0.12 - 0.06,
      });
    }
  }

  return { nodes, edges, svgWidth, svgHeight };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MerkleTree({ rootHash, leaves }: MerkleTreeProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { injectKeyframes(); }, []);

  const FONT = "'Commit Mono', 'SF Mono', monospace";
  const NODE_W = 110;
  const NODE_H = 44;
  const H_GAP = 16;
  const LEVEL_H = 84;
  const SVG_PAD = 30;

  const empty = leaves.length === 0;
  const items = buildDisplayItems(empty ? [] : leaves);
  const { nodes, edges, svgWidth, svgHeight } = buildTreeLayout(items, NODE_W, H_GAP, LEVEL_H, NODE_H, SVG_PAD);

  const isBucketed = items.some((x) => x.isBucket);
  const root = nodes.find((n) => n.isRoot);
  const rootDelay = root?.delay ?? 0;

  return (
    <div ref={ref} style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-default)',
      borderRadius: '16px',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '18px 24px 14px',
        borderBottom: '1px solid var(--border-default)',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        background: 'linear-gradient(135deg, rgba(34,211,138,0.05) 0%, transparent 60%)',
      }}>
        <span style={{
          fontFamily: FONT, fontSize: '10px', letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--text-tertiary)', fontWeight: 600,
        }}>Transcript Verification Tree</span>
        {isBucketed && (
          <span style={{ fontFamily: FONT, fontSize: '9px', color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
            {leaves.length} leaves · grouped for display
          </span>
        )}
        {rootHash && (
          <span style={{
            marginLeft: 'auto', padding: '2px 10px', borderRadius: '100px',
            border: '1px solid var(--accent-emerald)', background: 'var(--accent-emerald-soft)',
            fontFamily: FONT, fontSize: '9px', color: 'var(--accent-emerald)',
            letterSpacing: '0.08em', textTransform: 'uppercase',
          }}>Verified</span>
        )}
      </div>

      {/* SVG tree */}
      <div style={{ overflowX: 'auto', padding: '24px 16px 20px' }}>
        {empty ? (
          <div style={{
            fontFamily: FONT, fontSize: '12px', color: 'var(--text-tertiary)',
            textAlign: 'center', padding: '32px 0',
          }}>
            Transcript hashes will appear once the task completes.
          </div>
        ) : (
          <svg
            width={svgWidth}
            height={svgHeight}
            style={{ display: 'block', margin: '0 auto', overflow: 'visible' }}
          >
            <defs>
              <filter id="mt-glow">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>

            {/* Edges */}
            {edges.map((e, i) => (
              <line
                key={`edge-${i}`}
                x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                stroke="var(--accent-emerald)"
                strokeWidth="0.8"
                strokeDasharray={e.len}
                strokeDashoffset={e.len}
                style={{ animation: `mt-line-draw 0.4s ease-out ${e.delay}s both` }}
              />
            ))}

            {/* Non-root nodes */}
            {nodes.filter((n) => !n.isRoot).map((node) => (
              <g
                key={`node-${node.level}-${node.pos}`}
                style={{ animation: `mt-fade-in 0.35s cubic-bezier(0.22,1,0.36,1) ${node.delay}s both` }}
              >
                <rect
                  x={node.cx - NODE_W / 2} y={node.ty}
                  width={NODE_W} height={NODE_H}
                  rx={6}
                  fill={node.level === 0 ? "var(--bg-base)" : "var(--bg-elevated)"}
                  stroke={node.isBucket ? "rgba(34,211,138,0.4)" : "var(--border-strong)"}
                  strokeWidth="1"
                />
                <text
                  x={node.cx} y={node.ty + 15}
                  textAnchor="middle"
                  fill={node.level === 0 ? "var(--accent-emerald)" : "var(--text-secondary)"}
                  fontSize="8"
                  fontFamily={FONT}
                  letterSpacing="0.07em"
                >
                  {node.label}
                </text>
                {node.level === 0 && (
                  <text
                    x={node.cx} y={node.ty + 30}
                    textAnchor="middle"
                    fill="var(--text-tertiary)"
                    fontSize="8"
                    fontFamily={FONT}
                  >
                    {node.hash ? truncate(node.hash, 10) : "pending"}
                  </text>
                )}
              </g>
            ))}

            {/* Root node */}
            {root && (
              <g style={{
                animation: `mt-root-pop 0.45s cubic-bezier(0.22,1,0.36,1) ${rootDelay}s both`,
                transformOrigin: `${root.cx}px ${root.ty + NODE_H / 2}px`,
              }}>
                <rect
                  x={root.cx - NODE_W / 2} y={root.ty}
                  width={NODE_W} height={NODE_H}
                  rx={8}
                  fill="var(--accent-emerald)"
                  filter="url(#mt-glow)"
                  style={{ animation: `mt-glow-pulse 2.4s ease-in-out ${rootDelay + 0.45}s infinite` }}
                />
                <text
                  x={root.cx} y={root.ty + 14}
                  textAnchor="middle"
                  fill="#000" fontSize="8" fontFamily={FONT}
                  fontWeight="700" letterSpacing="0.1em"
                >MERKLE ROOT</text>
                <text
                  x={root.cx} y={root.ty + 30}
                  textAnchor="middle"
                  fill="rgba(0,0,0,0.65)" fontSize="7.5" fontFamily={FONT}
                >
                  {rootHash ? truncate(rootHash, 12) : "pending"}
                </text>
              </g>
            )}
          </svg>
        )}
      </div>

      {/* Leaf hash legend */}
      {!empty && (
        <div style={{
          borderTop: '1px solid var(--border-default)',
          padding: '12px 24px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px 20px',
        }}>
          {leaves.map((leaf, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: FONT, fontSize: '10px' }}>
              <span style={{ color: 'var(--accent-emerald)', fontWeight: 700 }}>H{i + 1}</span>
              <span style={{
                color: 'var(--text-tertiary)', maxWidth: '160px',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{leaf}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
