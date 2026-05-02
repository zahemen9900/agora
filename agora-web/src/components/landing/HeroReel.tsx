import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { useAuth } from '../../lib/useAuth';

/* ── Reduced-motion detection ─────────────────────────────────── */
function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return reduced;
}

/* ── Mobile detection ─────────────────────────────────────────── */
function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return mobile;
}

/* ══════════════════════════════════════════════════════════════
   LOOPING ANIMATED SVG — drives visual off an internal 0→1 progress
   that advances via requestAnimationFrame. Total loop: ~16s.
══════════════════════════════════════════════════════════════ */
function AnimatedMock({ progress }: { progress: number }) {
  const p = progress;
  const past = (t: number) => p >= t;
  const within = (start: number, end: number) =>
    Math.max(0, Math.min(1, (p - start) / (end - start)));

  // Eased helpers
  const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

  // Selector confidence counter
  const confidence = Math.round(easeOut(within(0.16, 0.28)) * 91);

  // Bar widths
  const proWidths = [72, 88, 60, 80, 54];
  const oppWidths = [68, 90, 74, 56, 84];

  // Round counter
  const roundProgress = within(0.60, 0.78);
  const round = Math.min(3, Math.floor(roundProgress * 3) + 1);

  // DA pulse phase
  const daPulse = past(0.55) ? 1 + 0.25 * Math.sin(p * 40) : 0;

  // Merkle build phase (0.85 - 1.0)
  const mkPhase = within(0.85, 1.0);

  // Root glow intensity (final pulse)
  const rootGlow = past(0.95) ? 0.5 + 0.5 * Math.sin(p * 50) : 0;

  return (
    <svg
      viewBox="0 0 480 460"
      className="w-full max-w-[520px]"
      aria-hidden="true"
      style={{ filter: `drop-shadow(0 0 ${24 + rootGlow * 18}px rgba(34,211,138,${0.08 + rootGlow * 0.12}))` }}
    >
      <defs>
        <filter id="am-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="am-glow-soft" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <linearGradient id="pro-fill" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--accent-emerald)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--accent-emerald)" stopOpacity="0.4" />
        </linearGradient>
        <linearGradient id="opp-fill" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--accent-rose)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--accent-rose)" stopOpacity="0.4" />
        </linearGradient>
        <radialGradient id="bg-halo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent-emerald)" stopOpacity="0.08" />
          <stop offset="100%" stopColor="var(--accent-emerald)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Ambient halo behind mock */}
      <circle cx="240" cy="230" r="220" fill="url(#bg-halo)" opacity={0.4 + within(0.18, 0.95) * 0.6} />

      {/* Subtle reference grid */}
      <g opacity="0.08" stroke="var(--text-tertiary)" strokeWidth="0.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <line key={`gh-${i}`} x1="0" y1={90 + i * 80} x2="480" y2={90 + i * 80} />
        ))}
      </g>

      {/* ── Stage 1: Task bubble ── */}
      <g opacity={past(0.02) ? 1 : 0} style={{ transition: 'opacity 0.4s' }}>
        <circle
          cx="240"
          cy="28"
          r={4 + (past(0.05) ? 2 * Math.abs(Math.sin(p * 12)) : 0)}
          fill="var(--accent-emerald)"
          filter="url(#am-glow)"
        />
        <rect
          x="128"
          y="38"
          width="224"
          height="22"
          rx="6"
          fill="var(--bg-elevated)"
          stroke="var(--border-default)"
          strokeWidth="1"
        />
        {past(0.04) && (
          <text
            x="240"
            y="53"
            textAnchor="middle"
            fill="var(--text-secondary)"
            fontSize="9"
            fontFamily="'Commit Mono',monospace"
          >
            {past(0.10)
              ? 'Should we use microservices?'
              : 'Should we use microservices?'.slice(0, Math.floor(within(0.04, 0.10) * 30))}
            {!past(0.10) && within(0.04, 0.10) > 0 && (
              <tspan fill="var(--accent-emerald)">▋</tspan>
            )}
          </text>
        )}
      </g>

      {/* ── Stage 2: Connector to selector ── */}
      <line
        x1="240"
        y1="60"
        x2="240"
        y2="90"
        stroke="var(--accent-emerald)"
        strokeWidth="1.2"
        strokeDasharray="30"
        strokeDashoffset={30 - within(0.11, 0.16) * 30}
        opacity={past(0.11) ? 1 : 0}
      />
      {/* Data pulse flowing down */}
      {past(0.12) && !past(0.18) && (
        <circle
          cx="240"
          cy={60 + within(0.12, 0.18) * 30}
          r="2.5"
          fill="var(--accent-emerald)"
          filter="url(#am-glow)"
        />
      )}

      {/* ── Stage 3: Selector box ── */}
      <rect
        x="188"
        y="90"
        width="104"
        height="56"
        rx="10"
        fill="var(--bg-elevated)"
        stroke={past(0.18) ? 'var(--accent-emerald)' : 'var(--border-default)'}
        strokeWidth={past(0.18) ? 1.6 : 1}
        opacity={past(0.14) ? 1 : 0}
        style={{ transition: 'opacity 0.3s, stroke 0.3s, stroke-width 0.3s' }}
      />
      {/* Scanning line inside selector while analyzing */}
      {past(0.14) && !past(0.28) && (
        <line
          x1="194"
          y1={96 + ((p * 600) % 44)}
          x2="286"
          y2={96 + ((p * 600) % 44)}
          stroke="var(--accent-emerald)"
          strokeWidth="0.6"
          opacity="0.6"
        />
      )}
      <text
        x="240"
        y="112"
        textAnchor="middle"
        fill="var(--text-secondary)"
        fontSize="9.5"
        fontFamily="'Commit Mono',monospace"
        fontWeight="600"
        opacity={past(0.14) ? 1 : 0}
      >
        SELECTOR
      </text>
      {past(0.14) && !past(0.28) && (
        <text
          x="240"
          y="132"
          textAnchor="middle"
          fill={past(0.18) ? 'var(--accent-emerald)' : 'var(--text-tertiary)'}
          fontSize="8.5"
          fontFamily="'Commit Mono',monospace"
        >
          {past(0.18) ? `DEBATE (${confidence}%)` : 'analyzing…'}
        </text>
      )}
      {past(0.28) && (
        <text
          x="240"
          y="132"
          textAnchor="middle"
          fill="var(--accent-emerald)"
          fontSize="8.5"
          fontFamily="'Commit Mono',monospace"
        >
          DEBATE (91%)
        </text>
      )}

      {/* ── Stage 4: Fan lines to PRO/OPP ── */}
      {past(0.28) && (
        <>
          <path
            d="M 215 146 Q 180 152 155 162"
            fill="none"
            stroke="var(--accent-emerald)"
            strokeWidth="1.2"
            strokeDasharray="60"
            strokeDashoffset={60 - within(0.28, 0.36) * 60}
          />
          <path
            d="M 265 146 Q 300 152 325 162"
            fill="none"
            stroke="var(--accent-rose)"
            strokeWidth="1.2"
            strokeDasharray="60"
            strokeDashoffset={60 - within(0.28, 0.36) * 60}
          />
        </>
      )}

      {/* ── PRO box ── */}
      <g
        opacity={within(0.30, 0.38)}
        style={{
          transformOrigin: '160px 225px',
          transform: `scale(${0.88 + within(0.30, 0.38) * 0.12})`,
        }}
      >
        <rect
          x="86"
          y="162"
          width="138"
          height="134"
          rx="10"
          fill="var(--bg-elevated)"
          stroke="var(--accent-emerald)"
          strokeWidth="1.2"
        />
        <rect x="94" y="170" width="122" height="18" rx="4" fill="var(--accent-emerald-soft)" />
        <text
          x="155"
          y="183"
          textAnchor="middle"
          fill="var(--accent-emerald)"
          fontSize="8.5"
          fontFamily="'Commit Mono',monospace"
          fontWeight="700"
          letterSpacing="1.5"
        >
          PRO
        </text>
        <circle cx="210" cy="179" r="2" fill="var(--accent-emerald)" opacity={0.5 + 0.5 * Math.sin(p * 30)} />
      </g>

      {/* ── OPP box ── */}
      <g
        opacity={within(0.32, 0.40)}
        style={{
          transformOrigin: '325px 225px',
          transform: `scale(${0.88 + within(0.32, 0.40) * 0.12})`,
        }}
      >
        <rect
          x="256"
          y="162"
          width="138"
          height="134"
          rx="10"
          fill="var(--bg-elevated)"
          stroke="var(--accent-rose)"
          strokeWidth="1.2"
        />
        <rect x="264" y="170" width="122" height="18" rx="4" fill="var(--accent-rose-soft)" />
        <text
          x="325"
          y="183"
          textAnchor="middle"
          fill="var(--accent-rose)"
          fontSize="8.5"
          fontFamily="'Commit Mono',monospace"
          fontWeight="700"
          letterSpacing="1.5"
        >
          OPP
        </text>
        <circle cx="270" cy="179" r="2" fill="var(--accent-rose)" opacity={0.5 + 0.5 * Math.sin(p * 30 + 1)} />
      </g>

      {/* ── Argument bars ── */}
      {proWidths.map((w, i) => (
        <rect
          key={`pro-${i}`}
          x="98"
          y={198 + i * 16}
          height="8"
          rx="3"
          fill="url(#pro-fill)"
          width={easeOut(within(0.38 + i * 0.015, 0.52)) * w}
        />
      ))}
      {oppWidths.map((w, i) => (
        <rect
          key={`opp-${i}`}
          x="268"
          y={198 + i * 16}
          height="8"
          rx="3"
          fill="url(#opp-fill)"
          width={easeOut(within(0.40 + i * 0.015, 0.54)) * w}
        />
      ))}

      {/* ── DA node — pulsing ── */}
      {past(0.52) && (
        <g>
          <circle
            cx="240"
            cy="228"
            r={12 * daPulse}
            fill="var(--accent-amber)"
            opacity="0.15"
          />
          <circle cx="240" cy="228" r="11" fill="var(--accent-amber)" filter="url(#am-glow-soft)" />
          <text
            x="240"
            y="232"
            textAnchor="middle"
            fill="var(--bg-base)"
            fontSize="8"
            fontFamily="'Commit Mono',monospace"
            fontWeight="700"
          >
            DA
          </text>
          {/* Cross-examination lines */}
          <line
            x1="229"
            y1="228"
            x2="212"
            y2="228"
            stroke="var(--accent-amber)"
            strokeWidth="1"
            strokeDasharray="3 2"
            opacity="0.8"
          />
          <line
            x1="251"
            y1="228"
            x2="268"
            y2="228"
            stroke="var(--accent-amber)"
            strokeWidth="1"
            strokeDasharray="3 2"
            opacity="0.8"
          />
        </g>
      )}

      {/* ── Round counter ── */}
      {past(0.60) && (
        <g>
          <rect
            x="208"
            y="308"
            width="64"
            height="20"
            rx="10"
            fill="var(--bg-subtle)"
            stroke="var(--border-default)"
            strokeWidth="1"
          />
          <text
            x="240"
            y="322"
            textAnchor="middle"
            fill="var(--text-secondary)"
            fontSize="9"
            fontFamily="'Commit Mono',monospace"
          >
            Round {round}/3
          </text>
        </g>
      )}

      {/* ── QUORUM ── */}
      {past(0.76) && (
        <g opacity={within(0.76, 0.84)}>
          <text
            x="240"
            y="348"
            textAnchor="middle"
            fill="var(--accent-emerald)"
            fontSize="12"
            fontFamily="'Commit Mono',monospace"
            fontWeight="700"
            letterSpacing="1.5"
            filter="url(#am-glow-soft)"
          >
            ✓ QUORUM
          </text>
        </g>
      )}

      {/* ── Merkle tree ── */}
      {past(0.84) && (
        <g>
          {/* Leaves (bottom row) */}
          {[170, 210, 250, 290].map((x, i) => (
            <g key={`leaf-${i}`} opacity={within(0.84 + i * 0.015, 0.90)}>
              <rect
                x={x}
                y="398"
                width="28"
                height="18"
                rx="3"
                fill="var(--accent-emerald-soft)"
                stroke="var(--accent-emerald)"
                strokeWidth="1"
              />
              <text
                x={x + 14}
                y="410"
                textAnchor="middle"
                fill="var(--accent-emerald)"
                fontSize="6.5"
                fontFamily="'Commit Mono',monospace"
              >
                h{i + 1}
              </text>
            </g>
          ))}
          {/* Edges leaves → parents */}
          {within(0.88, 0.92) > 0 && (
            <g stroke="var(--accent-emerald)" strokeWidth="0.8" opacity={within(0.88, 0.92)}>
              <line x1="184" y1="398" x2="200" y2="380" />
              <line x1="224" y1="398" x2="208" y2="380" />
              <line x1="264" y1="398" x2="280" y2="380" />
              <line x1="304" y1="398" x2="288" y2="380" />
            </g>
          )}
          {/* Parents */}
          <rect
            x="190"
            y="368"
            width="28"
            height="16"
            rx="3"
            fill="var(--accent-emerald-soft)"
            stroke="var(--accent-emerald)"
            strokeWidth="1"
            opacity={within(0.90, 0.94)}
          />
          <rect
            x="270"
            y="368"
            width="28"
            height="16"
            rx="3"
            fill="var(--accent-emerald-soft)"
            stroke="var(--accent-emerald)"
            strokeWidth="1"
            opacity={within(0.91, 0.94)}
          />
          {/* Edges parents → root */}
          {within(0.93, 0.96) > 0 && (
            <g stroke="var(--accent-emerald)" strokeWidth="0.8" opacity={within(0.93, 0.96)}>
              <line x1="204" y1="368" x2="232" y2="352" />
              <line x1="284" y1="368" x2="256" y2="352" />
            </g>
          )}
          {/* Root */}
          <rect
            x="220"
            y="336"
            width="40"
            height="18"
            rx="4"
            fill={past(0.95) ? 'var(--accent-emerald)' : 'var(--accent-emerald-soft)'}
            stroke="var(--accent-emerald)"
            strokeWidth={past(0.95) ? 2 : 1}
            filter={past(0.95) ? 'url(#am-glow)' : undefined}
            opacity={mkPhase > 0.55 ? 1 : 0}
          />
          {/* Root outer ring (final pulse) */}
          {past(0.95) && (
            <rect
              x={218 - rootGlow * 3}
              y={334 - rootGlow * 3}
              width={44 + rootGlow * 6}
              height={22 + rootGlow * 6}
              rx="6"
              fill="none"
              stroke="var(--accent-emerald)"
              strokeWidth="1"
              opacity={0.5 * (1 - rootGlow * 0.5)}
            />
          )}
          <text
            x="240"
            y="348"
            textAnchor="middle"
            fill={past(0.95) ? 'var(--bg-base)' : 'var(--accent-emerald)'}
            fontSize="8"
            fontFamily="'Commit Mono',monospace"
            fontWeight="700"
            opacity={mkPhase > 0.55 ? 1 : 0}
          >
            ROOT
          </text>
        </g>
      )}

      {/* ── PROVEN ── */}
      {past(0.94) && (
        <g opacity={within(0.94, 0.99)}>
          <text
            x="240"
            y="442"
            textAnchor="middle"
            fill="var(--accent-emerald)"
            fontSize="10"
            fontFamily="'Commit Mono',monospace"
            fontWeight="700"
            letterSpacing="4"
            filter="url(#am-glow-soft)"
          >
            PROVEN
          </text>
        </g>
      )}
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════════════════════════ */
export function HeroReel() {
  const { signIn, signUp, isLoading, authStatus } = useAuth();
  const navigate = useNavigate();
  const isAuthenticated = authStatus === 'authenticated';
  const reducedMotion = useReducedMotion();
  const isMobile = useIsMobile();
  const [progress, setProgress] = useState(reducedMotion ? 1 : 0);

  /* ── Loop the progress value via rAF ─────────────────────────── */
  useEffect(() => {
    if (reducedMotion) {
      setProgress(1);
      return;
    }

    const CYCLE_MS = 5400;  // ~5.4s per full reel (3× original 16s)
    const HOLD_MS = 1400;   // hold final state
    const FADE_MS = 300;    // cross-fade back to 0
    const TOTAL_MS = CYCLE_MS + HOLD_MS + FADE_MS;

    let raf = 0;
    let start = performance.now();
    let visible = !document.hidden;

    const tick = (t: number) => {
      if (!visible) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const elapsed = (t - start) % TOTAL_MS;
      if (elapsed < CYCLE_MS) {
        setProgress(elapsed / CYCLE_MS);
      } else if (elapsed < CYCLE_MS + HOLD_MS) {
        setProgress(1);
      } else {
        // Brief fade back — keep at 1 to avoid jarring reset visible
        setProgress(1);
      }
      raf = requestAnimationFrame(tick);
    };

    const onVis = () => {
      visible = !document.hidden;
      if (visible) start = performance.now(); // reset phase so loop starts fresh
    };
    document.addEventListener('visibilitychange', onVis);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [reducedMotion]);

  // Hard-reset to 0 at cycle boundary — done through key re-render below
  const [cycleKey, setCycleKey] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    const t = setInterval(() => setCycleKey((k) => k + 1), 5400 + 1400 + 300);
    return () => clearInterval(t);
  }, [reducedMotion]);

  return (
    <section className="hero-section">
      {/* Ambient glow — soft radial bloom behind mock, no hard edges */}
      <div className="hero-ambient-glow" aria-hidden="true" />
      <div className="hero-fade-bottom" aria-hidden="true" />

      <div
        className="content-rail hero-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
          gap: isMobile ? '48px' : '80px',
          alignItems: 'center',
          paddingTop: '40px',
          paddingBottom: '40px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* ── Left: headline + CTAs ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
          <motion.h1
            className="display"
            style={{ maxWidth: '520px' }}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          >
            Debate.<br />Vote.<br />Delphi.<br />Proved.
          </motion.h1>

          <motion.p
            className="lead"
            style={{ maxWidth: '420px' }}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
          >
            An on-chain orchestration primitive where AI agents debate, vote, and reach consensus — with every step cryptographically verified on Solana.
          </motion.p>

          <motion.div
            style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.55, ease: [0.16, 1, 0.3, 1] }}
          >
            <Button
              variant="primary"
              size="md"
              onClick={() => isAuthenticated ? navigate('/tasks') : signIn()}
              disabled={!isAuthenticated && isLoading}
              rightIcon={<ArrowRight size={16} />} trackingEvent="heroreel_action_clicked"
            >
              {isAuthenticated ? 'Enter Dashboard' : isLoading ? 'Connecting…' : 'Launch App'}
            </Button>
            {!isAuthenticated && (
              <Button
                variant="secondary"
                size="md"
                onClick={() => signUp()}
                disabled={isLoading} trackingEvent="heroreel_action_clicked"
              >
                {isLoading ? 'Loading…' : 'Create Account'}
              </Button>
            )}
          </motion.div>
        </div>

        {/* ── Right: looping animated mock ── */}
        <motion.div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          }}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.9, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          <div key={cycleKey} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
            <AnimatedMock progress={progress} />
          </div>
        </motion.div>
      </div>
    </section>
  );
}
