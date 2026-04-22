import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, storeReturnTo } from "./lib/auth";
import { useAuth } from "./lib/useAuth";
import { ThemeProvider } from "./hooks/ThemeProvider";
import { AgoraLoader } from "./components/ui/AgoraLoader";
import { SessionRecoveryPage } from "./pages/SessionRecovery";

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

function pathToLabel(pathname: string): string {
  if (pathname.startsWith('/task/') && pathname.endsWith('/receipt')) return 'On-Chain Receipt';
  if (pathname.startsWith('/task/')) return 'Live Deliberation';
  if (pathname.startsWith('/benchmarks')) return 'Benchmarks';
  if (pathname === '/tasks') return 'Tasks';
  if (pathname === '/api-keys') return 'API Keys';
  return 'that page';
}

function RedirectToAuth() {
  const location = useLocation();
  storeReturnTo(`${location.pathname}${location.search}${location.hash}`);
  const label = pathToLabel(location.pathname);
  return <Navigate to={`/?from=${encodeURIComponent(label)}`} replace />;
}

function AppRoutes() {
  const { isLoading, authStatus, authIssue, featureFlags } = useAuth();

  if (isLoading) {
    return <AgoraLoader variant="splash" />;
  }

  if (authIssue) {
    return <SessionRecoveryPage issue={authIssue} />;
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

      {/* Unauthenticated: root shows the landing page; any other path stores the
          destination and redirects to / with a ?from= banner param. */}
      {!isAuthenticated && (
        <>
          <Route path="/" element={<LoginPage />} />
          <Route path="*" element={<RedirectToAuth />} />
        </>
      )}

      {/* Protected routes - only accessible when authenticated */}
      {isAuthenticated && (
        <>
          <Route path="/" element={<LoginPage />} />
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
