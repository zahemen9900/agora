import { useState } from 'react';
import { motion } from 'framer-motion';

// ── Card 1 viz: Feature bars → decision label ──────────────────────
function SelectorViz({ hovered }: { hovered: boolean }) {
  return (
    <svg viewBox="0 0 200 130" className="w-full h-full" aria-hidden="true">
      <defs>
        <filter id="sv-glow">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* Bar 1 — complexity */}
      <text x="10" y="24" fill="var(--text-muted)" fontSize="8" fontFamily="'Roboto Mono', monospace">
        complexity
      </text>
      <rect x="10" y="28" height="10" rx="3" fill="var(--border-muted)" width="164" />
      <rect
        x="10" y="28" height="10" rx="3"
        fill="var(--accent)"
        style={{
          width: hovered ? 140 : 0,
          transition: 'width 0.8s ease',
          opacity: 0.85,
        }}
      />

      {/* Bar 2 — disagreement */}
      <text x="10" y="54" fill="var(--text-muted)" fontSize="8" fontFamily="'Roboto Mono', monospace">
        disagreement
      </text>
      <rect x="10" y="58" height="10" rx="3" fill="var(--border-muted)" width="164" />
      <rect
        x="10" y="58" height="10" rx="3"
        fill="var(--opponent)"
        style={{
          width: hovered ? 154 : 0,
          transition: 'width 0.8s ease 0.2s',
          opacity: 0.75,
        }}
      />

      {/* Bar 3 — stakes */}
      <text x="10" y="84" fill="var(--text-muted)" fontSize="8" fontFamily="'Roboto Mono', monospace">
        stakes
      </text>
      <rect x="10" y="88" height="10" rx="3" fill="var(--border-muted)" width="164" />
      <rect
        x="10" y="88" height="10" rx="3"
        fill="var(--devil-advocate)"
        style={{
          width: hovered ? 100 : 0,
          transition: 'width 0.8s ease 0.35s',
          opacity: 0.75,
        }}
      />

      {/* Decision result */}
      <g style={{ opacity: hovered ? 1 : 0, transition: 'opacity 0.4s ease 0.9s' }}>
        <rect x="10" y="108" width="130" height="16" rx="4"
          fill="rgba(0,212,170,0.12)" stroke="var(--accent)" strokeWidth="0.75" />
        <text x="75" y="119" textAnchor="middle" fill="var(--accent)" fontSize="8.5"
          fontFamily="'Roboto Mono', monospace" fontWeight="600">
          → DEBATE (91%)
        </text>
      </g>
    </svg>
  );
}

