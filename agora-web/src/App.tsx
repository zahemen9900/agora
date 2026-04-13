import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";

// Need to create these page components next
import { DashboardLayout } from "./layouts/DashboardLayout";
import { LoginPage } from "./pages/Login";
import { TaskSubmit } from "./pages/TaskSubmit";
import { LiveDeliberation } from "./pages/LiveDeliberation";
import { OnChainReceipt } from "./pages/OnChainReceipt";
import { Benchmarks } from "./pages/Benchmarks";

function AppRoutes() {
  const { isLoading, user } = useAuth();

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', width: '100vw' }}>
        <h1 className="wordmark" style={{ animation: 'shimmer 2s infinite ease-in-out', color: 'var(--text-muted)' }}>AGORA</h1>
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return (
    <DashboardLayout>
      <Routes>
        <Route path="/" element={<TaskSubmit />} />
        <Route path="/task/:taskId" element={<LiveDeliberation />} />
        <Route path="/task/:taskId/receipt" element={<OnChainReceipt />} />
        <Route path="/benchmarks" element={<Benchmarks />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </DashboardLayout>
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
