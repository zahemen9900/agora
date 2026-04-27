import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, KeyRound, ShieldAlert } from "lucide-react";

import {
  type ApiKeyCreateResponse,
} from "../lib/api";
import {
  addApiKeyToListCache,
  apiKeyQueryKeys,
  updateApiKeyListCache,
  useApiKeyListQuery,
  useCreateApiKeyMutation,
  useRevokeApiKeyMutation,
} from "../lib/apiKeyQueries";
import { useAuth } from "../lib/useAuth";
import { ApiKeyCarousel } from "../components/task/ApiKeyCarousel";

// ─── One-time reveal modal ────────────────────────────────────────────────────
interface RevealModalProps {
  created: ApiKeyCreateResponse;
  onDismiss: () => void;
}

function RevealModal({ created, onDismiss }: RevealModalProps) {
  const FONT = "'Commit Mono', 'SF Mono', monospace";
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) window.clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  function handleCopy() {
    void navigator.clipboard.writeText(created.api_key);
    setCopyState("copied");
    if (copyTimeoutRef.current !== null) window.clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = window.setTimeout(() => setCopyState("idle"), 2000);
  }

  return (
    <>
      {/* Non-dismissible backdrop */}
      <div style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(8px)',
        zIndex: 1000,
      }} />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="One-time key reveal"
        style={{
          position: 'fixed', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(560px, calc(100vw - 32px))',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--accent-emerald)',
          borderRadius: '20px',
          boxShadow: '0 0 0 1px rgba(34,211,138,0.15), 0 32px 80px rgba(0,0,0,0.55)',
          zIndex: 1001, overflow: 'hidden',
        }}
      >
        {/* Hero header — no X button, intentionally no escape */}
        <div style={{
          padding: '28px 28px 22px',
          background: 'linear-gradient(135deg, rgba(34,211,138,0.10) 0%, transparent 60%)',
          borderBottom: '1px solid var(--border-default)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <ShieldAlert size={16} style={{ color: 'var(--accent-emerald)', flexShrink: 0 }} />
            <span style={{
              fontSize: '11px', fontFamily: FONT, fontWeight: 700,
              color: 'var(--accent-emerald)', letterSpacing: '0.12em', textTransform: 'uppercase',
            }}>
              One-time secret
            </span>
          </div>
          <p style={{
            margin: 0, fontSize: '13px', fontFamily: FONT,
            color: 'var(--text-secondary)', lineHeight: 1.6,
          }}>
            This is the only time this key will be shown. Copy it now and store it in your
            secret manager before closing.
          </p>
        </div>

        {/* Body */}
        <div style={{ padding: '24px 28px 28px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* Key name + public ID */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '32px', height: '32px', borderRadius: '8px', flexShrink: 0,
              background: 'var(--accent-emerald-soft)', border: '1px solid rgba(34,211,138,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <KeyRound size={14} style={{ color: 'var(--accent-emerald)' }} />
            </div>
            <div>
              <div style={{ fontSize: '13px', fontFamily: FONT, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {created.metadata.name}
              </div>
              <div style={{ fontSize: '10px', fontFamily: FONT, color: 'var(--text-tertiary)', marginTop: '2px' }}>
                {created.metadata.public_id}
              </div>
            </div>
          </div>

          {/* Key value */}
          <div style={{
            background: 'var(--bg-base)', border: '1px solid var(--border-default)',
            borderRadius: '10px', padding: '14px 16px',
            wordBreak: 'break-all', fontSize: '13px', fontFamily: FONT,
            color: 'var(--text-primary)', lineHeight: 1.7,
            userSelect: 'all',
          }}>
            {created.api_key}
          </div>

          {/* Copy button */}
          <button
            type="button"
            onClick={handleCopy}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              padding: '12px', borderRadius: '10px',
              background: copyState === 'copied' ? 'var(--accent-emerald-soft)' : 'var(--accent-emerald)',
              color: copyState === 'copied' ? 'var(--accent-emerald)' : '#0A0C0E',
              fontFamily: FONT, fontSize: '13px', fontWeight: 600,
              letterSpacing: '0.04em', textTransform: 'uppercase',
              cursor: 'pointer', transition: 'background 0.15s ease, color 0.15s ease',
              border: copyState === 'copied' ? '1px solid rgba(34,211,138,0.35)' : 'none',
            } as React.CSSProperties}
          >
            {copyState === 'copied' ? <CheckCircle2 size={15} /> : <Copy size={15} />}
            {copyState === 'copied' ? 'Copied to clipboard' : 'Copy key'}
          </button>

          {/* Dismiss — only way to close */}
          <button
            type="button"
            onClick={onDismiss}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '11px', borderRadius: '10px',
              background: 'none', border: '1px solid var(--border-strong)',
              fontFamily: FONT, fontSize: '12px', color: 'var(--text-secondary)',
              cursor: 'pointer', transition: 'border-color 0.15s ease, color 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-strong)';
              e.currentTarget.style.color = 'var(--text-primary)';
              e.currentTarget.style.background = 'var(--bg-subtle)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-strong)';
              e.currentTarget.style.color = 'var(--text-secondary)';
              e.currentTarget.style.background = 'none';
            }}
          >
            I've saved my key — close
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export function ApiKeys() {
  const { principal, user, workspace } = useAuth();
  const queryClient = useQueryClient();
  const apiKeyListQuery = useApiKeyListQuery();
  const createApiKeyMutation = useCreateApiKeyMutation();
  const revokeApiKeyMutation = useRevokeApiKeyMutation();
  const workosFirstName = normalizedFirstName(user?.firstName);
  const principalFirstName = normalizedFirstName(principal?.display_name);
  const emailFirstName = firstNameFromEmail(user?.email ?? principal?.email);
  const resolvedFirstName = workosFirstName || principalFirstName || emailFirstName || "Authenticated user";
  const workspaceLabel = normalizeWorkspaceLabel(workspace?.display_name, resolvedFirstName);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<ApiKeyCreateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keys = apiKeyListQuery.data ?? [];
  const loading = apiKeyListQuery.isLoading;
  const listError = !apiKeyListQuery.data && apiKeyListQuery.error instanceof Error
    ? apiKeyListQuery.error.message
    : null;
  const visibleError = error ?? listError;
  const submitting = createApiKeyMutation.isPending;

  async function handleCreate() {
    if (!name.trim()) return;
    setError(null);
    try {
      const payload = await createApiKeyMutation.mutateAsync({ name: name.trim() });
      setCreated(payload);
      setName("");
      addApiKeyToListCache(queryClient, payload.metadata);
      await queryClient.invalidateQueries({ queryKey: apiKeyQueryKeys.list() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create API key");
    }
  }

  async function handleRevoke(keyId: string) {
    setError(null);
    try {
      const payload = await revokeApiKeyMutation.mutateAsync({ keyId });
      updateApiKeyListCache(queryClient, payload);
      await queryClient.invalidateQueries({ queryKey: apiKeyQueryKeys.list() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to revoke API key");
    }
  }

  const FONT = "'Commit Mono', 'SF Mono', monospace";

  return (
    <>
      <title>API Keys — Agora</title>
      <meta
        name="description"
        content="Create and manage API keys for programmatic access to Agora's deliberation protocol."
      />
    <div className="max-w-225 mx-auto" style={{ position: 'relative' }}>

      {/* ── Ambient glow ─────────────────────────────────────────────────
           Square div centered at (content_right − 220px, 40px above top).
           Circle with farthest-corner r ≈ 368px → transparent at 62% ≈ 228px.
           At the content's right edge (220px from center) colour ≈ 0.5% opacity,
           so even if an ancestor clips there, no visible hard edge appears.   */}
      <div style={{
        position: 'absolute',
        top: '-300px',   /* center y = -300 + 260 = -40px (just above content top) */
        right: '-40px',  /* center x = content_right − 520 + 40 + 260 = − 220px    */
        width: '520px',
        height: '520px',
        background: 'radial-gradient(circle at 50% 50%, rgba(34,211,138,0.15) 0%, transparent 62%)',
        pointerEvents: 'none',
        zIndex: 0,
      }} />

      {/* ── Page header ──────────────────────────────────────────────── */}
      <header style={{ position: 'relative', zIndex: 1, marginBottom: '48px' }}>
        {/* Eyebrow */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px' }}>
          <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'var(--accent-emerald)' }} />
          <span style={{
            fontSize: '10px', fontFamily: FONT, fontWeight: 600,
            color: 'var(--text-tertiary)', letterSpacing: '0.12em', textTransform: 'uppercase',
          }}>
            Workspace
          </span>
        </div>

        {/* Icon + title row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: '12px', flexShrink: 0,
            background: 'var(--accent-emerald-soft)', border: '1px solid rgba(34,211,138,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <KeyRound size={20} style={{ color: 'var(--accent-emerald)' }} />
          </div>
          <h1 style={{ margin: 0, fontSize: 'clamp(28px, 4vw, 40px)', lineHeight: 1 }}>
            API Keys
          </h1>
        </div>

        {/* Description */}
        <p style={{
          fontFamily: "'Hanken Grotesk', sans-serif", fontSize: '15px',
          color: 'var(--text-secondary)', maxWidth: '560px', lineHeight: 1.6,
          margin: '0 0 12px 0',
        }}>
          Issue workspace-scoped machine credentials for CI, services, notebooks, and SDK clients.
          Keys are shown exactly once and can be revoked at any time.
        </p>
        <a
          href="https://pypi.org/project/agora-arbitrator-sdk/"
          target="_blank"
          rel="noreferrer"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '6px 14px', borderRadius: '8px',
            border: '1px solid var(--border-default)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
            fontFamily: FONT, fontSize: '12px',
            textDecoration: 'none', marginBottom: '20px',
            transition: 'border-color 0.15s ease, color 0.15s ease',
          }}
          onMouseEnter={(e) => {
            const a = e.currentTarget as HTMLAnchorElement;
            a.style.borderColor = 'var(--accent-emerald)';
            a.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            const a = e.currentTarget as HTMLAnchorElement;
            a.style.borderColor = 'var(--border-default)';
            a.style.color = 'var(--text-secondary)';
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
          </svg>
          Read SDK Docs
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 17L17 7"/><path d="M7 7h10v10"/>
          </svg>
        </a>

        {/* Workspace identity badge */}
        {principal || workspace ? (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
            borderRadius: '9999px', padding: '5px 14px 5px 10px',
          }}>
            <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--accent-emerald)', flexShrink: 0 }} />
            <span style={{ fontSize: '11px', fontFamily: FONT, color: 'var(--text-secondary)' }}>
              {resolvedFirstName}
            </span>
            <span style={{ fontSize: '11px', fontFamily: FONT, color: 'var(--border-strong)', margin: '0 1px' }}>·</span>
            <span style={{ fontSize: '11px', fontFamily: FONT, color: 'var(--text-tertiary)' }}>
              {workspaceLabel}
            </span>
          </div>
        ) : null}
      </header>

      {/* ── CREATE KEY card ──────────────────────────────────────────── */}
      <div style={{
        position: 'relative', zIndex: 1,
        background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
        borderRadius: '18px', marginBottom: '32px', overflow: 'hidden',
        boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
      }}>
        {/* Card hero header */}
        <div style={{
          padding: '20px 24px 18px',
          background: 'linear-gradient(135deg, rgba(34,211,138,0.07) 0%, transparent 65%)',
          borderBottom: '1px solid var(--border-default)',
        }}>
          <div style={{
            fontSize: '10px', fontFamily: FONT, fontWeight: 600,
            color: 'var(--accent-emerald)', letterSpacing: '0.12em', textTransform: 'uppercase',
            marginBottom: '5px',
          }}>
            Create Key
          </div>
          <p style={{ margin: 0, fontSize: '12px', fontFamily: FONT, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            Give it a descriptive name so you can find and revoke it later.
          </p>
        </div>

        {/* Form */}
        <div style={{ padding: '20px 24px 24px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            style={{
              flex: 1, minWidth: '200px', background: 'var(--bg-base)', color: 'var(--text-primary)',
              border: '1px solid var(--border-default)', borderRadius: '10px',
              padding: '11px 16px', fontFamily: FONT, fontSize: '13px',
              outline: 'none', transition: 'border-color 0.15s ease',
            }}
            placeholder="ci-staging, notebook, langgraph-prod..."
            value={name}
            onChange={(event) => setName(event.target.value)}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent-emerald)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)'; }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim() && !submitting) { void handleCreate(); }
            }}
          />
          <button
            type="button"
            disabled={submitting || !name.trim()}
            onClick={handleCreate}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0,
              padding: '11px 20px', borderRadius: '10px', border: 'none',
              background: name.trim() && !submitting ? 'var(--accent-emerald)' : 'var(--border-strong)',
              color: name.trim() && !submitting ? '#0A0C0E' : 'var(--text-tertiary)',
              fontFamily: FONT, fontSize: '13px', fontWeight: 600,
              letterSpacing: '0.04em', textTransform: 'uppercase',
              cursor: name.trim() && !submitting ? 'pointer' : 'not-allowed',
              transition: 'background 0.15s ease, color 0.15s ease',
            }}
          >
            <KeyRound size={14} />
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>

      {visibleError ? (
        <div className="card p-4 mb-6 border border-red-500/30 text-red-200" style={{ position: 'relative', zIndex: 1 }}>
          {visibleError}
        </div>
      ) : null}

      <div style={{ position: 'relative', zIndex: 1 }}>
        <ApiKeyCarousel
          keys={keys}
          loading={loading}
          onRevoke={async (id) => { await handleRevoke(id); }}
        />
      </div>

      {/* ── One-time reveal modal ─────────────────────────────────────── */}
      {created ? (
        <RevealModal
          created={created}
          onDismiss={() => setCreated(null)}
        />
      ) : null}
    </div>
    </>
  );
}

function normalizedFirstName(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  if (isLikelyWorkOSId(trimmed)) return "";
  return trimmed.split(/\s+/)[0] ?? "";
}

function firstNameFromEmail(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || !trimmed.includes("@")) return "";
  const localPart = trimmed.split("@")[0]?.trim();
  if (!localPart) return "";
  return localPart.split(/[._-]+/)[0] ?? "";
}

function isLikelyWorkOSId(value: string): boolean {
  return /^(user|org|inv|team|role)_[A-Za-z0-9]+$/i.test(value.trim());
}

function normalizeWorkspaceLabel(
  value: string | null | undefined,
  firstName: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) return firstName ? `${firstName}'s Workspace` : "Workspace";
  const lower = trimmed.toLowerCase();
  if (isLikelyWorkOSId(trimmed) || /^user_[a-z0-9]+'s workspace$/i.test(trimmed) || lower.includes("user_")) {
    return firstName ? `${firstName}'s Workspace` : "Workspace";
  }
  return trimmed;
}
