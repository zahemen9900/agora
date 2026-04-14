interface MerkleTreeProps {
  rootHash: string | null;
  leaves: string[];
}

export function MerkleTree({ rootHash, leaves }: MerkleTreeProps) {
  return (
    <div className="card p-4 md:p-8 overflow-x-auto bg-void w-full">
      <div className="mono text-text-muted text-sm mb-8">TRANSCRIPT VERIFICATION TREE</div>

      <div className="mb-6">
        <div className="mono text-xs text-text-muted mb-2">ROOT</div>
        <div className="badge py-2 px-4 bg-elevated border border-accent">
          {rootHash ? `${rootHash.slice(0, 20)}...` : "Unavailable"}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {leaves.map((leaf, index) => (
          <div
            key={`${leaf}-${index}`}
            className="card p-3 text-left border-border-subtle bg-surface"
          >
            <div className="mono text-xs mb-2 text-accent">LEAF {index + 1}</div>
            <div className="mono text-xs text-text-muted break-all">{leaf}</div>
          </div>
        ))}
      </div>

      {leaves.length === 0 && (
        <p className="text-sm text-text-muted">Transcript hashes will appear once the task completes.</p>
      )}
    </div>
  );
}