// ── Card 2 viz: Debate columns + DA + convergence ──────────────────
function DebateViz({ hovered }: { hovered: boolean }) {
  const proLines = [64, 80, 52, 72, 58];
  const oppLines = [70, 56, 84, 60, 76];

  return (
    <svg viewBox="0 0 200 130" className="w-full h-full" aria-hidden="true">
      {/* PRO header */}
      <rect x="10" y="8" width="80" height="14" rx="3" fill="rgba(0,212,170,0.12)" />
      <text x="50" y="18" textAnchor="middle" fill="var(--proponent)" fontSize="8"
        fontFamily="'Roboto Mono', monospace" fontWeight="700" letterSpacing="1">
        PRO
      </text>

      {/* OPP header */}
      <rect x="110" y="8" width="80" height="14" rx="3" fill="rgba(255,107,107,0.12)" />
      <text x="150" y="18" textAnchor="middle" fill="var(--opponent)" fontSize="8"
        fontFamily="'Roboto Mono', monospace" fontWeight="700" letterSpacing="1">
        OPP
      </text>

      {/* PRO argument lines */}
      {proLines.map((w, i) => (
        <rect
          key={`p${i}`}
          x="10" y={28 + i * 12}
          height="6" rx="2"
          fill="var(--proponent)"
          style={{
            opacity: hovered ? 0.7 : 0,
            width: hovered ? w : 0,
            transition: `opacity 0.3s ease ${0.1 + i * 0.1}s, width 0.3s ease ${0.1 + i * 0.1}s`,
          }}
        />
      ))}

      {/* OPP argument lines */}
      {oppLines.map((w, i) => (
        <rect
          key={`o${i}`}
          x="110" y={28 + i * 12}
          height="6" rx="2"
          fill="var(--opponent)"
          style={{
            opacity: hovered ? 0.7 : 0,
            width: hovered ? w : 0,
            transition: `opacity 0.3s ease ${0.15 + i * 0.1}s, width 0.3s ease ${0.15 + i * 0.1}s`,
          }}
        />
      ))}

      {/* DA dot */}
      <g style={{ opacity: hovered ? 1 : 0, transition: 'opacity 0.4s ease 0.6s' }}>
        <circle cx="100" cy="52" r="7" fill="var(--devil-advocate)" />
        <text x="100" y="55" textAnchor="middle" fill="var(--bg-void)" fontSize="6.5"
          fontFamily="'Roboto Mono', monospace" fontWeight="700">
          DA
        </text>
        <line x1="93" y1="52" x2="84" y2="52" stroke="var(--devil-advocate)" strokeWidth="1" strokeDasharray="3 2" />
        <line x1="107" y1="52" x2="116" y2="52" stroke="var(--devil-advocate)" strokeWidth="1" strokeDasharray="3 2" />
      </g>

      {/* Convergence bar */}
      <rect x="10" y="100" width="180" height="5" rx="2.5" fill="var(--bg-elevated)" />
      <rect
        x="10" y="100" height="5" rx="2.5"
        fill="var(--accent)"
        style={{
          width: hovered ? 180 : 0,
          transition: 'width 1.5s ease 0.8s',
        }}
      />

      {/* Checkmark */}
      <g style={{ opacity: hovered ? 1 : 0, transition: 'opacity 0.3s ease 1.9s' }}>
        <text x="100" y="122" textAnchor="middle" fill="var(--accent)" fontSize="9"
          fontFamily="'Roboto Mono', monospace" fontWeight="700">
          ✓ Quorum
        </text>
      </g>
    </svg>
  );
}

// ── Card 3 viz: Merkle tree building on hover ──────────────────────
function MerkleViz({ hovered }: { hovered: boolean }) {
  const leafX = [20, 64, 108, 152];
  const leafY = 94;
  const intX = [42, 130];
  const intY = 56;
  const rootX = 86;
  const rootY = 18;

  return (
    <svg viewBox="0 0 200 130" className="w-full h-full" aria-hidden="true">
      {/* Leaf nodes — always visible */}
      {leafX.map((x, i) => (
        <rect key={`lf-${i}`} x={x} y={leafY} width="28" height="18" rx="3"
          fill="var(--bg-elevated)"
          stroke={hovered ? 'var(--accent)' : 'var(--border-muted)'}
          strokeWidth="1"
          style={{ transition: `stroke 0.3s ease ${i * 0.1}s` }}
        />
      ))}

      {/* Leaf → intermediate connector lines */}
      {[
        { x1: 34, y1: leafY, x2: 56, y2: intY + 18, delay: 0.2 },
        { x1: 78, y1: leafY, x2: 56, y2: intY + 18, delay: 0.3 },
        { x1: 122, y1: leafY, x2: 144, y2: intY + 18, delay: 0.2 },
        { x1: 166, y1: leafY, x2: 144, y2: intY + 18, delay: 0.3 },
      ].map((ln, i) => {
        const len = Math.hypot(ln.x2 - ln.x1, ln.y2 - ln.y1) + 2;
        return (
          <line key={`lc-${i}`}
            x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2}
            stroke="var(--accent)" strokeWidth="1"
            strokeDasharray={len}
            strokeDashoffset={hovered ? 0 : len}
            style={{ transition: `stroke-dashoffset 0.4s ease ${ln.delay}s`, opacity: 0.6 }}
          />
        );
      })}

      {/* Intermediate nodes */}
      {intX.map((x, i) => (
        <rect key={`int-${i}`} x={x - 14} y={intY} width="28" height="18" rx="3"
          fill="var(--bg-elevated)"
          stroke="var(--accent)"
          strokeWidth="1"
          style={{
            opacity: hovered ? 1 : 0,
            transition: `opacity 0.3s ease ${0.5 + i * 0.1}s`,
          }}
        />
      ))}

      {/* Intermediate → root connector lines */}
      {[
        { x1: 56, y1: intY, x2: rootX + 14, y2: rootY + 18, delay: 0.7 },
        { x1: 144, y1: intY, x2: rootX + 14, y2: rootY + 18, delay: 0.8 },
      ].map((ln, i) => {
        const len = Math.hypot(ln.x2 - ln.x1, ln.y2 - ln.y1) + 2;
        return (
          <line key={`rc-${i}`}
            x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2}
            stroke="var(--accent)" strokeWidth="1"
            strokeDasharray={len}
            strokeDashoffset={hovered ? 0 : len}
            style={{ transition: `stroke-dashoffset 0.4s ease ${ln.delay}s`, opacity: 0.6 }}
          />
        );
      })}

      {/* Root node */}
      <rect x={rootX} y={rootY} width="28" height="18" rx="3"
        fill={hovered ? 'rgba(0,212,170,0.15)' : 'var(--bg-elevated)'}
        stroke={hovered ? 'var(--accent)' : 'var(--border-muted)'}
        strokeWidth={hovered ? 1.5 : 1}
        style={{
          opacity: hovered ? 1 : 0,
          transition: 'opacity 0.3s ease 0.9s, fill 0.3s ease, stroke 0.3s ease',
          filter: hovered ? 'drop-shadow(0 0 4px rgba(0,212,170,0.4))' : 'none',
        }}
      />

      {/* ROOT label */}
      <text x={rootX + 14} y={rootY + 11} textAnchor="middle"
        fill="var(--accent)" fontSize="7" fontFamily="'Roboto Mono', monospace" fontWeight="600"
        style={{ opacity: hovered ? 1 : 0, transition: 'opacity 0.3s ease 0.9s' }}>
        ROOT
      </text>

      {/* Verified label */}
      <g style={{ opacity: hovered ? 1 : 0, transition: 'opacity 0.3s ease 1.1s' }}>
        <text x="100" y="122" textAnchor="middle" fill="var(--accent)" fontSize="8.5"
          fontFamily="'Roboto Mono', monospace" fontWeight="600">
          ✓ Verified on Solana
        </text>
      </g>
    </svg>
  );
}

