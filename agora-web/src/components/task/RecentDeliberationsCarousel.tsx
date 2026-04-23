import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, ChevronRight, X, ArrowRight, Search } from 'lucide-react';
import type { TaskStatusResponse } from '../../lib/api';

// ─── Keyframes injected once ──────────────────────────────────────────────────
const STYLE_ID = 'carousel-skeleton-keyframes';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes sk-shimmer {
      0%   { background-position: -600px 0; }
      100% { background-position: 600px 0; }
    }
    @keyframes sk-fade {
      0%, 100% { opacity: 0.6; }
      50%       { opacity: 0.25; }
    }
  `;
  document.head.appendChild(s);
}

// ─── Status helpers ───────────────────────────────────────────────────────────
function statusColor(status: TaskStatusResponse['status']): string {
  if (status === 'completed' || status === 'paid') return 'var(--accent-emerald)';
  if (status === 'failed') return '#f87171';
  return 'var(--text-tertiary)';
}

// ─── Skeleton card ────────────────────────────────────────────────────────────
function SkeletonCard({ delay = 0 }: { delay?: number }) {
  const shimmer: React.CSSProperties = {
    background:
      'linear-gradient(90deg, var(--bg-base) 0%, var(--border-strong) 40%, var(--bg-base) 80%)',
    backgroundSize: '600px 100%',
    animation: `sk-shimmer 1.8s ease-in-out infinite`,
    animationDelay: `${delay}ms`,
    borderRadius: '6px',
  };

  return (
    <div
      style={{
        flexShrink: 0,
        width: '220px',
        padding: '16px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        borderRadius: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        animation: `sk-fade 2.4s ease-in-out infinite`,
        animationDelay: `${delay}ms`,
      }}
    >
      {/* Icon placeholder */}
      <div style={{ ...shimmer, width: '14px', height: '14px', borderRadius: '50%' }} />
      {/* Text lines */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 }}>
        <div style={{ ...shimmer, height: '11px', width: '92%' }} />
        <div style={{ ...shimmer, height: '11px', width: '76%' }} />
        <div style={{ ...shimmer, height: '11px', width: '58%' }} />
      </div>
      {/* Footer */}
      <div
        style={{
          display: 'flex',
          gap: '8px',
          paddingTop: '8px',
          borderTop: '1px solid var(--border-default)',
        }}
      >
        <div style={{ ...shimmer, height: '10px', width: '40px' }} />
        <div style={{ ...shimmer, height: '10px', width: '50px', marginLeft: 'auto' }} />
      </div>
    </div>
  );
}

// ─── Compact task card ────────────────────────────────────────────────────────
interface CardProps {
  task: TaskStatusResponse;
  isExample?: boolean;
  onExampleClick?: () => void;
}

function DeliberationCard({ task, isExample = false, onExampleClick }: CardProps) {
  const navigate = useNavigate();
  const color = statusColor(task.status);

  const handleClick = () => {
    if (isExample) onExampleClick?.();
    else navigate(`/task/${task.task_id}`);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      style={{
        flexShrink: 0,
        width: '220px',
        padding: '16px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        borderRadius: '12px',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        transition: 'border-color 0.15s ease, background 0.15s ease',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent-emerald)';
        (e.currentTarget as HTMLButtonElement).style.background =
          'var(--bg-card-hover, var(--bg-base))';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-default)';
        (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)';
      }}
    >
      <div style={{ color: 'var(--accent-emerald)' }}>
        <Play size={14} strokeWidth={2} />
      </div>

      <p
        style={{
          margin: 0,
          fontSize: '13px',
          fontFamily: "'Commit Mono', monospace",
          color: 'var(--text-primary)',
          lineHeight: '1.5',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          flex: 1,
        }}
      >
        {task.task_text}
      </p>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          paddingTop: '8px',
          borderTop: '1px solid var(--border-default)',
        }}
      >
        <span
          style={{
            fontSize: '9px',
            fontFamily: "'Commit Mono', monospace",
            color: isExample ? 'var(--text-tertiary)' : color,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            fontWeight: 600,
          }}
        >
          {isExample ? 'example' : task.mechanism?.toUpperCase()}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '9px',
            color: 'var(--text-tertiary)',
            fontFamily: "'Commit Mono', monospace",
          }}
        >
          {isExample ? 'try it' : task.status}
        </span>
      </div>
    </button>
  );
}

// ─── All-tasks modal ──────────────────────────────────────────────────────────
interface AllTasksModalProps {
  tasks: TaskStatusResponse[];
  onClose: () => void;
}

function AllTasksModal({ tasks, onClose }: AllTasksModalProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const filtered = query.trim()
    ? tasks.filter((t) =>
        t.task_text.toLowerCase().includes(query.toLowerCase()) ||
        t.mechanism?.toLowerCase().includes(query.toLowerCase()) ||
        t.status.toLowerCase().includes(query.toLowerCase()),
      )
    : tasks;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(6px)',
          zIndex: 1000,
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="All deliberations"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(660px, calc(100vw - 32px))',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: '18px',
          boxShadow: '0 28px 72px rgba(0,0,0,0.45)',
          zIndex: 1001,
          overflow: 'hidden',
        }}
      >
        {/* ── Hero area ── */}
        <div
          style={{
            padding: '28px 28px 20px',
            background:
              'linear-gradient(135deg, rgba(34,211,138,0.06) 0%, transparent 60%)',
            borderBottom: '1px solid var(--border-default)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: '18px',
                  fontFamily: "'Commit Mono', monospace",
                  fontWeight: 800,
                  color: 'var(--text-primary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: '6px',
                }}
              >
                All Deliberations
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: '12px',
                  fontFamily: "'Commit Mono', monospace",
                  color: 'var(--text-tertiary)',
                  lineHeight: '1.5',
                  maxWidth: '400px',
                }}
              >
                Every task your agents have reasoned over — complete with mechanism routing,
                quorum results, and on-chain receipts.
              </p>
            </div>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-tertiary)',
                display: 'flex',
                alignItems: 'center',
                padding: '4px',
                flexShrink: 0,
              }}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          {/* ── Search bar ── */}
          <div
            style={{
              marginTop: '18px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              background: 'var(--bg-base)',
              border: '1px solid var(--border-default)',
              borderRadius: '10px',
              padding: '9px 14px',
            }}
          >
            <Search size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by task, mechanism, or status…"
              autoFocus
              style={{
                flex: 1,
                background: 'none',
                border: 'none',
                outline: 'none',
                fontFamily: "'Commit Mono', monospace",
                fontSize: '12px',
                color: 'var(--text-primary)',
              }}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-tertiary)',
                  display: 'flex',
                  alignItems: 'center',
                  padding: 0,
                  flexShrink: 0,
                }}
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Result count */}
          <div
            style={{
              marginTop: '8px',
              fontSize: '10px',
              fontFamily: "'Commit Mono', monospace",
              color: 'var(--text-tertiary)',
            }}
          >
            {filtered.length} task{filtered.length !== 1 ? 's' : ''}
            {query ? ` matching "${query}"` : ' total'}
          </div>
        </div>

        {/* ── Task list ── */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {filtered.length === 0 ? (
            <div
              style={{
                padding: '48px 28px',
                textAlign: 'center',
                color: 'var(--text-tertiary)',
                fontFamily: "'Commit Mono', monospace",
                fontSize: '12px',
              }}
            >
              {query ? `No results for "${query}"` : 'No deliberations yet.'}
            </div>
          ) : (
            filtered.map((task) => (
              <button
                key={task.task_id}
                type="button"
                onClick={() => {
                  onClose();
                  navigate(`/task/${task.task_id}`);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '14px',
                  width: '100%',
                  padding: '14px 28px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  borderBottom: '1px solid var(--border-default)',
                  transition: 'background 0.12s ease',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-base)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'none';
                }}
              >
                <div
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: statusColor(task.status),
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: '13px',
                      fontFamily: "'Commit Mono', monospace",
                      color: 'var(--text-primary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {task.task_text}
                  </div>
                  <div
                    style={{
                      fontSize: '10px',
                      color: 'var(--text-tertiary)',
                      fontFamily: "'Commit Mono', monospace",
                      marginTop: '2px',
                    }}
                  >
                    {task.mechanism?.toUpperCase()} · {task.status} ·{' '}
                    {new Date(task.created_at).toLocaleDateString()}
                  </div>
                </div>
                <ArrowRight size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              </button>
            ))
          )}
        </div>
      </div>
    </>
  );
}

// ─── Main carousel ────────────────────────────────────────────────────────────
interface RecentDeliberationsCarouselProps {
  tasks: TaskStatusResponse[];
  exampleTasks: TaskStatusResponse[];
  isLoading: boolean;
  onExampleSelect: (text: string) => void;
}

export function RecentDeliberationsCarousel({
  tasks,
  exampleTasks,
  isLoading,
  onExampleSelect,
}: RecentDeliberationsCarouselProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(false);

  const hasRealTasks = tasks.length > 0;

  return (
    <div style={{ marginTop: '48px' }}>
      {/* Section header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: '16px',
        }}
      >
        <div
          style={{
            fontSize: '11px',
            fontFamily: "'Commit Mono', monospace",
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontWeight: 600,
          }}
        >
          Recent Deliberations
        </div>
        {hasRealTasks && !isLoading && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '11px',
              fontFamily: "'Commit Mono', monospace",
              color: 'var(--accent-emerald)',
              padding: 0,
            }}
          >
            See all <ChevronRight size={12} />
          </button>
        )}
      </div>

      {/* Carousel or skeleton */}
      <div style={{ position: 'relative' }}>
        <div
          ref={scrollRef}
          style={{
            display: 'flex',
            gap: '12px',
            overflowX: 'auto',
            paddingBottom: '8px',
            scrollbarWidth: 'none',
            maskImage:
              'linear-gradient(to right, black 0%, black 80%, transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(to right, black 0%, black 80%, transparent 100%)',
          }}
        >
          {isLoading ? (
            // ── Skeleton state: staggered wave ──
            <>
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonCard key={i} delay={i * 120} />
              ))}
            </>
          ) : hasRealTasks ? (
            // ── Real tasks ──
            <>
              {tasks.map((task) => (
                <DeliberationCard key={task.task_id} task={task} />
              ))}
            </>
          ) : (
            // ── New user: example tasks ──
            <>
              {exampleTasks.map((task) => (
                <DeliberationCard
                  key={task.task_id}
                  task={task}
                  isExample
                  onExampleClick={() => onExampleSelect(task.task_text)}
                />
              ))}
            </>
          )}

          {/* Trailing spacer */}
          <div style={{ flexShrink: 0, width: '64px' }} />
        </div>
      </div>

      {/* All tasks modal */}
      {showAll && (
        <AllTasksModal tasks={tasks} onClose={() => setShowAll(false)} />
      )}
    </div>
  );
}
