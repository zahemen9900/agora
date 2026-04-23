import { useEffect } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';

interface DecisionPopupProps {
  mechanism: string;
  confidence: number;
  reasoning: string;
  /** Called when user clicks "Enter deliberation" or timer expires */
  onNavigate: () => void;
  /** Auto-navigate delay in ms. Default 2800 */
  delay?: number;
}

// ─── Animated confidence ring ─────────────────────────────────────────────────
function ConfidenceRing({ pct }: { pct: number }) {
  const size = 72;
  const strokeW = 4;
  const r = (size - strokeW * 2) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * (pct / 100);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      {/* Track */}
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="var(--border-default)" strokeWidth={strokeW} />
      {/* Fill */}
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="var(--accent-emerald)" strokeWidth={strokeW}
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray 0.6s ease' }}
      />
      {/* Label */}
      <text
        x={size / 2} y={size / 2 + 1}
        dominantBaseline="middle" textAnchor="middle"
        fill="var(--text-primary)"
        fontSize="14"
        fontFamily="'Commit Mono', monospace"
        fontWeight="700"
      >
        {pct}%
      </text>
    </svg>
  );
}

// ─── Mechanism badge colour ───────────────────────────────────────────────────
function mechColor(mech: string): string {
  switch (mech.toLowerCase()) {
    case 'debate': return 'var(--accent-emerald)';
    case 'vote':   return '#60a5fa'; // blue-400
    case 'delphi': return '#a78bfa'; // violet-400
    case 'moa':    return '#f59e0b'; // amber-400
    default:       return 'var(--text-primary)';
  }
}

export function DecisionPopup({ mechanism, confidence, reasoning, onNavigate, delay = 2800 }: DecisionPopupProps) {
  const pct = Math.round(confidence * 100);
  const color = mechColor(mechanism);

  // Auto-navigate after delay
  useEffect(() => {
    const t = setTimeout(onNavigate, delay);
    return () => clearTimeout(t);
  }, [onNavigate, delay]);

  return (
    <>
      {/* Backdrop */}
      <div style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(8px)',
        zIndex: 2000,
        animation: 'agora-fade-in 0.2s ease',
      }} />

      {/* Card */}
      <div
        role="alertdialog"
        aria-label="Deliberation mechanism selected"
        style={{
          position: 'fixed',
          top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(480px, calc(100vw - 32px))',
          background: 'var(--bg-elevated)',
          border: `1px solid ${color}40`,
          borderRadius: '20px',
          boxShadow: `0 0 0 1px ${color}20, 0 32px 80px rgba(0,0,0,0.5)`,
          padding: '32px',
          zIndex: 2001,
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
          animation: 'agora-fade-in 0.25s ease',
        }}
      >
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <ConfidenceRing pct={pct} />
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: '10px',
              fontFamily: "'Commit Mono', monospace",
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              marginBottom: '6px',
            }}>
              Agora selected
            </div>
            <div style={{
              fontSize: '28px',
              fontFamily: "'Commit Mono', monospace",
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color,
            }}>
              {mechanism}
            </div>
          </div>

          {/* Spinning indicator — shows the deliberation is starting */}
          <Loader2
            size={20}
            style={{ color: 'var(--text-tertiary)', animation: 'agora-spinner 1.2s linear infinite', flexShrink: 0 }}
          />
        </div>

        {/* Divider */}
        <div style={{ height: '1px', background: 'var(--border-default)' }} />

        {/* Reasoning excerpt */}
        <div>
          <div style={{
            fontSize: '10px',
            fontFamily: "'Commit Mono', monospace",
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: '8px',
          }}>
            Selector reasoning
          </div>
          <p style={{
            fontSize: '13px',
            fontFamily: "'Commit Mono', monospace",
            color: 'var(--text-secondary)',
            lineHeight: '1.65',
            margin: 0,
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>
            {reasoning}
          </p>
        </div>

        {/* Progress bar — shows time remaining */}
        <div style={{ height: '2px', background: 'var(--border-default)', borderRadius: '2px', overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            background: color,
            borderRadius: '2px',
            animation: `agora-progress ${delay / 1000}s linear forwards`,
          }} />
        </div>

        {/* CTA */}
        <button
          type="button"
          onClick={onNavigate}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            padding: '13px 0',
            borderRadius: '10px',
            background: color,
            color: '#000',
            border: 'none',
            cursor: 'pointer',
            fontSize: '13px',
            fontFamily: "'Commit Mono', monospace",
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            transition: 'opacity 0.15s ease',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.88'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
        >
          Enter deliberation <ArrowRight size={15} />
        </button>
      </div>
    </>
  );
}
