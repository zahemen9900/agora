import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { useAuth } from "./lib/useAuth";
import { ThemeProvider } from "./hooks/ThemeProvider";

// Page components
import { DashboardLayout } from "./layouts/DashboardLayout";
import { LoginPage } from "./pages/Login";
import { LoginRoute } from "./pages/Login.route";
import { Callback } from "./pages/Callback";
import { TaskSubmit } from "./pages/TaskSubmit";
import { LiveDeliberation } from "./pages/LiveDeliberation";
import { OnChainReceipt } from "./pages/OnChainReceipt";
import { ApiKeys } from "./pages/ApiKeys";
import { Benchmarks } from "./pages/Benchmarks";
import { BenchmarksAll } from "./pages/BenchmarksAll";
import { BenchmarkDetail } from "./pages/BenchmarkDetail";

function AppRoutes() {
  const { isLoading, authStatus, featureFlags } = useAuth();

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', width: '100vw' }}>
        <h1 className="wordmark" style={{ animation: 'shimmer 2s infinite ease-in-out', color: 'var(--text-muted)' }}>AGORA</h1>
      </div>
    );
  }

  const isAuthenticated = authStatus === "authenticated";
  const canViewBenchmarks = isAuthenticated && (featureFlags?.benchmarks_visible ?? true);
  const canViewApiKeys = isAuthenticated && (featureFlags?.api_keys_visible ?? true);

  return (
    <Routes>
      {/* OAuth routes - accessible regardless of auth state */}
      <Route path="/auth" element={isAuthenticated ? <Navigate to="/tasks" replace /> : <LoginPage />} />
      <Route path="/login" element={isAuthenticated ? <Navigate to="/tasks" replace /> : <LoginRoute />} />
      <Route path="/callback" element={<Callback />} />

      {/* Unauthenticated: show LoginPage at the current URL so rememberReturnTo() captures the
          original path when the user clicks Sign In (deep link recovery). */}
      {!isAuthenticated && (
        <Route path="*" element={<LoginPage />} />
      )}

      {/* Protected routes - only accessible when authenticated */}
      {isAuthenticated && (
        <>
          <Route path="/" element={<Navigate to="/tasks" replace />} />
          <Route path="/tasks" element={<DashboardLayout><TaskSubmit /></DashboardLayout>} />
          <Route path="/task/:taskId" element={<DashboardLayout><LiveDeliberation /></DashboardLayout>} />
          <Route path="/task/:taskId/receipt" element={<DashboardLayout><OnChainReceipt /></DashboardLayout>} />
          <Route
            path="/api-keys"
            element={
              canViewApiKeys
                ? <DashboardLayout><ApiKeys /></DashboardLayout>
                : <Navigate to="/tasks" replace />
            }
          />
          <Route
            path="/benchmarks"
            element={
              canViewBenchmarks
                ? <DashboardLayout><Benchmarks /></DashboardLayout>
                : <Navigate to="/tasks" replace />
            }
          />
          <Route
            path="/benchmarks/all"
            element={
              canViewBenchmarks
                ? <DashboardLayout><BenchmarksAll /></DashboardLayout>
                : <Navigate to="/tasks" replace />
            }
          />
          <Route
            path="/benchmarks/:benchmarkId"
            element={
              canViewBenchmarks
                ? <DashboardLayout><BenchmarkDetail /></DashboardLayout>
                : <Navigate to="/tasks" replace />
            }
          />
          <Route path="*" element={<Navigate to="/tasks" replace />} />
        </>
      )}
    </Routes>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