// ── StepCard component ─────────────────────────────────────────────

interface StepCardProps {
  step: number;
  title: React.ReactNode;
  description: string;
  accentColor: string;
  delay?: number;
  vizType: 'selector' | 'debate' | 'merkle';
}

export function StepCard({ step, title, description, accentColor, delay = 0, vizType }: StepCardProps) {
  const [hovered, setHovered] = useState(false);

  const VizComponent = {
    selector: SelectorViz,
    debate: DebateViz,
    merkle: MerkleViz,
  }[vizType];

  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-50px' }}
      transition={{ duration: 0.6, delay, ease: 'easeOut' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative flex flex-col rounded-2xl overflow-hidden cursor-pointer group"
      style={{
        background: 'var(--bg-elevated)',
        border: `1px solid ${hovered ? accentColor : 'var(--border-muted)'}`,
        minHeight: '400px',
        transition: 'border-color 0.3s ease',
      }}
    >
      {/* Glow backdrop */}
      <div
        className="absolute inset-0 pointer-events-none transition-opacity duration-500"
        style={{
          background: `radial-gradient(circle at 50% 0%, ${accentColor}18 0%, transparent 60%)`,
          opacity: hovered ? 1 : 0,
        }}
      />

      {/* Step number */}
      <div className="absolute top-4 left-4 mono text-text-muted" style={{ fontSize: '10px', letterSpacing: '0.1em' }}>
        0{step}
      </div>

      {/* SVG viz zone */}
      <div
        className="flex-1 flex items-center justify-center p-8 relative overflow-hidden"
        style={{ background: 'var(--bg-overlay)', minHeight: '200px' }}
      >
        <div className="w-full max-w-[200px] h-[130px]">
          <VizComponent hovered={hovered} />
        </div>
        {/* Dot grid */}
        <div className="absolute inset-0 opacity-5 pointer-events-none"
          style={{ backgroundImage: 'radial-gradient(var(--text-muted) 1px, transparent 0)', backgroundSize: '20px 20px' }} />
      </div>

      {/* Text zone */}
      <div className="p-7 relative z-10" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <h5 className="mb-3 font-semibold uppercase tracking-wide" style={{ color: hovered ? accentColor : 'var(--text-primary)', transition: 'color 0.3s' }}>
          {title}
        </h5>
        <p className="text-text-secondary leading-relaxed" style={{ fontSize: '13px' }}>
          {description}
        </p>
      </div>
    </motion.div>
  );
}
