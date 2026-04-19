import { useEffect } from "react";
import { useAuth } from "../lib/useAuth";

/**
 * Login route - initiates the OAuth sign-in flow.
 * When users navigate to /login, they are immediately redirected to WorkOS.
 */
export function LoginRoute() {
  const { signIn, isLoading, user } = useAuth();

  useEffect(() => {
    // If not already authenticated and not loading, initiate sign in
    if (!isLoading && !user) {
      signIn();
    }
  }, [signIn, isLoading, user]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        height: "100vh",
        width: "100vw",
        gap: "1rem",
      }}
    >
      <h1
        className="wordmark"
        style={{
          animation: "shimmer 2s infinite ease-in-out",
          color: "var(--text-muted)",
        }}
      >
        AGORA
      </h1>
      <p style={{ color: "var(--text-secondary)" }}>Redirecting to sign in...</p>
    </div>
  );
}
