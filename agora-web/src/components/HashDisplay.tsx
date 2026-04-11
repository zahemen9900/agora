import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export function HashDisplay({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="inline-flex items-center gap-2 bg-elevated border border-border-muted rounded-md px-3 py-1">
      <span className="mono text-text-primary text-[0.85rem]">{hash}</span>
      <button 
        onClick={handleCopy}
        className={`p-1 flex items-center justify-center rounded transition-colors ${copied ? 'text-accent' : 'text-text-muted hover:bg-border-subtle'}`}
        title="Copy Hash"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}
