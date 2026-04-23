import { useEffect, useState } from 'react';

// ─── Shimmer + Terminal-Glyph Loader ────────────────────────────────────────
// Used in two spots:
//   variant="splash"  → full-page AGORA auth wait (App.tsx isLoading)
//   variant="auth"    → smaller auth-config resolving pill (auth.tsx resolvedAuthConfig null)

// ─── Random terminal glyphs ──────────────────────────────────────────────────
const GLYPHS = [
  '$8#HZ8%', '8WW8&X$~/', 'XZ&H@MM$$', 'WH@##W@8H@_',
  '&Z$X$&%#%', '8%WM8@@X', 'XM$#$$%=', '\\ZZH&XZ',
  "'lMM+~|$", '\\%s', 'Z', 'verif()', 'SHA256', 'merkle()',
  '0x7f3a…', 'quorum', 'debate()', 'PRO→OPP', 'vote_weight',
  'proof.rs', '.hash()', 'solana_tx', 'entropy_0.41',
  '#[derive]', 'impl Proof', 'pub fn verify', 'Ok(true)',
];

interface GlyphParticle {
  id: number;
  x: number;       // 0–100 vw %
  y: number;       // 0–100 vh %
  opacity: number; // 0.04–0.18
  size: number;    // 10–16px
  duration: number;
  delay: number;
  text: string;
  greenish: boolean;
}

function randomParticles(count: number): GlyphParticle[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    y: Math.random() * 100,
    opacity: 0.05 + Math.random() * 0.13,
    size: 10 + Math.random() * 6,
    duration: 8 + Math.random() * 14,
    delay: -(Math.random() * 20),
    text: GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
    greenish: Math.random() < 0.3,
  }));
}

// ─── CSS injected once ───────────────────────────────────────────────────────
const CSS = `
@keyframes agora-shine {
  0%   { background-position: -200% center; }
  100% { background-position: 200% center; }
}
@keyframes agora-glyph-drift {
  0%   { transform: translateY(0px) translateX(0px); opacity: var(--g-op); }
  33%  { transform: translateY(-18px) translateX(8px); }
  66%  { transform: translateY(12px) translateX(-10px); }
  100% { transform: translateY(0px) translateX(0px); opacity: var(--g-op); }
}
@keyframes agora-fade-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes agora-spinner {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
@keyframes agora-dot-pulse {
  0%, 80%, 100% { opacity: 0.15; transform: scale(0.7); }
  40%           { opacity: 1;    transform: scale(1); }
}
@keyframes agora-progress {
  from { width: 0%; }
  to   { width: 100%; }
}
`;

let cssInjected = false;
function injectCSS() {
  if (cssInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  cssInjected = true;
}

// ─── Shared shimmer text ─────────────────────────────────────────────────────
interface ShineWordmarkProps {
  size?: 'xl' | 'md';
}

function ShineWordmark({ size = 'xl' }: ShineWordmarkProps) {
  const fontSize = size === 'xl' ? '72px' : '38px';
  const letterSpacing = size === 'xl' ? '0.18em' : '0.14em';

  return (
    <span
      aria-label="AGORA"
      style={{
        display: 'inline-block',
        fontFamily: "'Commit Mono', 'SF Mono', 'Roboto Mono', monospace",
        fontWeight: 700,
        fontSize,
        letterSpacing,
        textTransform: 'uppercase',
        // Diagonal shine via background-clip: text
        background: `linear-gradient(
          105deg,
          var(--text-primary) 20%,
          var(--accent-emerald) 36%,
          #ffffff          42%,
          var(--accent-emerald) 48%,
          var(--text-primary) 64%
        )`,
        backgroundSize: '300% auto',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        animation: 'agora-shine 2.4s linear infinite',
        userSelect: 'none',
        willChange: 'background-position',
      }}
    >
      AGORA
    </span>
  );
}

// ─── Spinner ring ────────────────────────────────────────────────────────────
function SpinnerRing({ size = 32, strokeWidth = 2 }: { size?: number; strokeWidth?: number }) {
  const r = (size - strokeWidth * 2) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ animation: 'agora-spinner 1.1s linear infinite', flexShrink: 0 }}>
      {/* Track */}
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="var(--border-strong)" strokeWidth={strokeWidth}/>
      {/* Arc */}
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="var(--accent-emerald)" strokeWidth={strokeWidth}
        strokeDasharray={`${circ * 0.27} ${circ * 0.73}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}/>
    </svg>
  );
}

// ─── Dot trio ────────────────────────────────────────────────────────────────
function DotTrio() {
  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          width: '5px', height: '5px', borderRadius: '50%',
          background: 'var(--accent-emerald)',
          animation: `agora-dot-pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
        }}/>
      ))}
    </div>
  );
}

