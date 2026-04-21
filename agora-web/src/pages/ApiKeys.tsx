import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Copy, KeyRound, ShieldX } from "lucide-react";

import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyCreateResponse,
  type ApiKeyMetadataResponse,
} from "../lib/api";
import { useAuth } from "../lib/useAuth";

export function ApiKeys() {
  const { getAccessToken, workspace } = useAuth();
  const [name, setName] = useState("");
  const [keys, setKeys] = useState<ApiKeyMetadataResponse[]>([]);
  const [created, setCreated] = useState<ApiKeyCreateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error("Missing access token");
      }
      const payload = await listApiKeys(token);
      setKeys(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }, [getAccessToken]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  async function handleCreate() {
    if (!name.trim()) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error("Missing access token");
      }
      const payload = await createApiKey(token, name.trim());
      setCreated(payload);
      setName("");
      await loadKeys();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create API key");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(keyId: string) {
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error("Missing access token");
      }
      await revokeApiKey(token, keyId);
      await loadKeys();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to revoke API key");
    }
  }

  async function copyCreatedKey() {
    if (!created?.api_key) {
      return;
    }
    await navigator.clipboard.writeText(created.api_key);
  }

  return (
    <div className="max-w-[900px] mx-auto">
      <header className="mb-10">
        <div className="mono text-text-muted text-xs mb-3">WORKSPACE</div>
        <h1 className="text-3xl md:text-4xl mb-4">API Keys</h1>
        <p className="text-text-secondary text-lg max-w-[700px]">
          Issue workspace-scoped machine credentials for CI, services, notebooks, and SDK clients.
          Keys are shown exactly once and can be revoked at any time.
        </p>
        {workspace ? (
          <p className="mono text-text-muted text-sm mt-4">
            {workspace.display_name} · {workspace.id}
          </p>
        ) : null}
      </header>

      <section className="card p-6 mb-8">
        <div className="l-corners" />
        <div className="mono text-text-muted text-xs mb-3">CREATE KEY</div>
        <div className="flex flex-col md:flex-row gap-4">
          <input
            className="mono flex-1 bg-void text-text-primary border border-border-muted py-3 px-4 rounded-md outline-none focus:border-accent transition-colors"
            placeholder="ci-staging, notebook, langgraph-prod..."
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            className="btn-primary md:w-auto"
            disabled={submitting || !name.trim()}
            onClick={handleCreate}
          >
            <KeyRound size={18} /> {submitting ? "Creating..." : "Create API Key"}
          </button>
        </div>
      </section>

      {created ? (
        <section className="card p-6 mb-8 border-accent">
          <div className="mono text-accent text-xs mb-3">ONE-TIME REVEAL</div>
          <p className="text-sm text-text-secondary mb-4">
            This secret will not be shown again. Copy it now and store it in your secret manager.
          </p>
          <div className="mono text-sm break-all bg-void border border-border-subtle rounded-md p-4 mb-4">
            {created.api_key}
          </div>
          <div className="flex flex-wrap gap-3 items-center">
            <button className="btn-secondary" onClick={() => void copyCreatedKey()}>
              <Copy size={16} /> Copy key
            </button>
            <span className="mono text-xs text-text-muted">
              {created.metadata.name} · {created.metadata.public_id}
            </span>
          </div>
        </section>
      ) : null}

      {error ? (
        <div className="card p-4 mb-6 border border-red-500/30 text-red-200">
          {error}
        </div>
      ) : null}

      <section className="card p-6">
        <div className="l-corners" />
        <div className="mono text-text-muted text-xs mb-4">ACTIVE AND HISTORICAL KEYS</div>
        {loading ? (
          <p className="text-text-secondary">Loading API keys...</p>
        ) : keys.length === 0 ? (
          <p className="text-text-secondary">No API keys have been created for this workspace yet.</p>
        ) : (
          <div className="space-y-4">
            {keys.map((key) => {
              const revoked = Boolean(key.revoked_at);
              return (
                <div key={key.key_id} className="border border-border-subtle rounded-lg p-4 bg-void">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="font-medium">{key.name}</span>
                        {revoked ? (
                          <span className="badge bg-red-500/15 text-red-200 border-red-500/30">
                            revoked
                          </span>
                        ) : (
                          <span className="badge">
                            active
                          </span>
                        )}
                      </div>
                      <div className="mono text-xs text-text-muted space-y-1">
                        <div>{key.public_id}</div>
                        <div>created {new Date(key.created_at).toLocaleString()}</div>
                        <div>
                          last used{" "}
                          {key.last_used_at ? new Date(key.last_used_at).toLocaleString() : "never"}
                        </div>
                        <div>
                          expires{" "}
                          {key.expires_at ? new Date(key.expires_at).toLocaleString() : "never"}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col items-start md:items-end gap-3">
                      <div className="mono text-xs text-text-muted">
                        {key.scopes.join(", ")}
                      </div>
                      {revoked ? (
                        <div className="text-sm text-text-secondary inline-flex items-center gap-2">
                          <CheckCircle2 size={14} /> Revoked
                        </div>
                      ) : (
                        <button className="btn-secondary" onClick={() => void handleRevoke(key.key_id)}>
                          <ShieldX size={16} /> Revoke key
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
