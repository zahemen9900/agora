import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";

// Page components
import { DashboardLayout } from "./layouts/DashboardLayout";
import { LoginPage } from "./pages/Login";
import { LoginRoute } from "./pages/Login.route";
import { Callback } from "./pages/Callback";
import { TaskSubmit } from "./pages/TaskSubmit";
import { LiveDeliberation } from "./pages/LiveDeliberation";
import { OnChainReceipt } from "./pages/OnChainReceipt";
import { ApiKeys } from "./pages/ApiKeys";

function AppRoutes() {
  const { isLoading, authStatus } = useAuth();

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', width: '100vw' }}>
        <h1 className="wordmark" style={{ animation: 'shimmer 2s infinite ease-in-out', color: 'var(--text-muted)' }}>AGORA</h1>
      </div>
    );
  }

  return (
    <Routes>
      {/* OAuth routes - accessible regardless of auth state */}
      <Route path="/auth" element={<LoginPage />} />
      <Route path="/login" element={<LoginRoute />} />
      <Route path="/callback" element={<Callback />} />

      {/* Redirect unauthenticated users to the dedicated auth page */}
      {authStatus !== "authenticated" && <Route path="*" element={<Navigate to="/auth" replace />} />}

      {/* Protected routes - only accessible when authenticated */}
      {authStatus === "authenticated" && (
        <>
          <Route path="/" element={<DashboardLayout><TaskSubmit /></DashboardLayout>} />
          <Route path="/task/:taskId" element={<DashboardLayout><LiveDeliberation /></DashboardLayout>} />
          <Route path="/task/:taskId/receipt" element={<DashboardLayout><OnChainReceipt /></DashboardLayout>} />
          <Route path="/api-keys" element={<DashboardLayout><ApiKeys /></DashboardLayout>} />
          <Route path="*" element={<Navigate to="/" />} />
        </>
      )}
    </Routes>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}

export default App;
