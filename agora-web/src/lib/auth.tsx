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
  getAccessToken: () => Promise<string>;
  /** Synchronous token accessor - returns null if not authenticated */
  token: string | null;
}

// Custom hook that wraps WorkOS useAuth to match existing interface
export function useAuth(): AuthContextType {
  const workosAuth = useWorkOSAuth();

  // Create a synchronous token accessor for backward compatibility
  // This uses the internal accessToken from WorkOS when available
  const token = workosAuth.user ? (workosAuth as unknown as { accessToken?: string }).accessToken ?? null : null;

  return {
    user: workosAuth.user ?? null,
    isLoading: workosAuth.isLoading,
    signIn: () => workosAuth.signIn(),
    signUp: () => workosAuth.signUp(),
    signOut: () => workosAuth.signOut(),
    getAccessToken: workosAuth.getAccessToken,
    token,
  };
}

// AuthProvider wraps WorkOS AuthKitProvider with correct configuration
export function AuthProvider({ children }: { children: ReactNode }) {
  const clientId = import.meta.env.VITE_WORKOS_CLIENT_ID;

  if (!clientId) {
    throw new Error(
      "Missing VITE_WORKOS_CLIENT_ID environment variable. " +
      "Ensure it is set in .env.local with the VITE_ prefix for Vite to expose it."
    );
  }

  return (
    <AuthKitProvider
      clientId={clientId}
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
