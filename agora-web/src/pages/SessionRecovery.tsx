import { ArrowRight, ShieldAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../lib/useAuth";
import type { AuthIssue } from "../lib/authContext";
import { Button } from "../components/ui/Button";

const ISSUE_COPY: Record<AuthIssue, { eyebrow: string; title: string; body: string }> = {
  session_expired: {
    eyebrow: "SESSION EXPIRED",
    title: "Your session needs to be refreshed.",
    body: "Sign in again to restore access and return to the page you were on.",
  },
  access_denied: {
    eyebrow: "ACCESS DENIED",
    title: "Your workspace access changed.",
    body: "Your account no longer has permission to load this workspace. Sign in again or ask an admin to confirm access.",
  },
  workspace_missing: {
    eyebrow: "WORKSPACE UNAVAILABLE",
    title: "We couldn't load your workspace.",
    body: "Your account is still valid, but the workspace record is missing or unavailable. Sign in again to retry the bootstrap.",
  },
};

export function SessionRecoveryPage({ issue }: { issue: AuthIssue }) {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const copy = ISSUE_COPY[issue];

  return (
    <>
      <title>Session Recovery — Agora</title>
      <meta name="description" content="Re-authenticate or recover your Agora session to continue." />
      <div className="min-h-screen px-6 py-10 flex items-center justify-center">
        <div className="relative max-w-lg w-full overflow-hidden" style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-default)",
          borderRadius: "20px",
          padding: "36px 40px 40px",
        }}>
          {/* Gradient accent — top-right origin for depth */}
          <div
            aria-hidden
            style={{
              position: "absolute", inset: 0,
              background: "radial-gradient(ellipse 80% 50% at 100% 0%, rgba(0,212,170,0.10) 0%, transparent 60%)",
              pointerEvents: "none",
            }}
          />

          <div style={{ position: "relative", zIndex: 1 }}>
            {/* Wordmark */}
            <div className="wordmark" style={{ fontSize: "15px", letterSpacing: "0.1em", color: "var(--text-primary)", marginBottom: "32px" }}>
              AGORA
            </div>

            {/* Eyebrow badge */}
            <div className="badge" style={{ marginBottom: "16px", gap: "6px" }}>
              <ShieldAlert size={13} /> {copy.eyebrow}
            </div>

            {/* Heading */}
            <h1 style={{ marginBottom: "12px", fontSize: "clamp(1.6rem, 4vw, 2.2rem)", lineHeight: 1.18 }}>
              {copy.title}
            </h1>

            {/* Body */}
            <p style={{ color: "var(--text-secondary)", fontSize: "15px", lineHeight: 1.65, marginBottom: "32px" }}>
              {copy.body}
            </p>

            {/* Actions */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginBottom: "24px" }}>
              <Button type="button" className="inline-flex items-center gap-2" onClick={() => signIn()} variant="primary">
                Sign in again <ArrowRight size={15} />
              </Button>
              <Button onClick={() => navigate('/')} variant="secondary" className="inline-flex items-center justify-center gap-2">
                Go to sign in
              </Button>
            </div>

            {/* Hint */}
            <p className="mono" style={{ fontSize: "11px", color: "var(--text-muted)", lineHeight: 1.6 }}>
              You can safely refresh after signing back in. Your previous destination is preserved.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}