// ─── Full-page splash (variant="splash") ─────────────────────────────────────
function SplashLoader() {
  const [particles] = useState(() => randomParticles(40));
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Cycle through status lines
  const STATUS_LINES = [
    'Initializing deliberation network…',
    'Loading mechanism selector…',
    'Syncing on-chain receipts…',
    'Resolving authentication…',
  ];
  const [statusIdx, setStatusIdx] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    const id = setInterval(() => setStatusIdx(i => (i + 1) % STATUS_LINES.length), 2200);
    return () => clearInterval(id);
  }, [reducedMotion]);

  return (
    <div
      role="status"
      aria-label="Loading Agora"
      style={{
        position: 'fixed', inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-base)',
        overflow: 'hidden',
        zIndex: 9999,
      }}
    >
      {/* ── Ambient glow ── */}
      <div style={{
        position: 'absolute', top: '30%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '600px', height: '300px',
        background: 'radial-gradient(ellipse, rgba(34,211,138,0.07) 0%, transparent 70%)',
        pointerEvents: 'none',
      }}/>

      {/* ── Floating terminal glyphs ── */}
      {!reducedMotion && particles.map(p => (
        <span
          key={p.id}
          style={{
            position: 'absolute',
            left: `${p.x}%`,
            top: `${p.y}%`,
            fontSize: `${p.size}px`,
            fontFamily: "'Commit Mono', monospace",
            fontWeight: 400,
            color: p.greenish ? 'var(--accent-emerald)' : 'var(--text-primary)',
            opacity: p.opacity,
            animation: `agora-glyph-drift ${p.duration}s ease-in-out ${p.delay}s infinite`,
            '--g-op': p.opacity,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            willChange: 'transform',
          } as React.CSSProperties}
        >
          {p.text}
        </span>
      ))}

      {/* ── Center content ── */}
      <div style={{
        position: 'relative', zIndex: 1,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '28px',
        animation: 'agora-fade-in 0.5s ease',
      }}>
        <ShineWordmark size="xl" />

        {/* Spinner + status line */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
          <SpinnerRing size={36} strokeWidth={2.5} />

          <div style={{
            height: '18px',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
          }}>
            <p
              key={statusIdx}
              style={{
                fontSize: '12px',
                fontFamily: "'Commit Mono', monospace",
                color: 'var(--text-tertiary)',
                letterSpacing: '0.06em',
                margin: 0,
                animation: reducedMotion ? 'none' : 'agora-fade-in 0.35s ease',
              }}
            >
              {STATUS_LINES[statusIdx]}
            </p>
          </div>
        </div>

        {/* Progress bar */}
        {!reducedMotion && (
          <div style={{
            width: '160px', height: '2px',
            background: 'var(--border-default)',
            borderRadius: '2px',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              background: 'var(--accent-emerald)',
              borderRadius: '2px',
              animation: 'agora-progress 8s linear forwards',
            }}/>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Auth-config resolving state (variant="auth") ────────────────────────────
function AuthConfigLoader() {
  return (
    <div
      role="status"
      aria-label="Initializing authentication"
      style={{
        position: 'fixed', inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-base)',
        zIndex: 9999,
      }}
    >
      {/* Subtle radial glow */}
      <div style={{
        position: 'absolute',
        top: '50%', left: '50%',
        transform: 'translate(-50%,-50%)',
        width: '480px', height: '240px',
        background: 'radial-gradient(ellipse, rgba(34,211,138,0.06) 0%, transparent 70%)',
        pointerEvents: 'none',
      }}/>

      <div style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '32px',
        animation: 'agora-fade-in 0.4s ease',
      }}>
        {/* Wordmark */}
        <ShineWordmark size="md" />

        {/* Card pill */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '14px',
          padding: '14px 24px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: '12px',
          boxShadow: '0 0 0 1px rgba(34,211,138,0.08), 0 8px 32px rgba(0,0,0,0.18)',
          minWidth: '280px',
        }}>
          <SpinnerRing size={20} strokeWidth={2} />

          <div style={{ flex: 1 }}>
            <p style={{
              fontSize: '12px',
              fontFamily: "'Commit Mono', monospace",
              color: 'var(--text-secondary)',
              margin: 0,
              letterSpacing: '0.04em',
            }}>
              Loading authentication settings
            </p>
            <DotTrio />
          </div>

          {/* Emerald pulse dot */}
          <div style={{
            width: '7px', height: '7px', borderRadius: '50%',
            background: 'var(--accent-emerald)',
            boxShadow: '0 0 8px var(--accent-emerald)',
            animation: 'agora-dot-pulse 1.8s ease-in-out infinite',
            flexShrink: 0,
          }}/>
        </div>

        {/* Micro hint */}
        <p style={{
          fontSize: '11px',
          fontFamily: "'Commit Mono', monospace",
          color: 'var(--text-tertiary)',
          margin: 0,
          letterSpacing: '0.06em',
          opacity: 0.6,
        }}>
          resolving workos auth config…
        </p>
      </div>
    </div>
  );
}

// ─── Public export ───────────────────────────────────────────────────────────
interface AgoraLoaderProps {
  variant?: 'splash' | 'auth';
}

export function AgoraLoader({ variant = 'splash' }: AgoraLoaderProps) {
  injectCSS();
  return variant === 'auth' ? <AuthConfigLoader /> : <SplashLoader />;
}
