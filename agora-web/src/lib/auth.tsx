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

function rememberReturnTo() {
  const target = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (!target.startsWith("/login") && !target.startsWith("/callback")) {
    window.sessionStorage.setItem(RETURN_TO_STORAGE_KEY, target || "/");
  }
}

export function consumeReturnTo(): string {
  const value = window.sessionStorage.getItem(RETURN_TO_STORAGE_KEY) || "/";
  window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
  return value;
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
        const session = await getAuthMe(token);
        if (cancelled) {
          return;
        }
        setPrincipal(session.principal);
        setWorkspace(session.workspace);
        setFeatureFlags(session.feature_flags);
        setAuthStatus("authenticated");
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
      rememberReturnTo();
      workosAuth.signIn();
    },
    signUp: () => {
      rememberReturnTo();
      workosAuth.signUp();
    },
    signOut: () => {
      window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
      setPrincipal(null);
      setWorkspace(null);
      setFeatureFlags(null);
      setAuthStatus("unauthenticated");
      workosAuth.signOut();
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
  const redirectUri = import.meta.env.VITE_WORKOS_REDIRECT_URI || `${window.location.origin}/callback`;

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
      // Optional: redirect after successful auth
      onRedirectCallback={() => {
        // Clear any OAuth params from URL after successful auth
        window.history.replaceState({}, document.title, window.location.pathname);
      }}
    >
      <AuthStateProvider>{children}</AuthStateProvider>
    </AuthKitProvider>
  );
}
