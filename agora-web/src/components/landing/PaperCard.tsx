import { useState } from 'react';
import { ExternalLink, ChevronDown } from 'lucide-react';

interface PaperCardProps {
  authors: string;
  year: number;
  title: string;
  venue: string;
  claim: string;
  keyInsight: string;
  agoraUse: string;
  paperUrl?: string;
}

interface PaperSectionProps {
  papers: PaperCardProps[];
}

function PaperCard({
  paper,
  isOpen,
  onToggle,
}: {
  paper: PaperCardProps;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="rounded-xl overflow-hidden cursor-pointer group"
      style={{
        background: 'var(--bg-elevated)',
        border: `1px solid ${isOpen ? 'var(--border-accent)' : 'var(--border-muted)'}`,
        transition: 'border-color 0.3s ease',
      }}
      onClick={onToggle}
    >
      {/* Compact header — always visible */}
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="mono text-text-muted mb-1" style={{ fontSize: '10px', letterSpacing: '0.06em' }}>
              {paper.authors} · {paper.year}
            </div>
            <h6
              className="font-semibold leading-snug mb-1 group-hover:text-accent transition-colors duration-200"
              style={{ fontSize: '13px', textTransform: 'none', letterSpacing: '-0.01em' }}
            >
              {paper.title}
            </h6>
            <div className="badge" style={{ fontSize: '9px' }}>{paper.venue}</div>
          </div>
          <ChevronDown
            size={14}
            className="text-text-muted mt-1 flex-shrink-0 transition-transform duration-300"
            style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
          />
        </div>

        <div
          className="text-text-secondary mt-3 leading-relaxed"
          style={{ fontSize: '12px' }}
        >
          {paper.claim}
        </div>
      </div>

      {/* Expandable detail panel */}
      <div
        style={{
          maxHeight: isOpen ? '400px' : '0px',
          overflow: 'hidden',
          transition: 'max-height 0.35s ease',
        }}
      >
        <div
          style={{
            borderTop: '1px solid var(--border-subtle)',
            opacity: isOpen ? 1 : 0,
            transition: 'opacity 0.2s ease 0.15s',
          }}
        >
          <div className="p-5 flex flex-col gap-4">
            {/* Key Insight */}
            <div>
              <div className="mono text-accent mb-2" style={{ fontSize: '9px', letterSpacing: '0.1em', fontWeight: 700 }}>
                KEY INSIGHT
              </div>
              <p className="text-text-secondary leading-relaxed" style={{ fontSize: '12px' }}>
                {paper.keyInsight}
              </p>
            </div>

            {/* How Agora Uses This */}
            <div>
              <div className="mono text-accent mb-2" style={{ fontSize: '9px', letterSpacing: '0.1em', fontWeight: 700 }}>
                HOW AGORA USES THIS
              </div>
              <p className="text-text-secondary leading-relaxed" style={{ fontSize: '12px' }}>
                {paper.agoraUse}
              </p>
            </div>

            {/* Link */}
            {paper.paperUrl && (
              <a
                href={paper.paperUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-2 text-accent hover:text-accent-hover transition-colors"
                style={{ fontSize: '11px', fontFamily: "'Roboto Mono', monospace" }}
              >
                Read Paper <ExternalLink size={11} />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PaperSection({ papers }: PaperSectionProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const toggle = (i: number) => {
    setActiveIndex((prev) => (prev === i ? null : i));
  };

  return (
    <div className="flex flex-col gap-4 w-full">
      {papers.map((paper, i) => (
        <PaperCard
          key={i}
          paper={paper}
          isOpen={activeIndex === i}
          onToggle={() => toggle(i)}
        />
      ))}
    </div>
  );
}

// Re-export the type for use in Login.tsx
export type { PaperCardProps };
