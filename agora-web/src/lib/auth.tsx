import {
  AuthKitProvider,
  useAuth as useWorkOSAuth,
  type User as WorkOSUser,
} from "@workos-inc/authkit-react";
import { type ReactNode } from "react";

// Re-export user type for consumers
export type User = WorkOSUser;

// Wrapper interface matching the app's existing auth contract
interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  signIn: () => void;
  signUp: () => void;
  signOut: () => void;
  getAccessToken: () => Promise<string | null>;
}

// Custom hook that wraps WorkOS useAuth to match existing interface
export function useAuth(): AuthContextType {
  const workosAuth = useWorkOSAuth();

  return {
    user: workosAuth.user ?? null,
    isLoading: workosAuth.isLoading,
    signIn: () => workosAuth.signIn(),
    signUp: () => workosAuth.signUp(),
    signOut: () => workosAuth.signOut(),
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
  };
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
      {children}
    </AuthKitProvider>
  );
}
