import { useEffect, useRef } from "react";
import { Info } from "lucide-react";

interface ConvergenceMeterProps {
  entropy: number;
  novelty: number;
  lockedClaims: number;
  prevEntropy?: number;
}

const FONT = "'Commit Mono', 'SF Mono', monospace";

function AnimatedBar({
  value,
  color,
  delay = 0,
}: {
  value: number;       // 0–1
  color: string;
  delay?: number;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<number>(0);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const prev = prevRef.current;
    const target = Math.min(1, Math.max(0, value)) * 100;

    // Start from where we were
    bar.style.transition = "none";
    bar.style.width = `${prev}%`;

    const frame = requestAnimationFrame(() => {
      bar.style.transition = `width 0.7s cubic-bezier(0.4, 0, 0.2, 1) ${delay}s`;
      bar.style.width = `${target}%`;
      prevRef.current = target;
    });

    return () => cancelAnimationFrame(frame);
  }, [value, delay]);

  return (
    <div style={{
      height: '6px',
      background: 'var(--bg-base)',
      borderRadius: '100px',
      overflow: 'hidden',
    }}>
      <div
        ref={barRef}
        style={{
          height: '100%',
          width: '0%',
          borderRadius: '100px',
          background: color,
          boxShadow: `0 0 8px ${color}80`,
        }}
      />
    </div>
  );
}

export function ConvergenceMeter({
  entropy,
  novelty,
  lockedClaims,
  prevEntropy = 1.0,
}: ConvergenceMeterProps) {
  const isImproving = entropy <= prevEntropy;
  const entropyColor = isImproving ? 'var(--accent-emerald)' : 'var(--accent-amber, #f59e0b)';
  const noveltyColor = novelty > 0.2 ? 'var(--accent-emerald)' : 'var(--accent-amber, #f59e0b)';

  // Clamp novelty to [0,1] for display
  const noveltyPct = Math.min(1, Math.max(0, novelty));

  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-default)',
      borderRadius: '14px',
      padding: '20px 24px',
      marginBottom: '24px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Subtle top glow */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        height: '1px',
        background: 'linear-gradient(90deg, transparent, var(--accent-emerald), transparent)',
        opacity: 0.4,
      }} />

      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        marginBottom: '20px',
        fontFamily: FONT,
        fontSize: '10px',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
        fontWeight: 600,
      }}>
        CONVERGENCE
        <Info size={12} style={{ opacity: 0.6, cursor: 'help' }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '32px' }}>
        {/* Left: Disagreement Entropy */}
        <div>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: '8px',
          }}>
            <span style={{ fontFamily: FONT, fontSize: '12px', color: 'var(--text-secondary)' }}>
              Disagreement Entropy
            </span>
            <span style={{
              fontFamily: FONT,
              fontSize: '12px',
              fontWeight: 700,
              color: entropyColor,
              transition: 'color 0.4s ease',
            }}>
              {prevEntropy.toFixed(2)} → {entropy.toFixed(2)}
            </span>
          </div>
          <AnimatedBar value={entropy} color={entropyColor} />
          <div style={{
            fontFamily: FONT,
            fontSize: '9px',
            color: 'var(--text-tertiary)',
            marginTop: '6px',
            textAlign: 'right',
          }}>
            {isImproving ? '(declining)' : '(rising)'}
          </div>
        </div>

        {/* Right: Novelty + Locked Claims */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: '8px',
            }}>
              <span style={{ fontFamily: FONT, fontSize: '12px', color: 'var(--text-secondary)' }}>
                Novelty / JS Divergence
              </span>
              <span style={{
                fontFamily: FONT,
                fontSize: '12px',
                fontWeight: 700,
                color: noveltyColor,
                transition: 'color 0.4s ease',
              }}>
                {novelty.toFixed(2)}
              </span>
            </div>
            <AnimatedBar value={noveltyPct} color={noveltyColor} delay={0.1} />
          </div>

          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span style={{ fontFamily: FONT, fontSize: '12px', color: 'var(--text-secondary)' }}>
              Locked Claims
            </span>
            <span style={{
              fontFamily: FONT,
              fontSize: '12px',
              fontWeight: 700,
              color: lockedClaims > 0 ? 'var(--accent-emerald)' : 'var(--text-tertiary)',
              transition: 'color 0.4s ease',
            }}>
              {lockedClaims} verified
            </span>
          </div>

          {/* Locked claim dots */}
          {lockedClaims > 0 && (
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '-4px' }}>
              {Array.from({ length: Math.min(lockedClaims, 12) }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: 'var(--accent-emerald)',
                    opacity: 0.8,
                    animation: `cm-dot-pop 0.3s cubic-bezier(0.22,1,0.36,1) ${i * 0.04}s both`,
                  }}
                />
              ))}
              {lockedClaims > 12 && (
                <span style={{
                  fontFamily: FONT,
                  fontSize: '9px',
                  color: 'var(--text-tertiary)',
                  alignSelf: 'center',
                }}>+{lockedClaims - 12}</span>
              )}
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes cm-dot-pop {
          from { transform: scale(0); opacity: 0; }
          to   { transform: scale(1); opacity: 0.8; }
        }
      `}</style>
    </div>
  );
}
