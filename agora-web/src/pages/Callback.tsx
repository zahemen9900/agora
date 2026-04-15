import { useEffect } from "react";
import { consumeReturnTo, useAuth } from "../lib/auth";
import { useNavigate } from "react-router-dom";

/**
 * OAuth callback handler.
 * The AuthKitProvider handles the token exchange automatically.
 * This component just shows a loading state during the process.
 */
export function Callback() {
  const { isLoading, authStatus } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    // Once auth is resolved, redirect to home
    if (!isLoading && authStatus === "authenticated") {
      navigate(consumeReturnTo(), { replace: true });
    }
  }, [authStatus, isLoading, navigate]);

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
      <p style={{ color: "var(--text-secondary)" }}>Completing sign in...</p>
    </div>
  );
}
