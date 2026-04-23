import { useState, useCallback } from 'react';
import { SAMPLE_TRANSCRIPT } from '../../lib/sample-transcript';
import { SAMPLE_ROOT } from '../../lib/sample-root';
import { verifyReceipt, type VerifyStep } from '../../lib/merkle';

/* ── Merkle tree SVG visualization ─────────────────────────────── */
interface MerkleNodeState {
  leafLit: boolean[];      // 4 leaves
  parentLit: boolean[];    // 2 parents
  rootLit: boolean;
  rootMatch: boolean | null;
}

const LEAF_LABELS = ['arg1', 'arg2', 'arg3', 'arg4'];

function MerkleTreeViz({
  state,
  onLeafHover,
  hoveredLeaf,
}: {
  state: MerkleNodeState;
  onLeafHover: (idx: number | null) => void;
  hoveredLeaf: number | null;
}) {
  const leafX = [60, 140, 220, 300];
  const leafY = 200;
  const parentX = [100, 260];
  const parentY = 120;
  const rootX = 180;
  const rootY = 44;

  const emerald = 'var(--accent-emerald)';
  const dim = 'var(--border-default)';
  const rootColor = state.rootMatch === false ? 'var(--accent-rose)'
    : state.rootLit ? emerald
    : dim;

  return (
    <svg viewBox="0 0 380 240" aria-label="Merkle tree visualization" style={{ width: '100%', maxWidth: '380px' }}>
      {/* Connector lines: leaves → parents */}
      {[
        { x1: leafX[0] + 14, y1: leafY, x2: parentX[0] + 14, y2: parentY + 24 },
        { x1: leafX[1] + 14, y1: leafY, x2: parentX[0] + 14, y2: parentY + 24 },
        { x1: leafX[2] + 14, y1: leafY, x2: parentX[1] + 14, y2: parentY + 24 },
        { x1: leafX[3] + 14, y1: leafY, x2: parentX[1] + 14, y2: parentY + 24 },
      ].map((ln, i) => (
        <line key={i} x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2}
          stroke={state.parentLit[Math.floor(i / 2)] ? emerald : dim}
          strokeWidth="1" opacity="0.6"
          style={{ transition: 'stroke 0.3s' }}/>
      ))}

      {/* Connector lines: parents → root */}
      {parentX.map((px, i) => (
        <line key={i} x1={px + 14} y1={parentY} x2={rootX + 14} y2={rootY + 24}
          stroke={state.rootLit ? rootColor : dim}
          strokeWidth="1" opacity="0.6"
          style={{ transition: 'stroke 0.3s' }}/>
      ))}

      {/* Leaf nodes */}
      {leafX.map((x, i) => (
        <g key={i}
          onMouseEnter={() => onLeafHover(i)}
          onMouseLeave={() => onLeafHover(null)}
          style={{ cursor: 'pointer' }}>
          <rect x={x} y={leafY} width="28" height="22" rx="4"
            fill={state.leafLit[i] ? 'var(--accent-emerald-soft)' : 'var(--bg-subtle)'}
            stroke={state.leafLit[i] ? emerald : dim}
            strokeWidth={state.leafLit[i] ? 1.5 : 1}
            style={{ transition: 'fill 0.3s, stroke 0.3s', filter: state.leafLit[i] ? `drop-shadow(0 0 6px rgba(34,211,138,0.4))` : 'none' }}/>
          <text x={x + 14} y={leafY + 14} textAnchor="middle"
            fill={state.leafLit[i] ? emerald : 'var(--text-tertiary)'}
            fontSize="7" fontFamily="'Commit Mono',monospace" fontWeight="600">
            {LEAF_LABELS[i]}
          </text>
          {hoveredLeaf === i && (
            <text x={x + 14} y={leafY + 34} textAnchor="middle"
              fill="var(--text-tertiary)" fontSize="6" fontFamily="'Commit Mono',monospace">
              hover for source
            </text>
          )}
        </g>
      ))}

      {/* Parent nodes */}
      {parentX.map((px, i) => (
        <g key={i}>
          <rect x={px} y={parentY} width="28" height="22" rx="4"
            fill={state.parentLit[i] ? 'var(--accent-emerald-soft)' : 'var(--bg-subtle)'}
            stroke={state.parentLit[i] ? emerald : dim}
            strokeWidth={state.parentLit[i] ? 1.5 : 1}
            style={{ transition: 'fill 0.3s, stroke 0.3s', filter: state.parentLit[i] ? `drop-shadow(0 0 6px rgba(34,211,138,0.4))` : 'none' }}/>
          <text x={px + 14} y={parentY + 14} textAnchor="middle"
            fill={state.parentLit[i] ? emerald : 'var(--text-tertiary)'}
            fontSize="7" fontFamily="'Commit Mono',monospace" fontWeight="600">
            H{i === 0 ? '12' : '34'}
          </text>
        </g>
      ))}

      {/* Root node */}
      <rect x={rootX} y={rootY} width="28" height="22" rx="4"
        fill={state.rootLit ? (state.rootMatch === false ? 'var(--accent-rose-soft)' : 'var(--accent-emerald-soft)') : 'var(--bg-subtle)'}
        stroke={rootColor}
        strokeWidth={state.rootLit ? 2 : 1}
        style={{
          transition: 'fill 0.3s, stroke 0.3s',
          filter: state.rootLit ? `drop-shadow(0 0 10px ${state.rootMatch === false ? 'rgba(248,113,113,0.5)' : 'rgba(34,211,138,0.5)'})` : 'none',
          animation: state.rootLit && state.rootMatch !== false ? 'emerald-pulse 1.5s ease-in-out 2' : 'none',
        }}/>
      <text x={rootX + 14} y={rootY + 14} textAnchor="middle"
        fill={state.rootLit ? rootColor : 'var(--text-tertiary)'}
        fontSize="7" fontFamily="'Commit Mono',monospace" fontWeight="700">
        ROOT
      </text>
    </svg>
  );
}

