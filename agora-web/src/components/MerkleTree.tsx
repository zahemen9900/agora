import { useState } from 'react';

// For this mock, we render a static tree structure with hover states
export function MerkleTree() {
  const [hoverPath, setHoverPath] = useState<string | null>(null);

  const leaves = [
    { id: 'L1', text: 'Arg1: A monolith is the right call...', hash: '0x1a2b...3c4d' },
    { id: 'L2', text: 'Arg2: Microservices allow independent...', hash: '0x5e6f...7g8h' },
    { id: 'L3', text: 'Arg3: Agent-2, you are assuming...', hash: '0x9i0j...1k2l' },
    { id: 'L4', text: 'Vote1: Monolith (87% confidence)', hash: '0x3m4n...5o6p' }
  ];

  const getStrokeColor = (targetLeafId: string) => {
    return hoverPath === targetLeafId ? 'var(--color-accent)' : 'var(--color-border-muted)';
  };

  const getTextColor = (targetLeafId: string) => {
    return hoverPath === targetLeafId ? 'text-accent' : 'text-text-muted';
  };

  return (
    <div className="card p-4 md:p-8 overflow-x-auto bg-void w-full">
      <div className="mono text-text-muted text-sm mb-8">
        TRANSCRIPT VERIFICATION TREE
      </div>
      
      <div className="min-w-[600px] flex flex-col items-center">
        
        {/* ROOT */}
        <div className="flex flex-col items-center">
          <div className="badge py-2 px-4 bg-elevated border border-accent">
            ROOT (0x7a3f...e8b2)
          </div>
          
          {/* SVG Connectors: Root to Internal Nodes */}
          <svg width="200" height="40" className="my-2">
            {/* To Left Internal */}
            <path d="M 100 0 C 100 20 20 20 20 40" fill="none" stroke={hoverPath === 'L1' || hoverPath === 'L2' ? 'var(--color-accent)' : 'var(--color-border-muted)'} strokeWidth="2" />
            {/* To Right Internal */}
            <path d="M 100 0 C 100 20 180 20 180 40" fill="none" stroke={hoverPath === 'L3' || hoverPath === 'L4' ? 'var(--color-accent)' : 'var(--color-border-muted)'} strokeWidth="2" />
          </svg>
        </div>

        {/* INTERNAL NODES */}
        <div className="flex w-[400px] justify-between">
          <div className={`mono text-xs ${hoverPath === 'L1' || hoverPath === 'L2' ? 'text-accent' : 'text-text-secondary'}`}>H12</div>
          <div className={`mono text-xs ${hoverPath === 'L3' || hoverPath === 'L4' ? 'text-accent' : 'text-text-secondary'}`}>H34</div>
        </div>

        {/* SVG Connectors: Internal to Leaves */}
        <div className="flex w-[400px] justify-between">
           <svg width="100" height="40" className="my-2">
             <path d="M 50 0 C 50 20 10 20 10 40" fill="none" stroke={getStrokeColor('L1')} strokeWidth="2" />
             <path d="M 50 0 C 50 20 90 20 90 40" fill="none" stroke={getStrokeColor('L2')} strokeWidth="2" />
           </svg>
           <svg width="100" height="40" className="my-2">
             <path d="M 50 0 C 50 20 10 20 10 40" fill="none" stroke={getStrokeColor('L3')} strokeWidth="2" />
             <path d="M 50 0 C 50 20 90 20 90 40" fill="none" stroke={getStrokeColor('L4')} strokeWidth="2" />
           </svg>
        </div>

        {/* LEAVES */}
        <div className="grid grid-cols-4 gap-4 w-full mt-2">
          {leaves.map((leaf) => (
            <div 
              key={leaf.id}
              onMouseEnter={() => setHoverPath(leaf.id)}
              onMouseLeave={() => setHoverPath(null)}
              className={`card p-3 text-center cursor-pointer transition-colors ${hoverPath === leaf.id ? 'border-accent' : 'border-border-subtle'}`}
            >
              <div className={`mono text-xs mb-2 ${getTextColor(leaf.id)}`}>
                {leaf.hash}
              </div>
              <div className="text-xs text-text-secondary line-clamp-2">
                {leaf.text}
              </div>
            </div>
          ))}
        </div>
        
      </div>
      
      <p className="text-center text-sm text-text-muted mt-8">
        Hover a leaf block to trace its cryptographic path to the root hash committed on Solana.
      </p>

    </div>
  );
}
