// AgoraFixViz — shows how Agora's structural interventions break the martingale.
// 7-second CSS animation loop: factions split, DA challenges, correctness spreads, quorum.

export function AgoraFixViz() {
  return (
    <div className="w-full flex flex-col items-center" aria-hidden="true">
      <svg
        viewBox="0 0 240 220"
        className="w-full max-w-[280px]"
        style={{ overflow: 'visible' }}
      >
        <defs>
          <filter id="af-glow">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <style>{`
            /* Selector node fades in at start */
            @keyframes af-selector-in {
              0%, 5%   { opacity: 0; }
              15%, 85% { opacity: 1; }
              95%, 100% { opacity: 0; }
            }
            /* PRO column appears mid-animation */
            @keyframes af-pro-in {
              0%, 20%  { opacity: 0; }
              32%, 85% { opacity: 1; }
              95%, 100% { opacity: 0; }
            }
            /* OPP column appears slightly after */
            @keyframes af-opp-in {
              0%, 24%  { opacity: 0; }
              36%, 85% { opacity: 1; }
              95%, 100% { opacity: 0; }
            }
            /* DA dot appears after factions */
            @keyframes af-da-in {
              0%, 38%  { opacity: 0; }
              48%, 80% { opacity: 1; }
              90%, 100% { opacity: 0; }
            }
            /* Verified badge */
            @keyframes af-verified {
              0%, 48%  { opacity: 0; }
              60%, 80% { opacity: 1; }
              90%, 100% { opacity: 0; }
            }
            /* Wrong dots turn correct */
            @keyframes af-wrong-to-right {
              0%, 50%   { fill: var(--opponent); }
              70%, 85%  { fill: var(--proponent); }
              95%, 100% { fill: var(--opponent); }
            }
            /* Convergence bar fills */
            @keyframes af-converge {
              0%, 55%  { width: 0px; }
              78%       { width: 160px; }
              88%, 85% { width: 160px; }
              95%, 100% { width: 0px; }
            }
            /* Quorum label */
            @keyframes af-quorum {
              0%, 77%  { opacity: 0; }
              84%, 88% { opacity: 1; }
              95%, 100% { opacity: 0; }
            }
            /* Challenge lines pulse */
            @keyframes af-challenge {
              0%, 40%   { opacity: 0; stroke-dashoffset: 30; }
              55%, 78%  { opacity: 0.8; stroke-dashoffset: 0; }
              90%, 100% { opacity: 0; }
            }
          `}</style>
        </defs>

        {/* Selector node at top */}
        <g style={{ animation: 'af-selector-in 7s ease 0s infinite' }}>
          <rect x="80" y="8" width="80" height="26" rx="6"
            fill="var(--bg-elevated)" stroke="var(--accent)" strokeWidth="1" />
          <text x="120" y="24" textAnchor="middle"
            fill="var(--accent)" fontSize="8.5"
            fontFamily="'Roboto Mono', monospace" fontWeight="600">
            SELECTOR
          </text>
        </g>

        {/* Branch lines from selector */}
        <line x1="100" y1="34" x2="60" y2="70"
          stroke="var(--border-muted)" strokeWidth="1"
          style={{ animation: 'af-pro-in 7s ease 0s infinite' }} />
        <line x1="140" y1="34" x2="180" y2="70"
          stroke="var(--border-muted)" strokeWidth="1"
          style={{ animation: 'af-opp-in 7s ease 0s infinite' }} />

        {/* PRO column */}
        <g style={{ animation: 'af-pro-in 7s ease 0s infinite' }}>
          <rect x="20" y="70" width="80" height="80" rx="6"
            fill="rgba(0,212,170,0.07)" stroke="var(--proponent)" strokeWidth="1" />
          <text x="60" y="86" textAnchor="middle" fill="var(--proponent)" fontSize="8"
            fontFamily="'Roboto Mono', monospace" fontWeight="700" letterSpacing="1">
            PRO
          </text>
          {/* Agent A1 (correct — stays teal) */}
          <circle cx="40" cy="112" r="12" fill="var(--proponent)" filter="url(#af-glow)" opacity="0.9" />
          <text x="40" y="116" textAnchor="middle" fill="var(--bg-void)" fontSize="7"
            fontFamily="'Roboto Mono', monospace" fontWeight="700">A1</text>
          {/* Agent A2 (wrong — turns correct) */}
          <circle cx="80" cy="112" r="12" fill="var(--opponent)" filter="url(#af-glow)" opacity="0.9"
            style={{ animation: 'af-wrong-to-right 7s ease 0s infinite' }} />
          <text x="80" y="116" textAnchor="middle" fill="var(--bg-void)" fontSize="7"
            fontFamily="'Roboto Mono', monospace" fontWeight="700">A2</text>
        </g>

        {/* OPP column */}
        <g style={{ animation: 'af-opp-in 7s ease 0s infinite' }}>
          <rect x="140" y="70" width="80" height="80" rx="6"
            fill="rgba(255,107,107,0.07)" stroke="var(--opponent)" strokeWidth="1" />
          <text x="180" y="86" textAnchor="middle" fill="var(--opponent)" fontSize="8"
            fontFamily="'Roboto Mono', monospace" fontWeight="700" letterSpacing="1">
            OPP
          </text>
          {/* Agent A3 (wrong — turns correct) */}
          <circle cx="180" cy="112" r="12" fill="var(--opponent)" filter="url(#af-glow)" opacity="0.9"
            style={{ animation: 'af-wrong-to-right 7s ease 0.15s infinite' }} />
          <text x="180" y="116" textAnchor="middle" fill="var(--bg-void)" fontSize="7"
            fontFamily="'Roboto Mono', monospace" fontWeight="700">A3</text>
        </g>

        {/* Verified claim badge on A1 */}
        <g style={{ animation: 'af-verified 7s ease 0s infinite' }}>
          <rect x="10" y="128" width="50" height="14" rx="3"
            fill="rgba(0,212,170,0.15)" stroke="var(--accent)" strokeWidth="0.75" />
          <text x="35" y="138" textAnchor="middle" fill="var(--accent)" fontSize="6.5"
            fontFamily="'Roboto Mono', monospace" fontWeight="700">
            ✓ LOCKED
          </text>
        </g>

        {/* DA dot center */}
        <g style={{ animation: 'af-da-in 7s ease 0s infinite' }}>
          <circle cx="120" cy="110" r="10" fill="var(--devil-advocate)" filter="url(#af-glow)" />
          <text x="120" y="113" textAnchor="middle" fill="var(--bg-void)" fontSize="7"
            fontFamily="'Roboto Mono', monospace" fontWeight="700">
            DA
          </text>
          {/* Challenge lines */}
          <line x1="110" y1="110" x2="90" y2="112"
            stroke="var(--devil-advocate)" strokeWidth="1" strokeDasharray="8 3"
            style={{ animation: 'af-challenge 7s linear 0s infinite' }} />
          <line x1="130" y1="110" x2="150" y2="112"
            stroke="var(--devil-advocate)" strokeWidth="1" strokeDasharray="8 3"
            style={{ animation: 'af-challenge 7s linear 0.1s infinite' }} />
        </g>

        {/* Convergence bar */}
        <rect x="40" y="168" width="160" height="6" rx="3" fill="var(--bg-elevated)" />
        <rect x="40" y="168" height="6" rx="3" fill="var(--accent)"
          style={{ animation: 'af-converge 7s ease 0s infinite' }} />

        {/* Quorum label */}
        <g style={{ animation: 'af-quorum 7s ease 0s infinite' }}>
          <text x="120" y="190" textAnchor="middle" fill="var(--accent)" fontSize="9"
            fontFamily="'Roboto Mono', monospace" fontWeight="700">
            ✓ Quorum
          </text>
        </g>
      </svg>

      <p className="text-text-muted text-center mt-2" style={{ fontSize: '10px', letterSpacing: '0.05em', maxWidth: '240px' }}>
        Structural interventions break the martingale
      </p>
    </div>
  );
}