/* ── Main component ─────────────────────────────────────────────── */
type VerifyStatus = 'idle' | 'running' | 'done' | 'error';

export function OnChainReceiptPreview() {
  const [status, setStatus] = useState<VerifyStatus>('idle');
  const [nodeState, setNodeState] = useState<MerkleNodeState>({
    leafLit: [false, false, false, false],
    parentLit: [false, false],
    rootLit: false,
    rootMatch: null,
  });
  const [hoveredLeaf, setHoveredLeaf] = useState<number | null>(null);
  const [verifyResult, setVerifyResult] = useState<{ valid: boolean; computedRoot: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const handleStep = useCallback((step: VerifyStep) => {
    setNodeState(prev => {
      const next = { ...prev, leafLit: [...prev.leafLit], parentLit: [...prev.parentLit] };
      if (step.stage === 'leaf' && step.index !== undefined) {
        next.leafLit[step.index] = true;
      } else if (step.stage === 'parent' && step.index !== undefined) {
        // index encodes depth*100 + position
        const pos = step.index % 100;
        next.parentLit[pos] = true;
      } else if (step.stage === 'root') {
        next.rootLit = true;
      }
      return next;
    });
  }, []);

  const runVerify = useCallback(async () => {
    if (status === 'running') return;
    setStatus('running');
    setNodeState({ leafLit: [false, false, false, false], parentLit: [false, false], rootLit: false, rootMatch: null });
    setVerifyResult(null);

    try {
      const result = await verifyReceipt(SAMPLE_TRANSCRIPT, SAMPLE_ROOT, handleStep);
      setVerifyResult(result);
      setNodeState(prev => ({ ...prev, rootMatch: result.valid }));
      setStatus('done');
    } catch {
      setStatus('error');
    }
  }, [status, handleStep]);

  const copyRoot = () => {
    navigator.clipboard.writeText(`0x${SAMPLE_ROOT}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const shortHash = (h: string) => `0x${h.slice(0, 8)}…${h.slice(-4)}`;

  return (
    <section className="section-padding" style={{ background: 'var(--bg-base)' }}>
      <div className="content-rail">
        {/* Heading */}
        <div style={{ textAlign: 'center', marginBottom: '64px' }}>
          <div className="eyebrow" style={{ color: 'var(--accent-emerald)', marginBottom: '16px' }}>
            Cryptographic Proof
          </div>
          <h2 style={{ textTransform: 'uppercase', marginBottom: '16px' }}>
            On-Chain Receipt
          </h2>
          <p className="lead" style={{ maxWidth: '520px', margin: '0 auto' }}>
            Every deliberation produces a Merkle root committed to Solana.
            Click Verify to watch the browser recompute it live.
          </p>
        </div>

        <div style={{ maxWidth: '760px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* Receipt card */}
          <div className="card">
            <div className="eyebrow" style={{ color: 'var(--text-tertiary)', marginBottom: '20px' }}>
              Proof of Deliberation
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px', marginBottom: '20px' }}>
              {[
                { label: 'Final Answer', value: 'Monolithic architecture' },
                { label: 'Confidence', value: '87.3%' },
                { label: 'Rounds', value: '3 (adaptive termination)' },
                { label: 'Mechanism', value: 'DEBATE' },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace", marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                  <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontFamily: "'Commit Mono', monospace" }}>{value}</div>
                </div>
              ))}
            </div>

            {/* On-chain receipt sub-card */}
            <div style={{
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border-default)',
              borderRadius: '10px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}>
              <div className="eyebrow" style={{ color: 'var(--text-tertiary)' }}>On-Chain Receipt</div>
              {[
                { label: 'Merkle Root', value: shortHash(SAMPLE_ROOT), action: 'copy', onAction: copyRoot },
                { label: 'Solana Tx', value: '0x9c1d…4f7a', action: 'explorer' },
                { label: 'Slot', value: '289,441,127' },
              ].map(({ label, value, action, onAction }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace" }}>{label}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="hash-inline">{value}</span>
                    {action === 'copy' && (
                      <button onClick={onAction} style={{ fontSize: '10px', color: 'var(--accent-emerald)', fontFamily: "'Commit Mono', monospace", cursor: 'pointer' }}>
                        {copied ? 'Copied!' : '[copy]'}
                      </button>
                    )}
                    {action === 'explorer' && (
                      <a href="https://explorer.solana.com" target="_blank" rel="noopener" style={{ fontSize: '10px', color: 'var(--accent-emerald)', fontFamily: "'Commit Mono', monospace" }}>
                        [explorer ↗]
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Merkle tree visualization */}
          <div className="card">
            <div className="eyebrow" style={{ color: 'var(--text-tertiary)', marginBottom: '16px' }}>Merkle Tree</div>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '8px' }}>
              <MerkleTreeViz state={nodeState} onLeafHover={setHoveredLeaf} hoveredLeaf={hoveredLeaf} />
            </div>
            {hoveredLeaf !== null && (
              <div style={{
                fontSize: '11px',
                color: 'var(--text-secondary)',
                fontFamily: "'Hanken Grotesk', sans-serif",
                padding: '10px',
                background: 'var(--bg-subtle)',
                borderRadius: '8px',
                borderLeft: '2px solid var(--accent-emerald)',
                lineHeight: 1.5,
              }}>
                <span style={{ color: 'var(--accent-emerald)', fontFamily: "'Commit Mono', monospace" }}>{LEAF_LABELS[hoveredLeaf]}:</span>{' '}
                {SAMPLE_TRANSCRIPT[hoveredLeaf].slice(0, 120)}…
              </div>
            )}
          </div>

          {/* Verify button + result */}
          <div style={{ textAlign: 'center' }}>
            <button
              onClick={runVerify}
              disabled={status === 'running'}
              className="btn-primary"
              style={{ marginBottom: '12px', fontSize: '14px', opacity: status === 'running' ? 0.7 : 1 }}
            >
              {status === 'running' ? '⟳ Computing SHA-256…' : '→ Verify Proof'}
            </button>

            {status === 'done' && verifyResult && (
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 16px',
                background: verifyResult.valid ? 'var(--accent-emerald-soft)' : 'var(--accent-rose-soft)',
                border: `1px solid ${verifyResult.valid ? 'var(--accent-emerald)' : 'var(--accent-rose)'}`,
                borderRadius: '8px',
                fontSize: '13px',
                fontFamily: "'Commit Mono', monospace",
                color: verifyResult.valid ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                animation: 'slide-in-up 0.3s ease',
              }}>
                {verifyResult.valid ? '✓ MATCH — Proof verified.' : '✗ MISMATCH'}
              </div>
            )}

            <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '12px', fontFamily: "'Commit Mono', monospace" }}>
              Tip: open DevTools Console to watch the hashes compute
            </p>
          </div>

          {/* aria-live */}
          <div aria-live="polite" style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
            {status === 'done' && verifyResult?.valid ? 'Proof verified. Root matches.' : ''}
          </div>
        </div>
      </div>
    </section>
  );
}
