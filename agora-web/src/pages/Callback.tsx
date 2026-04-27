import { useAuth } from "../lib/useAuth";
import { useNavigate } from "react-router-dom";

export function Callback() {
  const { isLoading, authStatus } = useAuth();
  const navigate = useNavigate();

  if (!isLoading && authStatus === "unauthenticated") {
    return (
      <>
        <title>Completing sign-in — Agora</title>
        <meta name="description" content="Finalising OAuth authentication for your Agora account." />
        <div
          style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          height: "100vh",
          width: "100vw",
          gap: "1rem",
          padding: "1.5rem",
          textAlign: "center",
        }}
      >
        <h1 className="wordmark" style={{ color: "var(--text-muted)" }}>AGORA</h1>
        <p style={{ color: "var(--text-secondary)", maxWidth: "42rem" }}>
          Sign-in did not complete. This usually means the current app origin does not match the
          configured redirect URI in WorkOS.
        </p>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", justifyContent: "center" }}>
          <button className="btn-primary" onClick={() => navigate("/login", { replace: true })}>
            Try sign in again
          </button>
          <button className="btn-secondary" onClick={() => navigate("/auth", { replace: true })}>
            Back to auth
          </button>
        </div>
      </div>
      </>
    );
  }

  return (
    <>
      <title>Completing sign-in — Agora</title>
      <meta name="description" content="Finalising OAuth authentication for your Agora account." />
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
    </>
  );
}
