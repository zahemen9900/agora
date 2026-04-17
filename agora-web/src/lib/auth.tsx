import {
  AuthKitProvider,
  useAuth as useWorkOSAuth,
  type User as WorkOSUser,
} from "@workos-inc/authkit-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  getAuthMe,
  type FeatureFlagsResponse,
  type PrincipalResponse,
  type WorkspaceResponse,
} from "./api";

// Re-export user type for consumers
export type User = WorkOSUser;
type AuthStatus = "loading" | "authenticated" | "unauthenticated";
const RETURN_TO_STORAGE_KEY = "agora:returnTo";
const DEFAULT_RETURN_TO = "/";

// Wrapper interface matching the app's existing auth contract
interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  authStatus: AuthStatus;
  principal: PrincipalResponse | null;
  workspace: WorkspaceResponse | null;
  featureFlags: FeatureFlagsResponse | null;
  signIn: () => void;
  signUp: () => void;
  signOut: () => void;
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | null>(null);

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

function rememberReturnTo(): string {
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

export function consumeReturnTo(): string {
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

function AuthStateProvider({ children }: { children: ReactNode }) {
  const workosAuth = useWorkOSAuth();
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const [principal, setPrincipal] = useState<PrincipalResponse | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [featureFlags, setFeatureFlags] = useState<FeatureFlagsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (workosAuth.isLoading) {
        setAuthStatus("loading");
        return;
      }
      if (!workosAuth.user) {
        setPrincipal(null);
        setWorkspace(null);
        setFeatureFlags(null);
        setAuthStatus("unauthenticated");
        return;
      }

      setAuthStatus("loading");
      try {
        const token = await workosAuth.getAccessToken();
        if (!token) {
          await workosAuth.signOut();
          if (!cancelled) {
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
        } catch (error) {
          if (cancelled) {
            return;
          }
          setPrincipal(null);
          setWorkspace(null);
          setFeatureFlags(null);
          console.warn("Auth bootstrap warning: /auth/me failed", error);
        }
      } catch {
        await workosAuth.signOut();
        if (!cancelled) {
          setPrincipal(null);
          setWorkspace(null);
          setFeatureFlags(null);
          setAuthStatus("unauthenticated");
        }
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [workosAuth]);

  const contextValue = useMemo<AuthContextType>(() => ({
    user: workosAuth.user ?? null,
    isLoading: authStatus === "loading" || workosAuth.isLoading,
    authStatus,
    principal,
    workspace,
    featureFlags,
    signIn: () => {
      const returnTo = rememberReturnTo();
      workosAuth.signIn({ state: { returnTo } });
    },
    signUp: () => {
      const returnTo = rememberReturnTo();
      workosAuth.signUp({ state: { returnTo } });
    },
    signOut: () => {
      window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
      setPrincipal(null);
      setWorkspace(null);
      setFeatureFlags(null);
      setAuthStatus("unauthenticated");
      workosAuth.signOut({ returnTo: `${window.location.origin}/auth` });
    },
    getAccessToken: async () => {
      if (!workosAuth.user) {
        return null;
      }
      try {
        const token = await workosAuth.getAccessToken();
        return token ?? null;
      } catch {
        return null;
      }
    },
  }), [authStatus, featureFlags, principal, workspace, workosAuth]);

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

// Custom hook that wraps WorkOS useAuth to match existing interface
export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

// AuthProvider wraps WorkOS AuthKitProvider with correct configuration
export function AuthProvider({ children }: { children: ReactNode }) {
  const clientId = import.meta.env.VITE_WORKOS_CLIENT_ID;
  const redirectUri = resolveRedirectUri(import.meta.env.VITE_WORKOS_REDIRECT_URI);
  const devProxySetting = (import.meta.env.VITE_WORKOS_USE_DEV_PROXY ?? "").trim().toLowerCase();
  const useDevProxy = import.meta.env.DEV
    && ["1", "true", "yes", "on"].includes(devProxySetting);

  const configuredApiHostname = (import.meta.env.VITE_WORKOS_API_HOSTNAME ?? "").trim();
  const apiHostname = configuredApiHostname || (useDevProxy ? window.location.hostname : undefined);

  const configuredPortRaw = (import.meta.env.VITE_WORKOS_API_PORT ?? "").trim();
  const configuredPort = configuredPortRaw ? Number.parseInt(configuredPortRaw, 10) : Number.NaN;
  const apiPort = Number.isFinite(configuredPort)
    ? configuredPort
    : (useDevProxy && window.location.port
      ? Number.parseInt(window.location.port, 10)
      : undefined);

  const configuredHttpsRaw = (import.meta.env.VITE_WORKOS_API_HTTPS ?? "").trim().toLowerCase();
  const configuredHttps = configuredHttpsRaw
    ? ["1", "true", "yes", "on"].includes(configuredHttpsRaw)
    : undefined;
  const apiHttps = configuredHttps ?? (useDevProxy ? window.location.protocol === "https:" : undefined);

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
