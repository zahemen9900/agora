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
      <div className="relative max-w-xl w-full card p-8 sm:p-10 border border-border-subtle overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(0,212,170,0.12),transparent_45%)] pointer-events-none" />
        <div className="relative z-10">
          <div className="wordmark text-xl mb-8">AGORA</div>
          <div className="badge mb-4 inline-flex items-center gap-2">
            <ShieldAlert size={14} /> {copy.eyebrow}
          </div>
          <h1 className="text-3xl md:text-4xl mb-4">{copy.title}</h1>
          <p className="text-text-secondary text-base md:text-lg leading-relaxed max-w-lg">
            {copy.body}
          </p>

          <div className="mt-8 flex flex-col sm:flex-row gap-3">
            <Button type="button" className="inline-flex items-center gap-2" onClick={() => signIn()} variant="primary">
              Sign in again <ArrowRight size={16} />
            </Button>
            <Button onClick={() => navigate('/')} variant="secondary" className="inline-flex items-center justify-center gap-2">
              Go to sign in
            </Button>
          </div>

          <p className="mono text-xs text-text-muted mt-6">
            You can safely refresh after signing back in. Your previous destination is preserved.
          </p>
        </div>
      </div>
    </div>
    </>
  );
}