import { useEffect, useState } from 'react';

// 5-phase, 12-second looping SVG diagram of the Agora pipeline.
// Phase advances every 2-4 seconds via setInterval.
// CSS animations keyed off data-phase attribute handle all motion.
const PHASE_DURATIONS = [2000, 2000, 4000, 2000, 2000]; // ms each phase lasts

export function HeroDiagram() {
  const [phase, setPhase] = useState(1);
  const [round, setRound] = useState(1);

  useEffect(() => {
    let current = 1;
    let timeout: ReturnType<typeof setTimeout>;

    const advance = () => {
      timeout = setTimeout(() => {
        current = current < 5 ? current + 1 : 1;
        if (current === 1) setRound(1);
        setPhase(current);
        advance();
      }, PHASE_DURATIONS[current - 1]);
    };

    advance();
    return () => clearTimeout(timeout);
  }, []);

  // Round counter cycles during phase 3
  useEffect(() => {
    if (phase !== 3) return;
    let r = 1;
    const id = setInterval(() => {
      r = r < 3 ? r + 1 : 1;
      setRound(r);
    }, 1300);
    return () => clearInterval(id);
  }, [phase]);

  const active = (p: number) => phase >= p;
  const is = (p: number) => phase === p;

  return (
    <div className="relative w-full flex items-center justify-center select-none" aria-hidden="true">
      <svg
        viewBox="0 0 480 420"
        className="w-full max-w-[500px]"
        style={{ filter: 'drop-shadow(0 0 24px rgba(0,212,170,0.08))' }}
      >
        <defs>
          <filter id="hd-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="hd-glow-strong" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Flowing dot path: task → selector → debate → hasher → solana */}
          <path
            id="hd-full-path"
            d="M240,30 L240,90 L240,145 L240,220 L240,310 L240,370"
            fill="none"
          />
        </defs>

        {/* ── Phase 1: Task arrives ─────────────────────────── */}

        {/* Task dot + label */}
        <g style={{ opacity: active(1) ? 1 : 0, transition: 'opacity 0.4s' }}>
          <circle
            cx="240" cy="30" r="6"
            fill="var(--accent)"
            filter="url(#hd-glow)"
            style={{
              animation: active(1) ? 'pulse-glow 1.5s ease-in-out infinite' : 'none',
            }}
          />
          <text x="254" y="34" fill="var(--text-secondary)" fontSize="10" fontFamily="'Roboto Mono', monospace">
            Task
          </text>
        </g>

        {/* Path line: task → selector (draws in phase 1) */}
        <line
          x1="240" y1="36" x2="240" y2="89"
          stroke="var(--border-muted)"
          strokeWidth="1"
          strokeDasharray="54"
          strokeDashoffset={active(1) ? 0 : 54}
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />

        {/* Task text bubble */}
        {active(1) && (
          <g style={{ animation: 'phase-fade-in 0.5s ease forwards' }}>
            <rect x="154" y="44" width="172" height="22" rx="4"
              fill="var(--bg-elevated)" stroke="var(--border-subtle)" strokeWidth="1" />
            <text x="240" y="58" textAnchor="middle" fill="var(--text-muted)" fontSize="8.5"
              fontFamily="'Roboto Mono', monospace">
              Should we use microservices?
            </text>
          </g>
        )}

        {/* ── Phase 2: Selector ────────────────────────────── */}

        {/* Selector diamond node */}
        <g style={{ opacity: active(2) ? 1 : 0.15, transition: 'opacity 0.4s' }}>
          <rect
            x="196" y="90" width="88" height="56" rx="8"
            fill="var(--bg-elevated)"
            stroke={active(2) ? 'var(--accent)' : 'var(--border-subtle)'}
            strokeWidth={active(2) ? 1.5 : 1}
            style={{ transition: 'stroke 0.4s' }}
          />
          <text x="240" y="114" textAnchor="middle" fill="var(--text-secondary)" fontSize="9"
            fontFamily="'Roboto Mono', monospace" fontWeight="600" letterSpacing="0.5">
            SELECTOR
          </text>

          {/* Cycling status text */}
          {is(2) ? (
            <text x="240" y="128" textAnchor="middle" fill="var(--accent)" fontSize="8"
              fontFamily="'Roboto Mono', monospace"
              style={{ animation: 'phase-fade-in 0.3s ease forwards' }}>
              DEBATE (91%)
            </text>
          ) : active(3) ? (
            <text x="240" y="128" textAnchor="middle" fill="var(--accent)" fontSize="8"
              fontFamily="'Roboto Mono', monospace">
              DEBATE (91%)
            </text>
          ) : (
            <text x="240" y="128" textAnchor="middle" fill="var(--text-muted)" fontSize="8"
              fontFamily="'Roboto Mono', monospace">
              analyzing...
            </text>
          )}
        </g>

        {/* Branch lines: selector → debate box */}
        <line
          x1="240" y1="146" x2="240" y2="159"
          stroke="var(--accent)"
          strokeWidth="1"
          strokeDasharray="14"
          strokeDashoffset={active(2) ? 0 : 14}
          style={{ transition: 'stroke-dashoffset 0.5s ease 0.2s' }}
        />

        {/* ── Phase 3: Debate box ──────────────────────────── */}

        {/* Debate box outer */}
        <g style={{ opacity: active(3) ? 1 : 0, transition: 'opacity 0.5s 0.1s' }}>
          <rect x="100" y="160" width="280" height="148" rx="8"
            fill="var(--bg-surface)"
            stroke={is(3) ? 'var(--border-muted)' : 'var(--border-subtle)'}
            strokeWidth="1"
          />

          {/* PRO column header */}
          <rect x="108" y="168" width="118" height="18" rx="4"
            fill="rgba(0,212,170,0.1)" />
          <text x="167" y="181" textAnchor="middle" fill="var(--proponent)" fontSize="8"
            fontFamily="'Roboto Mono', monospace" fontWeight="700" letterSpacing="1">
            PRO
          </text>

          {/* OPP column header */}
          <rect x="254" y="168" width="118" height="18" rx="4"
            fill="rgba(255,107,107,0.1)" />
          <text x="313" y="181" textAnchor="middle" fill="var(--opponent)" fontSize="8"
            fontFamily="'Roboto Mono', monospace" fontWeight="700" letterSpacing="1">
            OPP
          </text>

          {/* PRO argument lines (animated) */}
          {[0, 1, 2, 3, 4].map((i) => (
            <rect
              key={`pro-${i}`}
              x="112" y={192 + i * 13}
              height="7" rx="2"
              fill="var(--proponent)"
              style={{
                opacity: is(3) ? 1 : 0.3,
                width: is(3) ? [72, 88, 60, 80, 54][i] : [72, 88, 60, 80, 54][i],
                animation: is(3) ? `text-line-appear 0.3s ease ${0.1 + i * 0.15}s both` : 'none',
              }}
            />
          ))}

          {/* OPP argument lines (animated) */}
          {[0, 1, 2, 3, 4].map((i) => (
            <rect
              key={`opp-${i}`}
              x="258" y={192 + i * 13}
              height="7" rx="2"
              fill="var(--opponent)"
              style={{
                opacity: is(3) ? 1 : 0.3,
                width: is(3) ? [68, 90, 74, 56, 84][i] : [68, 90, 74, 56, 84][i],
                animation: is(3) ? `text-line-appear 0.3s ease ${0.2 + i * 0.15}s both` : 'none',
              }}
            />
          ))}

          {/* DA dot (Devil's Advocate) */}
          <g style={{ opacity: is(3) ? 1 : 0, transition: 'opacity 0.3s 0.6s' }}>
            <circle cx="240" cy="210" r="8"
              fill="var(--devil-advocate)"
              filter="url(#hd-glow)"
              style={{ animation: is(3) ? 'pulse-glow 2s ease-in-out infinite' : 'none' }}
            />
            <text x="240" y="213" textAnchor="middle" fill="var(--bg-void)" fontSize="7"
              fontFamily="'Roboto Mono', monospace" fontWeight="700">
              DA
            </text>
            {/* DA challenge lines */}
            <line x1="232" y1="210" x2="220" y2="210"
              stroke="var(--devil-advocate)" strokeWidth="1" strokeDasharray="4 2"
              style={{ animation: is(3) ? 'phase-fade-in 0.4s ease 0.8s both' : 'none' }} />
            <line x1="248" y1="210" x2="260" y2="210"
              stroke="var(--devil-advocate)" strokeWidth="1" strokeDasharray="4 2"
              style={{ animation: is(3) ? 'phase-fade-in 0.4s ease 0.8s both' : 'none' }} />
          </g>

          {/* Round counter */}
          <text x="240" y="282" textAnchor="middle" fill="var(--text-muted)" fontSize="8"
            fontFamily="'Roboto Mono', monospace">
            {is(3) ? `Round ${round}/3` : 'Round 3/3'}
          </text>

          {/* Convergence bar track */}
          <rect x="120" y="288" width="240" height="6" rx="3"
            fill="var(--bg-elevated)" />
          {/* Convergence bar fill */}
          <rect x="120" y="288" rx="3" height="6"
            fill="var(--accent)"
            style={{
              width: is(3) ? `${(round / 3) * 240}px` : '240px',
              transition: 'width 1.2s ease',
            }}
          />

          {/* Quorum label */}
          {active(4) && (
            <text x="240" y="298" textAnchor="middle" fill="var(--accent)" fontSize="7.5"
              fontFamily="'Roboto Mono', monospace"
              style={{ animation: 'phase-fade-in 0.3s ease forwards' }}>
              ✓ QUORUM
            </text>
          )}
        </g>

        {/* Path: debate → hasher */}
        <line
          x1="240" y1="308" x2="240" y2="329"
          stroke="var(--border-muted)"
          strokeWidth="1"
          strokeDasharray="22"
          strokeDashoffset={active(4) ? 0 : 22}
          style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />

        {/* ── Phase 4: Merkle hasher ────────────────────────── */}

        <g style={{ opacity: active(4) ? 1 : 0, transition: 'opacity 0.4s' }}>
          <rect x="170" y="330" width="140" height="52" rx="8"
            fill="var(--bg-elevated)"
            stroke={is(4) ? 'var(--accent)' : 'var(--border-subtle)'}
            strokeWidth="1"
            style={{ transition: 'stroke 0.3s' }}
          />
          <text x="240" y="348" textAnchor="middle" fill="var(--text-secondary)" fontSize="9"
            fontFamily="'Roboto Mono', monospace" fontWeight="600" letterSpacing="0.5">
            HASHER
          </text>

          {/* Mini Merkle leaf squares */}
          {[0, 1, 2, 3].map((i) => (
            <rect
              key={`leaf-${i}`}
              x={185 + i * 26} y="356"
              width="14" height="14" rx="2"
              fill="none"
              stroke={active(4) ? 'var(--accent)' : 'var(--border-subtle)'}
              strokeWidth="1"
              style={{
                opacity: active(4) ? 1 : 0,
                animation: active(4) ? `merkle-appear 0.3s ease ${i * 0.1}s both` : 'none',
              }}
            />
          ))}

          {/* Merkle connector lines */}
          {active(4) && (
            <>
              <line x1="199" y1="356" x2="211" y2="356"
                stroke="var(--accent)" strokeWidth="0.8" opacity="0.5"
                style={{ animation: 'phase-fade-in 0.3s ease 0.4s both' }} />
              <line x1="251" y1="356" x2="263" y2="356"
                stroke="var(--accent)" strokeWidth="0.8" opacity="0.5"
                style={{ animation: 'phase-fade-in 0.3s ease 0.4s both' }} />
            </>
          )}
        </g>

        {/* Path: hasher → solana */}
        <line
          x1="240" y1="382" x2="240" y2="395"
          stroke="var(--border-muted)"
          strokeWidth="1"
          strokeDasharray="14"
          strokeDashoffset={active(5) ? 0 : 14}
          style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />

        {/* ── Phase 5: On-chain receipt ──────────────────────── */}

        <g style={{ opacity: active(5) ? 1 : 0, transition: 'opacity 0.4s' }}>
          <rect x="178" y="396" width="124" height="18" rx="4"
            fill="rgba(0,212,170,0.12)"
            stroke="var(--accent)"
            strokeWidth="1"
          />
          <text x="240" y="408" textAnchor="middle"
            fill="var(--accent)" fontSize="8.5"
            fontFamily="'Roboto Mono', monospace" fontWeight="600">
            ✓ Verified on Solana
          </text>
        </g>

        {/* ── Flowing dot along the main path ──────────────── */}
        {active(1) && (
          <circle r="3.5" fill="var(--accent)" filter="url(#hd-glow-strong)">
            <animateMotion
              dur="12s"
              repeatCount="indefinite"
              path="M240,30 L240,90 L240,160 L240,310 L240,382 L240,396"
            />
          </circle>
        )}
      </svg>

      {/* Phase label — bottom */}
      <div
        className="absolute bottom-0 left-0 right-0 flex justify-center"
        style={{ pointerEvents: 'none' }}
      >
        <span
          className="mono text-text-muted"
          style={{ fontSize: '9px', letterSpacing: '0.08em', opacity: 0.6 }}
        >
          {['', 'TASK ARRIVES', 'MECHANISM SELECTED', 'DEBATE RUNNING', 'MERKLE COMMIT', 'ON-CHAIN RECEIPT'][phase]}
        </span>
      </div>
    </div>
  );
}
