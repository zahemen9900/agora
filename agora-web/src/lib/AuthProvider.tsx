import {
  AuthKitProvider,
  useAuth as useWorkOSAuth,
} from "@workos-inc/authkit-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  ApiRequestError,
  type FeatureFlagsResponse,
  getAuthConfig,
  getAuthMe,
  type AuthConfigPayload,
  type PrincipalResponse,
  type WorkspaceResponse,
} from "./api";
import { AuthContext, type AuthContextType, type AuthIssue, type AuthStatus } from "./authContext";

const RETURN_TO_STORAGE_KEY = "agora:returnTo";
const DEFAULT_RETURN_TO = "/";

function isAuthPath(pathname: string): boolean {
  return pathname.startsWith("/auth")
    || pathname.startsWith("/login")
    || pathname.startsWith("/callback");
}

function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value) {
    return DEFAULT_RETURN_TO;
  }

  try {
    const candidate = new URL(value, window.location.origin);
    if (candidate.origin !== window.location.origin) {
      return DEFAULT_RETURN_TO;
    }
    const normalized = `${candidate.pathname}${candidate.search}${candidate.hash}`;
    return normalized.startsWith("/") ? normalized : DEFAULT_RETURN_TO;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

// Stores a destination path before a redirect, without overwriting an existing one.
export function storeReturnTo(path: string): void {
  if (!window.sessionStorage.getItem(RETURN_TO_STORAGE_KEY)) {
    window.sessionStorage.setItem(RETURN_TO_STORAGE_KEY, sanitizeReturnTo(path));
  }
}

function rememberReturnTo(): string {
  // Consume any path pre-stored by a redirect (e.g. RedirectToAuth in App.tsx).
  const stored = window.sessionStorage.getItem(RETURN_TO_STORAGE_KEY);
  if (stored) {
    window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
    return sanitizeReturnTo(stored);
  }
  const target = sanitizeReturnTo(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
  if (!isAuthPath(target)) {
    window.sessionStorage.setItem(RETURN_TO_STORAGE_KEY, target);
    return target;
  }
  return DEFAULT_RETURN_TO;
}

function returnToFromState(state: unknown): string | null {
  if (!state || typeof state !== "object") {
    return null;
  }
  const candidate = (state as { returnTo?: unknown }).returnTo;
  if (typeof candidate !== "string") {
    return null;
  }
  return sanitizeReturnTo(candidate);
}

function consumeReturnTo(): string {
  const value = window.sessionStorage.getItem(RETURN_TO_STORAGE_KEY);
  window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
  return sanitizeReturnTo(value);
}

function resolveRedirectUri(configuredRedirectUri: string | undefined): string {
  const fallback = `${window.location.origin}/callback`;
  const configured = (configuredRedirectUri ?? "").trim();
  if (!configured) {
    return fallback;
  }

  try {
    const parsed = new URL(configured, window.location.origin);
    if (import.meta.env.DEV && parsed.origin !== window.location.origin) {
      console.warn(
        "VITE_WORKOS_REDIRECT_URI origin does not match the current dev origin. "
        + "Falling back to the current origin to preserve callback state.",
      );
      return fallback;
    }
    return parsed.toString();
  } catch {
    console.warn("VITE_WORKOS_REDIRECT_URI is invalid. Falling back to /callback.");
    return fallback;
  }
}

function isBackendUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("request failed: 502")
    || message.includes("failed to fetch")
    || message.includes("networkerror");
}

function shouldResolveAuthFromBackend(configuredClientId: string): boolean {
  const source = (import.meta.env.VITE_WORKOS_CONFIG_SOURCE ?? "").trim().toLowerCase();
  if (["backend", "server", "api"].includes(source)) {
    return true;
  }

  const backendSource = (import.meta.env.VITE_AGORA_BACKEND_SOURCE ?? "").trim().toLowerCase();
  if (backendSource === "gcloud") {
    return true;
  }

  if (!configuredClientId.trim()) {
    return true;
  }

  return false;
}

function buildFallbackAuthConfig(clientId: string): AuthConfigPayload {
  return {
    workos_client_id: clientId,
    workos_authkit_domain: "",
    auth_issuer: "",
    auth_audience: "",
    auth_jwks_url: "",
  };
}

function AuthStateProvider({ children }: { children: ReactNode }) {
  const workosAuth = useWorkOSAuth();
  const {
    getAccessToken,
    isLoading,
    signIn,
    signOut,
    signUp,
    user,
  } = workosAuth;
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const [principal, setPrincipal] = useState<PrincipalResponse | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [featureFlags, setFeatureFlags] = useState<FeatureFlagsResponse | null>(null);
  const [authIssue, setAuthIssue] = useState<AuthIssue | null>(null);
  const bootstrappedSubjectRef = useRef<string | null>(null);
  const blockedBootstrapSubjectRef = useRef<string | null>(null);
  const backendUnavailableWarnedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (isLoading) {
        setAuthStatus("loading");
        return;
      }
      if (!user) {
        setPrincipal(null);
        setWorkspace(null);
        setFeatureFlags(null);
        setAuthIssue(null);
        setAuthStatus("unauthenticated");
        bootstrappedSubjectRef.current = null;
        blockedBootstrapSubjectRef.current = null;
        backendUnavailableWarnedRef.current = false;
        return;
      }

      const bootstrapSubject = user.id ?? user.email ?? "authenticated";
      if (blockedBootstrapSubjectRef.current === bootstrapSubject) {
        setAuthStatus("unauthenticated");
        return;
      }
      if (bootstrappedSubjectRef.current === bootstrapSubject) {
        setAuthStatus("authenticated");
        return;
      }

      bootstrappedSubjectRef.current = bootstrapSubject;

      setAuthStatus("loading");
      try {
        const token = await getAccessToken({ forceRefresh: true });
        if (!token) {
          await signOut();
          if (!cancelled) {
            setAuthIssue(null);
            setAuthStatus("unauthenticated");
          }
          return;
        }

        if (cancelled) {
          return;
        }

        // Treat WorkOS session as authenticated even if backend bootstrap is unavailable.
        setAuthStatus("authenticated");

        try {
          const session = await getAuthMe(token);
          if (cancelled) {
            return;
          }
          setPrincipal(session.principal);
          setWorkspace(session.workspace);
          setFeatureFlags(session.feature_flags);
          setAuthIssue(null);
          blockedBootstrapSubjectRef.current = null;
          backendUnavailableWarnedRef.current = false;
        } catch (error) {
          if (cancelled) {
            return;
          }

          if (error instanceof ApiRequestError && [401, 403, 404].includes(error.status)) {
            setPrincipal(null);
            setWorkspace(null);
            setFeatureFlags(null);
            const nextIssue: AuthIssue = error.status === 404
              ? "workspace_missing"
              : error.status === 403
                ? "access_denied"
                : "session_expired";
            setAuthIssue(nextIssue);
            blockedBootstrapSubjectRef.current = bootstrapSubject;
            setAuthStatus("unauthenticated");
            return;
          }

          setPrincipal(null);
          setWorkspace(null);
          setFeatureFlags(null);
          setAuthIssue(null);

          if (isBackendUnavailableError(error)) {
            if (!backendUnavailableWarnedRef.current) {
              console.warn(
                "Auth bootstrap skipped: backend is unavailable via /api. "
                + "Set VITE_AGORA_API_PROXY_TARGET/VITE_AGORA_API_URL to a reachable backend "
                + "(for local backend use http://localhost:8000).",
              );
              backendUnavailableWarnedRef.current = true;
            }
          } else {
            console.warn("Auth bootstrap warning: /auth/me failed", error);
          }
        }
      } catch {
        await signOut();
        if (!cancelled) {
          setPrincipal(null);
          setWorkspace(null);
          setFeatureFlags(null);
          setAuthIssue(null);
          setAuthStatus("unauthenticated");
        }
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken, isLoading, signOut, user]);

  const contextValue = useMemo<AuthContextType>(() => ({
    user: user ?? null,
    isLoading: authStatus === "loading" || isLoading,
    authStatus,
    principal,
    workspace,
    featureFlags,
    authIssue,
    signIn: () => {
      const returnTo = rememberReturnTo();
      signIn({ state: { returnTo } });
    },
    signUp: () => {
      const returnTo = rememberReturnTo();
      signUp({ state: { returnTo } });
    },
    signOut: () => {
      window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
      setPrincipal(null);
      setWorkspace(null);
      setFeatureFlags(null);
      setAuthIssue(null);
      setAuthStatus("unauthenticated");
      blockedBootstrapSubjectRef.current = null;
      signOut({ returnTo: `${window.location.origin}/auth` });
    },
    getAccessToken: async () => {
      if (!user) {
        return null;
      }
      try {
        const token = await getAccessToken({ forceRefresh: true });
        return token ?? null;
      } catch {
        return null;
      }
    },
  }), [authIssue, authStatus, featureFlags, getAccessToken, isLoading, principal, signIn, signOut, signUp, user, workspace]);

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

// AuthProvider wraps WorkOS AuthKitProvider with correct configuration
export function AuthProvider({ children }: { children: ReactNode }) {
  const configuredClientId = (import.meta.env.VITE_WORKOS_CLIENT_ID ?? "").trim();
  const [resolvedAuthConfig, setResolvedAuthConfig] = useState<AuthConfigPayload | null>(
    () => !shouldResolveAuthFromBackend(configuredClientId) && configuredClientId
      ? buildFallbackAuthConfig(configuredClientId)
      : null,
  );
  const [authConfigError, setAuthConfigError] = useState<string | null>(null);
  const mismatchWarnedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function resolveAuthConfig() {
      setAuthConfigError(null);
      const fallback = buildFallbackAuthConfig(configuredClientId);
      const shouldUseBackendConfig = shouldResolveAuthFromBackend(configuredClientId);

      if (!shouldUseBackendConfig) {
        if (!configuredClientId) {
          setAuthConfigError(
            "Missing VITE_WORKOS_CLIENT_ID environment variable. "
            + "Set VITE_WORKOS_CLIENT_ID or enable backend auth config bootstrap.",
          );
          return;
        }
        if (!cancelled) {
          setResolvedAuthConfig(fallback);
        }
        return;
      }

      try {
        const backendConfig = await getAuthConfig();
        const backendClientId = (backendConfig.workos_client_id ?? "").trim();
        if (!backendClientId && !configuredClientId) {
          throw new Error("Backend auth config returned no WorkOS client id.");
        }

        if (
          configuredClientId
          && backendClientId
          && configuredClientId !== backendClientId
          && !mismatchWarnedRef.current
        ) {
          console.warn(
            "VITE_WORKOS_CLIENT_ID differs from backend /auth/config workos_client_id. "
            + "Using backend value to avoid token audience mismatch.",
            {
              envClientId: configuredClientId,
              backendClientId,
            },
          );
          mismatchWarnedRef.current = true;
        }

        if (!cancelled) {
          setResolvedAuthConfig({
            ...backendConfig,
            workos_client_id: backendClientId || configuredClientId,
          });
        }
      } catch (error) {
        if (!configuredClientId) {
          if (!cancelled) {
            setAuthConfigError(
              "Unable to resolve WorkOS configuration from backend /auth/config. "
              + "Set VITE_WORKOS_CLIENT_ID locally or ensure backend auth settings are configured.",
            );
          }
          return;
        }

        if (!cancelled) {
          console.warn(
            "Falling back to VITE_WORKOS_CLIENT_ID after /auth/config lookup failure.",
            error,
          );
          setResolvedAuthConfig(fallback);
        }
      }
    }

    void resolveAuthConfig();
    return () => {
      cancelled = true;
    };
  }, [configuredClientId]);

  const clientId = resolvedAuthConfig?.workos_client_id ?? "";
  const redirectUri = resolveRedirectUri(import.meta.env.VITE_WORKOS_REDIRECT_URI);
  const configuredApiHostname = (import.meta.env.VITE_WORKOS_API_HOSTNAME ?? "").trim();
  // Always proxy WorkOS SDK requests through the current host so Vercel/Vite can forward
  // /user_management/* to api.workos.com — avoids CORS failures in both dev and production.
  const apiHostname = configuredApiHostname || window.location.hostname;

  const configuredPortRaw = (import.meta.env.VITE_WORKOS_API_PORT ?? "").trim();
  const configuredPort = configuredPortRaw ? Number.parseInt(configuredPortRaw, 10) : Number.NaN;
  const apiPort = Number.isFinite(configuredPort)
    ? configuredPort
    : (window.location.port ? Number.parseInt(window.location.port, 10) : undefined);

  const configuredHttpsRaw = (import.meta.env.VITE_WORKOS_API_HTTPS ?? "").trim().toLowerCase();
  const configuredHttps = configuredHttpsRaw
    ? ["1", "true", "yes", "on"].includes(configuredHttpsRaw)
    : undefined;
  const apiHttps = configuredHttps ?? (window.location.protocol === "https:");

  if (authConfigError) {
    throw new Error(authConfigError);
  }

  if (!resolvedAuthConfig) {
    return (
      <div className="max-w-225 mx-auto px-4 py-16">
        <div className="card p-6 border border-border-subtle">
          <p className="text-text-secondary">Initializing authentication settings...</p>
        </div>
      </div>
    );
  }

  if (!clientId) {
    throw new Error(
      "Missing VITE_WORKOS_CLIENT_ID environment variable. " +
      "Ensure it is set in .env.local with the VITE_ prefix for Vite to expose it."
    );
  }

  return (
    <AuthKitProvider
      clientId={clientId}
      redirectUri={redirectUri}
      apiHostname={apiHostname}
      port={apiPort}
      https={apiHttps}
      onRedirectCallback={({ state }) => {
        const target = returnToFromState(state) ?? consumeReturnTo();
        window.location.replace(target);
      }}
    >
      <AuthStateProvider>{children}</AuthStateProvider>
    </AuthKitProvider>
  );
}
