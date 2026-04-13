import { useRef } from 'react';

// Positions for 3 agent dots in a triangle
const DOTS = [
  { cx: 110, cy: 52, label: 'A1' },  // top
  { cx: 60,  cy: 140, label: 'A2' }, // bottom-left
  { cx: 160, cy: 140, label: 'A3' }, // bottom-right
];

// Connection lines between all pairs
const LINES = [
  { x1: 110, y1: 52,  x2: 60,  y2: 140, len: 103 },
  { x1: 110, y1: 52,  x2: 160, y2: 140, len: 103 },
  { x1: 60,  y1: 140, x2: 160, y2: 140, len: 100 },
];

export function MartingaleViz() {
  const svgRef = useRef<SVGSVGElement>(null);

  return (
    <div className="w-full flex flex-col items-center" aria-hidden="true">
      <svg
        ref={svgRef}
        viewBox="0 0 220 200"
        className="w-full max-w-[260px]"
        style={{ overflow: 'visible' }}
      >
        <defs>
          <filter id="mv-glow">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>

          {/* 5-second loop keyframes via CSS */}
          <style>{`
            @keyframes mv-signal {
              0%   { stroke-dashoffset: 110; opacity: 0; }
              15%  { opacity: 0.9; }
              60%  { stroke-dashoffset: 0; opacity: 0.9; }
              80%  { opacity: 0; }
              100% { stroke-dashoffset: 110; opacity: 0; }
            }
            @keyframes mv-correct-to-wrong {
              0%, 40%  { fill: var(--proponent); }
              65%, 100% { fill: var(--opponent); }
            }
            @keyframes mv-line-appear {
              0%, 20% { opacity: 0; }
              35%, 80% { opacity: 1; }
              95%, 100% { opacity: 0; }
            }
            @keyframes mv-label-appear {
              0%, 70% { opacity: 0; }
              80%, 95% { opacity: 1; }
              100% { opacity: 0; }
            }
          `}</style>
        </defs>

        {/* Connection lines — appear in middle of loop */}
        {LINES.map((ln, i) => (
          <line
            key={`base-${i}`}
            x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2}
            stroke="var(--border-muted)"
            strokeWidth="1"
            style={{
              animation: `mv-line-appear 5s ease ${i * 0.1}s infinite`,
            }}
          />
        ))}

        {/* Signal pulses along lines */}
        {LINES.map((ln, i) => (
          <line
            key={`sig-${i}`}
            x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2}
            stroke="var(--opponent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`20 ${ln.len}`}
            style={{
              animation: `mv-signal 5s linear ${0.6 + i * 0.2}s infinite`,
            }}
          />
        ))}

        {/* Agent dots */}
        {DOTS.map((dot, i) => {
          // Dot 0 (teal, "correct") turns red via animation
          // Dots 1 and 2 stay red throughout
          const isCorrect = i === 0;
          return (
            <g key={dot.label}>
              <circle
                cx={dot.cx} cy={dot.cy} r="16"
                fill={isCorrect ? 'var(--proponent)' : 'var(--opponent)'}
                filter="url(#mv-glow)"
                opacity="0.85"
                style={isCorrect ? {
                  animation: 'mv-correct-to-wrong 5s ease 0s infinite',
                } : undefined}
              />
              <text
                x={dot.cx} y={dot.cy + 4}
                textAnchor="middle"
                fill="var(--bg-void)"
                fontSize="8"
                fontFamily="'Roboto Mono', monospace"
                fontWeight="700"
              >
                {dot.label}
              </text>
            </g>
          );
        })}

        {/* "Conformity" label — fades in at end of loop */}
        <g style={{ animation: 'mv-label-appear 5s ease 0s infinite' }}>
          <rect x="20" y="168" width="180" height="20" rx="4"
            fill="rgba(255,107,107,0.12)" stroke="var(--opponent)" strokeWidth="0.75" />
          <text x="110" y="181" textAnchor="middle"
            fill="var(--opponent)" fontSize="8"
            fontFamily="'Roboto Mono', monospace">
            Majority error overrides truth
          </text>
        </g>
      </svg>

      <p className="text-text-muted text-center mt-2" style={{ fontSize: '10px', letterSpacing: '0.05em', maxWidth: '240px' }}>
        Unguided debate reinforces shared errors
      </p>
    </div>
  );
}
