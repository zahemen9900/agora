import { useEffect, useRef } from "react";

interface MerkleTreeProps {
  rootHash: string | null;
  leaves: string[];
}

const STYLE_ID = "merkle-tree-keyframes";

function injectKeyframes() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
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
  document.head.appendChild(style);
}

function truncate(hash: string, n = 8): string {
  if (!hash) return "—";
  return `${hash.slice(0, n)}…`;
}

export function MerkleTree({ rootHash, leaves }: MerkleTreeProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    injectKeyframes();
  }, []);

  const FONT = "'Commit Mono', 'SF Mono', monospace";

  // Layout constants
  const NODE_W = 120;
  const NODE_H = 44;
  const LEAF_GAP = 20;   // horizontal gap between leaf pairs
  const PAIR_GAP = 40;   // gap between the two leaf pairs
  const LEVEL_H = 90;    // vertical distance between levels

  // Clamp leaves to even count for balanced tree display
  const displayLeaves = leaves.length > 0 ? leaves : ["", "", "", ""];
  const leafCount = Math.min(displayLeaves.length, 8);
  // Pad to even
  const paddedLeaves = [...displayLeaves.slice(0, leafCount)];
  while (paddedLeaves.length % 2 !== 0) paddedLeaves.push("");

  // We'll render a 2-level tree: leaves → intermediate → root
  // For simplicity, always render pairs grouped into a balanced binary tree
  const pairCount = Math.ceil(paddedLeaves.length / 2);
  const totalWidth = pairCount * (NODE_W * 2 + LEAF_GAP) + (pairCount - 1) * PAIR_GAP;
  const svgWidth = Math.max(totalWidth + 60, 360);
  const offsetX = (svgWidth - totalWidth) / 2;

  const levels = paddedLeaves.length > 0 ? (pairCount > 1 ? 3 : 2) : 1;
  const svgHeight = levels * LEVEL_H + NODE_H + 40;

  // Compute leaf positions
  interface NodePos { x: number; y: number; label: string; hash: string; }
  const leafPositions: NodePos[] = [];
  for (let p = 0; p < pairCount; p++) {
    const pairLeft = offsetX + p * (NODE_W * 2 + LEAF_GAP + PAIR_GAP);
    for (let i = 0; i < 2; i++) {
      const idx = p * 2 + i;
      leafPositions.push({
        x: pairLeft + i * (NODE_W + LEAF_GAP),
        y: svgHeight - NODE_H - 20,
        label: `H${idx + 1}`,
        hash: paddedLeaves[idx] ?? "",
      });
    }
  }

  // Intermediate nodes (one per pair)
  const intermediatePositions: NodePos[] = [];
  for (let p = 0; p < pairCount; p++) {
    const left = leafPositions[p * 2];
    const right = leafPositions[p * 2 + 1];
    intermediatePositions.push({
      x: (left.x + right.x) / 2,
      y: svgHeight - NODE_H - 20 - LEVEL_H,
      label: `H(${p * 2 + 1},${p * 2 + 2})`,
      hash: "",
    });
  }

  // Root position
  const rootX = pairCount === 1
    ? intermediatePositions[0].x
    : (intermediatePositions[0].x + intermediatePositions[intermediatePositions.length - 1].x) / 2;
  const rootY = (pairCount > 1)
    ? intermediatePositions[0].y - LEVEL_H
    : intermediatePositions[0].y - LEVEL_H;

  // Delays (staggered)
  const baseDelay = 0.1;
  const leafDelay = (i: number) => baseDelay + i * 0.07;
  const intDelay = (i: number) => baseDelay + paddedLeaves.length * 0.07 + 0.15 + i * 0.1;
  const rootDelay = baseDelay + paddedLeaves.length * 0.07 + 0.15 + pairCount * 0.1 + 0.2;

  const empty = leaves.length === 0;

  return (
    <div ref={ref} style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-default)',
      borderRadius: '16px',
      overflow: 'hidden',
      marginBottom: '0',
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
          fontFamily: FONT,
          fontSize: '10px',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
          fontWeight: 600,
        }}>Transcript Verification Tree</span>
        {rootHash && (
          <span style={{
            marginLeft: 'auto',
            padding: '2px 10px',
            borderRadius: '100px',
            border: '1px solid var(--accent-emerald)',
            background: 'var(--accent-emerald-soft)',
            fontFamily: FONT,
            fontSize: '9px',
            color: 'var(--accent-emerald)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}>Verified</span>
        )}
      </div>

      {/* SVG tree */}
      <div style={{ overflowX: 'auto', padding: '24px 16px 20px' }}>
        {empty ? (
          <div style={{
            fontFamily: FONT,
            fontSize: '12px',
            color: 'var(--text-tertiary)',
            textAlign: 'center',
            padding: '32px 0',
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

            {/* Lines: leaves → intermediate */}
            {intermediatePositions.map((intNode, p) => {
              const delay = intDelay(p) - 0.08;
              return [0, 1].map((side) => {
                const leaf = leafPositions[p * 2 + side];
                const x1 = leaf.x + NODE_W / 2;
                const y1 = leaf.y;
                const x2 = intNode.x + NODE_W / 2;
                const y2 = intNode.y + NODE_H;
                const len = Math.hypot(x2 - x1, y2 - y1);
                return (
                  <line
                    key={`leaf-line-${p}-${side}`}
                    x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke="var(--accent-emerald)"
                    strokeWidth="0.8"
                    strokeDasharray={len}
                    strokeDashoffset={len}
                    style={{
                      animation: `mt-line-draw 0.4s ease-out ${delay}s both`,
                    }}
                  />
                );
              });
            })}

            {/* Lines: intermediate → root (when >1 pair) */}
            {pairCount > 1 && intermediatePositions.map((intNode, p) => {
              const delay = rootDelay - 0.12;
              const x1 = intNode.x + NODE_W / 2;
              const y1 = intNode.y;
              const x2 = rootX + NODE_W / 2;
              const y2 = rootY + NODE_H;
              const len = Math.hypot(x2 - x1, y2 - y1);
              return (
                <line
                  key={`int-line-${p}`}
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke="var(--accent-emerald)"
                  strokeWidth="0.8"
                  strokeDasharray={len}
                  strokeDashoffset={len}
                  style={{
                    animation: `mt-line-draw 0.4s ease-out ${delay}s both`,
                  }}
                />
              );
            })}

            {/* Leaf nodes */}
            {leafPositions.map((leaf, i) => (
              <g
                key={`leaf-${i}`}
                style={{
                  animation: `mt-fade-in 0.35s cubic-bezier(0.22,1,0.36,1) ${leafDelay(i)}s both`,
                }}
              >
                <rect
                  x={leaf.x} y={leaf.y}
                  width={NODE_W} height={NODE_H}
                  rx={6}
                  fill="var(--bg-base)"
                  stroke="var(--border-strong)"
                  strokeWidth="1"
                />
                <text
                  x={leaf.x + NODE_W / 2}
                  y={leaf.y + 14}
                  textAnchor="middle"
                  fill="var(--accent-emerald)"
                  fontSize="8"
                  fontFamily={FONT}
                  letterSpacing="0.08em"
                >
                  {leaf.label}
                </text>
                <text
                  x={leaf.x + NODE_W / 2}
                  y={leaf.y + 30}
                  textAnchor="middle"
                  fill="var(--text-tertiary)"
                  fontSize="8"
                  fontFamily={FONT}
                >
                  {leaf.hash ? truncate(leaf.hash, 10) : "pending"}
                </text>
              </g>
            ))}

            {/* Intermediate nodes */}
            {intermediatePositions.map((node, p) => (
              <g
                key={`int-${p}`}
                style={{
                  animation: `mt-fade-in 0.35s cubic-bezier(0.22,1,0.36,1) ${intDelay(p)}s both`,
                }}
              >
                <rect
                  x={node.x} y={node.y}
                  width={NODE_W} height={NODE_H}
                  rx={6}
                  fill="var(--bg-elevated)"
                  stroke="var(--border-strong)"
                  strokeWidth="1"
                />
                <text
                  x={node.x + NODE_W / 2}
                  y={node.y + 14}
                  textAnchor="middle"
                  fill="var(--text-secondary)"
                  fontSize="7.5"
                  fontFamily={FONT}
                  letterSpacing="0.06em"
                >
                  {node.label}
                </text>
                <text
                  x={node.x + NODE_W / 2}
                  y={node.y + 30}
                  textAnchor="middle"
                  fill="var(--text-tertiary)"
                  fontSize="7.5"
                  fontFamily={FONT}
                >
                  hash({p * 2 + 1},{p * 2 + 2})
                </text>
              </g>
            ))}

            {/* Root node */}
            <g style={{
              animation: `mt-root-pop 0.45s cubic-bezier(0.22,1,0.36,1) ${rootDelay}s both`,
              transformOrigin: `${rootX + NODE_W / 2}px ${rootY + NODE_H / 2}px`,
            }}>
              <rect
                x={rootX} y={rootY}
                width={NODE_W} height={NODE_H}
                rx={8}
                fill="var(--accent-emerald)"
                filter="url(#mt-glow)"
                style={{
                  animation: `mt-glow-pulse 2.4s ease-in-out ${rootDelay + 0.45}s infinite`,
                }}
              />
              <text
                x={rootX + NODE_W / 2}
                y={rootY + 13}
                textAnchor="middle"
                fill="#000"
                fontSize="8"
                fontFamily={FONT}
                fontWeight="700"
                letterSpacing="0.1em"
              >
                MERKLE ROOT
              </text>
              <text
                x={rootX + NODE_W / 2}
                y={rootY + 30}
                textAnchor="middle"
                fill="rgba(0,0,0,0.65)"
                fontSize="7.5"
                fontFamily={FONT}
              >
                {rootHash ? truncate(rootHash, 12) : "pending"}
              </text>
            </g>
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
            <div key={i} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontFamily: FONT,
              fontSize: '10px',
            }}>
              <span style={{ color: 'var(--accent-emerald)', fontWeight: 700 }}>H{i + 1}</span>
              <span style={{
                color: 'var(--text-tertiary)',
                maxWidth: '160px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>{leaf}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
