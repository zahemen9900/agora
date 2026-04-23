import { useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Copy,
  KeyRound,
  Search,
  ShieldX,
  X,
} from 'lucide-react';
import type { ApiKeyMetadataResponse } from '../../lib/api';

// ─── Keyframe injection (same guard as RecentDeliberationsCarousel) ───────────
const STYLE_ID = 'carousel-skeleton-keyframes';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes sk-shimmer {
      0%   { background-position: -600px 0; }
      100% { background-position:  600px 0; }
    }
    @keyframes sk-fade {
      0%, 100% { opacity: 0.6; }
      50%       { opacity: 0.25; }
    }
  `;
  document.head.appendChild(s);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isRevoked(key: ApiKeyMetadataResponse) {
  return Boolean(key.revoked_at);
}

function relativeTime(isoString: string | null): string {
  if (!isoString) return 'never';
  const ms = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString();
}

function scopeColor(scope: string): { bg: string; text: string } {
  if (scope.startsWith('tasks:')) return { bg: 'var(--accent-emerald-soft)', text: 'var(--accent-emerald)' };
  return { bg: 'var(--accent-amber-soft)', text: 'var(--accent-amber)' };
}

// ─── Skeleton card ────────────────────────────────────────────────────────────
function SkeletonCard({ delay = 0 }: { delay?: number }) {
  const shimmer: React.CSSProperties = {
    background: 'linear-gradient(90deg, var(--bg-base) 0%, var(--border-strong) 40%, var(--bg-base) 80%)',
    backgroundSize: '600px 100%',
    animation: `sk-shimmer 1.8s ease-in-out infinite`,
    animationDelay: `${delay}ms`,
    borderRadius: '6px',
  };
  return (
    <div style={{
      flexShrink: 0, width: '220px', padding: '16px',
      background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
      borderRadius: '12px', display: 'flex', flexDirection: 'column', gap: '12px',
      animation: `sk-fade 2.4s ease-in-out infinite`, animationDelay: `${delay}ms`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ ...shimmer, width: '14px', height: '14px', borderRadius: '50%' }} />
        <div style={{ ...shimmer, width: '46px', height: '16px', borderRadius: '9999px' }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 }}>
        <div style={{ ...shimmer, height: '11px', width: '80%' }} />
        <div style={{ ...shimmer, height: '11px', width: '55%' }} />
      </div>
      <div style={{ paddingTop: '8px', borderTop: '1px solid var(--border-default)', display: 'flex', gap: '8px' }}>
        <div style={{ ...shimmer, height: '10px', width: '50px' }} />
        <div style={{ ...shimmer, height: '10px', width: '36px', marginLeft: 'auto' }} />
      </div>
    </div>
  );
}

// ─── Carousel card ────────────────────────────────────────────────────────────
interface ApiKeyCardProps {
  apiKey: ApiKeyMetadataResponse;
  onClick: () => void;
}

function ApiKeyCard({ apiKey, onClick }: ApiKeyCardProps) {
  const revoked = isRevoked(apiKey);
  const statusColor = revoked ? 'var(--accent-rose)' : 'var(--accent-emerald)';
  const statusBg   = revoked ? 'var(--accent-rose-soft)' : 'var(--accent-emerald-soft)';

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flexShrink: 0, width: '220px', padding: '16px',
        background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
        borderRadius: '12px', textAlign: 'left', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: '10px',
        transition: 'border-color 0.15s ease, background 0.15s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--accent-emerald)';
        e.currentTarget.style.background = 'var(--bg-base)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-default)';
        e.currentTarget.style.background = 'var(--bg-elevated)';
      }}
    >
      {/* Top row: icon + status badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <KeyRound size={13} style={{ color: revoked ? 'var(--text-tertiary)' : 'var(--accent-emerald)' }} />
        <span style={{
          fontSize: '9px', fontFamily: "'Commit Mono', monospace", fontWeight: 600,
          letterSpacing: '0.07em', textTransform: 'uppercase',
          color: statusColor, background: statusBg,
          border: `1px solid ${statusColor}33`,
          borderRadius: '9999px', padding: '2px 8px',
        }}>
          {revoked ? 'revoked' : 'active'}
        </span>
      </div>

      {/* Name */}
      <p style={{
        margin: 0, fontSize: '13px', fontFamily: "'Commit Mono', monospace",
        fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {apiKey.name}
      </p>

      {/* Public ID */}
      <p style={{
        margin: 0, fontSize: '10px', fontFamily: "'Commit Mono', monospace",
        color: 'var(--text-tertiary)', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {apiKey.public_id}
      </p>

      {/* Footer */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        paddingTop: '8px', borderTop: '1px solid var(--border-default)',
      }}>
        <span style={{
          fontSize: '9px', fontFamily: "'Commit Mono', monospace",
          color: 'var(--text-tertiary)', flex: 1,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {apiKey.scopes.length} scope{apiKey.scopes.length !== 1 ? 's' : ''}
        </span>
        <span style={{
          fontSize: '9px', fontFamily: "'Commit Mono', monospace",
          color: 'var(--text-tertiary)',
        }}>
          {relativeTime(apiKey.created_at)}
        </span>
      </div>
    </button>
  );
}

// ─── Shared key detail body ───────────────────────────────────────────────────
// Used by both ApiKeyDetailModal and AllKeysModal detail view.
interface KeyDetailBodyProps {
  apiKey: ApiKeyMetadataResponse;
  onRevoke: (id: string) => Promise<void>;
  /** Called after a successful revoke so parent can close/reset */
  onAfterRevoke: () => void;
}

function KeyDetailBody({ apiKey, onRevoke, onAfterRevoke }: KeyDetailBodyProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const revoked = isRevoked(apiKey);

  async function handleRevoke() {
    setRevoking(true);
    try {
      await onRevoke(apiKey.key_id);
      onAfterRevoke();
    } finally {
      setRevoking(false);
      setConfirmRevoke(false);
    }
  }

  function copyId() {
    void navigator.clipboard.writeText(apiKey.public_id);
    setCopyState('copied');
    setTimeout(() => setCopyState('idle'), 1400);
  }

  const row = (label: string, value: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
      <span style={{ fontSize: '11px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-tertiary)' }}>
        {label}
      </span>
      <span style={{ fontSize: '11px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-secondary)', textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', padding: '24px 28px' }}>

      {/* ── Identity ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ fontSize: '10px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-tertiary)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Identity
        </div>

        {/* Public ID row with copy */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          background: 'var(--bg-base)', border: '1px solid var(--border-default)',
          borderRadius: '8px', padding: '10px 14px',
        }}>
          <span style={{ flex: 1, fontSize: '12px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {apiKey.public_id}
          </span>
          <button
            type="button"
            onClick={copyId}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: copyState === 'copied' ? 'var(--accent-emerald)' : 'var(--text-tertiary)', display: 'flex', padding: '2px', transition: 'color 0.15s ease', flexShrink: 0 }}
            aria-label="Copy public ID"
          >
            {copyState === 'copied' ? <CheckCircle2 size={14} /> : <Copy size={14} />}
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {row('Created', new Date(apiKey.created_at).toLocaleString())}
          {row('Last used', apiKey.last_used_at ? new Date(apiKey.last_used_at).toLocaleString() : 'Never')}
          {row('Expires', apiKey.expires_at ? new Date(apiKey.expires_at).toLocaleString() : 'Never')}
        </div>
      </div>

      {/* ── Scopes ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ fontSize: '10px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-tertiary)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Privileges
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {apiKey.scopes.map((scope) => {
            const { bg, text } = scopeColor(scope);
            return (
              <span key={scope} style={{
                fontSize: '11px', fontFamily: "'Commit Mono', monospace", fontWeight: 500,
                letterSpacing: '0.04em', color: text, background: bg,
                border: `1px solid ${text}33`, borderRadius: '9999px', padding: '4px 12px',
              }}>
                {scope}
              </span>
            );
          })}
        </div>
      </div>

      {/* ── Danger zone ── */}
      <div style={{
        borderTop: '1px solid var(--border-default)', paddingTop: '20px',
        display: 'flex', flexDirection: 'column', gap: '12px',
      }}>
        <div style={{ fontSize: '10px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-tertiary)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Danger Zone
        </div>
        {revoked ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-tertiary)' }}>
            <ShieldX size={14} />
            Revoked · {new Date(apiKey.revoked_at!).toLocaleString()}
          </div>
        ) : confirmRevoke ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-secondary)' }}>
              Revoke this key permanently?
            </span>
            <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}>
              <button
                type="button"
                onClick={() => setConfirmRevoke(false)}
                style={{
                  fontSize: '12px', fontFamily: "'Commit Mono', monospace", padding: '6px 14px',
                  background: 'none', border: '1px solid var(--border-strong)', borderRadius: '8px',
                  color: 'var(--text-secondary)', cursor: 'pointer', transition: 'background 0.12s ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-subtle)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleRevoke()}
                disabled={revoking}
                style={{
                  fontSize: '12px', fontFamily: "'Commit Mono', monospace", padding: '6px 14px',
                  background: 'var(--accent-rose-soft)', border: '1px solid var(--accent-rose)',
                  borderRadius: '8px', color: 'var(--accent-rose)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: '6px',
                  transition: 'opacity 0.12s ease', opacity: revoking ? 0.6 : 1,
                }}
              >
                <ShieldX size={13} />
                {revoking ? 'Revoking…' : 'Confirm revoke'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmRevoke(true)}
            style={{
              alignSelf: 'flex-start', fontSize: '12px', fontFamily: "'Commit Mono', monospace",
              padding: '7px 16px', background: 'none',
              border: '1px solid var(--border-strong)', borderRadius: '8px',
              color: 'var(--text-secondary)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '6px',
              transition: 'border-color 0.12s ease, color 0.12s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent-rose)';
              e.currentTarget.style.color = 'var(--accent-rose)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-strong)';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            <ShieldX size={14} />
            Revoke key
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Card-click detail modal ──────────────────────────────────────────────────
interface ApiKeyDetailModalProps {
  apiKey: ApiKeyMetadataResponse;
  onClose: () => void;
  onRevoke: (id: string) => Promise<void>;
}

function ApiKeyDetailModal({ apiKey, onClose, onRevoke }: ApiKeyDetailModalProps) {
  const revoked = isRevoked(apiKey);
  const statusColor = revoked ? 'var(--accent-rose)' : 'var(--accent-emerald)';
  const statusBg   = revoked ? 'var(--accent-rose-soft)' : 'var(--accent-emerald-soft)';

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
          zIndex: 1000,
        }}
      />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`API key details: ${apiKey.name}`}
        style={{
          position: 'fixed', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(520px, calc(100vw - 32px))',
          maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: '18px',
          boxShadow: '0 28px 72px rgba(0,0,0,0.45)',
          zIndex: 1001, overflow: 'hidden',
        }}
      >
        {/* Hero header */}
        <div style={{
          padding: '24px 28px 20px',
          background: 'linear-gradient(135deg, rgba(34,211,138,0.06) 0%, transparent 60%)',
          borderBottom: '1px solid var(--border-default)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
              <KeyRound size={16} style={{ color: revoked ? 'var(--text-tertiary)' : 'var(--accent-emerald)', flexShrink: 0 }} />
              <span style={{
                fontSize: '16px', fontFamily: "'Commit Mono', monospace", fontWeight: 700,
                color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.04em',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {apiKey.name}
              </span>
              <span style={{
                fontSize: '9px', fontFamily: "'Commit Mono', monospace", fontWeight: 600,
                letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0,
                color: statusColor, background: statusBg,
                border: `1px solid ${statusColor}33`,
                borderRadius: '9999px', padding: '3px 9px',
              }}>
                {revoked ? 'revoked' : 'active'}
              </span>
            </div>
            <button
              onClick={onClose}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', display: 'flex', padding: '4px', flexShrink: 0 }}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          <KeyDetailBody
            apiKey={apiKey}
            onRevoke={onRevoke}
            onAfterRevoke={onClose}
          />
        </div>
      </div>
    </>
  );
}

// ─── All-keys modal ───────────────────────────────────────────────────────────
interface AllKeysModalProps {
  keys: ApiKeyMetadataResponse[];
  onClose: () => void;
  onRevoke: (id: string) => Promise<void>;
}

function AllKeysModal({ keys, onClose, onRevoke }: AllKeysModalProps) {
  const [query, setQuery] = useState('');
  const [detailKey, setDetailKey] = useState<ApiKeyMetadataResponse | null>(null);

  const filtered = query.trim()
    ? keys.filter((k) =>
        k.name.toLowerCase().includes(query.toLowerCase()) ||
        k.public_id.toLowerCase().includes(query.toLowerCase()) ||
        k.scopes.some((s) => s.includes(query.toLowerCase())) ||
        (isRevoked(k) ? 'revoked' : 'active').includes(query.toLowerCase()),
      )
    : keys;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
          zIndex: 1000,
        }}
      />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="All API keys"
        style={{
          position: 'fixed', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(640px, calc(100vw - 32px))',
          maxHeight: '82vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: '18px',
          boxShadow: '0 28px 72px rgba(0,0,0,0.45)',
          zIndex: 1001, overflow: 'hidden',
        }}
      >
        {detailKey === null ? (
          /* ── View A: key list ── */
          <>
            <div style={{
              padding: '28px 28px 20px',
              background: 'linear-gradient(135deg, rgba(34,211,138,0.06) 0%, transparent 60%)',
              borderBottom: '1px solid var(--border-default)', flexShrink: 0,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: '18px', fontFamily: "'Commit Mono', monospace", fontWeight: 800, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
                    All API Keys
                  </div>
                  <p style={{ margin: 0, fontSize: '12px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-tertiary)', lineHeight: 1.5, maxWidth: '380px' }}>
                    Workspace-scoped credentials. Click a key to inspect its privileges or revoke it.
                  </p>
                </div>
                <button
                  onClick={onClose}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', display: 'flex', padding: '4px', flexShrink: 0 }}
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Search */}
              <div style={{
                marginTop: '18px', display: 'flex', alignItems: 'center', gap: '10px',
                background: 'var(--bg-base)', border: '1px solid var(--border-default)',
                borderRadius: '10px', padding: '9px 14px',
              }}>
                <Search size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, ID, scope, or status…"
                  autoFocus
                  style={{ flex: 1, background: 'none', border: 'none', outline: 'none', fontFamily: "'Commit Mono', monospace", fontSize: '12px', color: 'var(--text-primary)' }}
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', display: 'flex', padding: 0, flexShrink: 0 }}
                    aria-label="Clear"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <div style={{ marginTop: '8px', fontSize: '10px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-tertiary)' }}>
                {filtered.length} key{filtered.length !== 1 ? 's' : ''}
                {query ? ` matching "${query}"` : ' total'}
              </div>
            </div>

            {/* List */}
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {filtered.length === 0 ? (
                <div style={{ padding: '48px 28px', textAlign: 'center', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace", fontSize: '12px' }}>
                  {query ? `No results for "${query}"` : 'No API keys yet.'}
                </div>
              ) : filtered.map((key) => {
                const revoked = isRevoked(key);
                const dotColor = revoked ? 'var(--accent-rose)' : 'var(--accent-emerald)';
                const statusColor = revoked ? 'var(--accent-rose)' : 'var(--accent-emerald)';
                const statusBg   = revoked ? 'var(--accent-rose-soft)' : 'var(--accent-emerald-soft)';
                return (
                  <button
                    key={key.key_id}
                    type="button"
                    onClick={() => setDetailKey(key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '14px',
                      width: '100%', padding: '14px 28px',
                      background: 'none', border: 'none', cursor: 'pointer',
                      textAlign: 'left', borderBottom: '1px solid var(--border-default)',
                      transition: 'background 0.12s ease',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-base)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                  >
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                        <span style={{ fontSize: '13px', fontFamily: "'Commit Mono', monospace", fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {key.name}
                        </span>
                        <span style={{
                          fontSize: '8px', fontFamily: "'Commit Mono', monospace", fontWeight: 600,
                          letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0,
                          color: statusColor, background: statusBg,
                          border: `1px solid ${statusColor}33`,
                          borderRadius: '9999px', padding: '2px 7px',
                        }}>
                          {revoked ? 'revoked' : 'active'}
                        </span>
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace" }}>
                        {key.public_id} · {new Date(key.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <ChevronRight size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          /* ── View B: key detail with back button ── */
          <>
            <div style={{
              padding: '20px 28px 18px',
              background: 'linear-gradient(135deg, rgba(34,211,138,0.06) 0%, transparent 60%)',
              borderBottom: '1px solid var(--border-default)', flexShrink: 0,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                  {/* Back button */}
                  <button
                    type="button"
                    onClick={() => setDetailKey(null)}
                    style={{
                      background: 'none', border: '1px solid var(--border-default)',
                      borderRadius: '8px', cursor: 'pointer', color: 'var(--text-secondary)',
                      display: 'flex', alignItems: 'center', gap: '5px',
                      padding: '5px 10px', fontSize: '11px',
                      fontFamily: "'Commit Mono', monospace",
                      transition: 'border-color 0.12s ease, color 0.12s ease', flexShrink: 0,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = 'var(--accent-emerald)';
                      e.currentTarget.style.color = 'var(--accent-emerald)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = 'var(--border-default)';
                      e.currentTarget.style.color = 'var(--text-secondary)';
                    }}
                    aria-label="Back to all keys"
                  >
                    <ArrowLeft size={12} /> Back
                  </button>

                  {/* Key name + status */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                    <span style={{ fontSize: '15px', fontFamily: "'Commit Mono', monospace", fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {detailKey.name}
                    </span>
                    {(() => {
                      const rev = isRevoked(detailKey);
                      const sc = rev ? 'var(--accent-rose)' : 'var(--accent-emerald)';
                      const sb = rev ? 'var(--accent-rose-soft)' : 'var(--accent-emerald-soft)';
                      return (
                        <span style={{ fontSize: '8px', fontFamily: "'Commit Mono', monospace", fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0, color: sc, background: sb, border: `1px solid ${sc}33`, borderRadius: '9999px', padding: '2px 8px' }}>
                          {rev ? 'revoked' : 'active'}
                        </span>
                      );
                    })()}
                  </div>
                </div>

                <button
                  onClick={onClose}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', display: 'flex', padding: '4px', flexShrink: 0 }}
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div style={{ overflowY: 'auto', flex: 1 }}>
              <KeyDetailBody
                apiKey={detailKey}
                onRevoke={onRevoke}
                onAfterRevoke={() => setDetailKey(null)}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────
export interface ApiKeyCarouselProps {
  keys: ApiKeyMetadataResponse[];
  loading: boolean;
  onRevoke: (keyId: string) => Promise<void>;
}

export function ApiKeyCarousel({ keys, loading, onRevoke }: ApiKeyCarouselProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedKey, setSelectedKey] = useState<ApiKeyMetadataResponse | null>(null);
  const [showAll, setShowAll] = useState(false);

  return (
    <div style={{ marginTop: '8px' }}>
      {/* Section header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'baseline', marginBottom: '16px',
      }}>
        <div style={{
          fontSize: '11px', fontFamily: "'Commit Mono', monospace",
          color: 'var(--text-tertiary)', textTransform: 'uppercase',
          letterSpacing: '0.1em', fontWeight: 600,
        }}>
          Active &amp; Historical Keys
        </div>
        {!loading && keys.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: '11px', fontFamily: "'Commit Mono', monospace",
              color: 'var(--accent-emerald)', padding: 0,
            }}
          >
            View all <ChevronRight size={12} />
          </button>
        )}
      </div>

      {/* Carousel */}
      <div style={{ position: 'relative' }}>
        <div
          ref={scrollRef}
          style={{
            display: 'flex', gap: '12px',
            overflowX: 'auto', paddingBottom: '8px',
            scrollbarWidth: 'none',
            maskImage: 'linear-gradient(to right, black 0%, black 80%, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to right, black 0%, black 80%, transparent 100%)',
          }}
        >
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} delay={i * 120} />)
          ) : keys.length === 0 ? (
            <div style={{
              flexShrink: 0, width: '100%', padding: '32px 20px',
              border: '1px dashed var(--border-default)', borderRadius: '12px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-tertiary)', fontSize: '12px',
              fontFamily: "'Commit Mono', monospace",
            }}>
              No API keys yet — create one above.
            </div>
          ) : (
            keys.map((key) => (
              <ApiKeyCard
                key={key.key_id}
                apiKey={key}
                onClick={() => setSelectedKey(key)}
              />
            ))
          )}

          {/* Trailing spacer */}
          <div style={{ flexShrink: 0, width: '64px' }} />
        </div>
      </div>

      {/* Card-click detail modal */}
      {selectedKey && (
        <ApiKeyDetailModal
          apiKey={selectedKey}
          onClose={() => setSelectedKey(null)}
          onRevoke={onRevoke}
        />
      )}

      {/* View-all modal */}
      {showAll && (
        <AllKeysModal
          keys={keys}
          onClose={() => setShowAll(false)}
          onRevoke={onRevoke}
        />
      )}
    </div>
  );
}
