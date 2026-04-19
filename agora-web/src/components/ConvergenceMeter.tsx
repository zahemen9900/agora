import { Info } from "lucide-react";

interface ConvergenceMeterProps {
  entropy: number; // 0.0 to 1.0
  novelty: number; // 0.0 to 1.0
  lockedClaims: number;
  prevEntropy?: number;
}

export function ConvergenceMeter({ entropy, novelty, lockedClaims, prevEntropy = 1.0 }: ConvergenceMeterProps) {
  // Determine if it's improving (declining entropy)
  const isImproving = entropy <= prevEntropy;
  
  return (
    <div className="card p-6 w-full mb-6">
      <div className="l-corners" />
      <div className="mono text-muted text-sm mb-4 flex items-center gap-2">
        CONVERGENCE <Info size={14} />
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div>
          <div className="flex justify-between mb-2 text-sm">
            <span>Disagreement Entropy</span>
            <span className="mono" style={{ color: isImproving ? 'var(--color-accent)' : 'var(--color-warning)' }}>
              {prevEntropy.toFixed(2)} &rarr; {entropy.toFixed(2)}
            </span>
          </div>
          <div className="h-2 bg-elevated rounded-full overflow-hidden">
            <div 
              className="h-full transition-all duration-500 ease-out"
              style={{ 
                width: `${entropy * 100}%`, 
                backgroundColor: isImproving ? 'var(--color-accent)' : 'var(--color-warning)'
              }} 
            />
          </div>
          <div className="text-xs text-text-muted mt-2 text-right">
            {isImproving ? '(declining)' : '(rising)'}
          </div>
        </div>
        
        <div className="flex flex-col justify-center">
          <div className="flex justify-between mb-2 text-sm">
            <span>Novelty / JS Divergence</span>
            <span className="mono">{novelty.toFixed(2)}</span>
          </div>
          <div className="flex justify-between mt-4 text-sm">
            <span>Locked Claims</span>
            <span className={`mono ${lockedClaims > 0 ? 'text-accent' : 'text-text-secondary'}`}>
              {lockedClaims} verified
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
