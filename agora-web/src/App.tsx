import {
    Routes,
    Route,
    Navigate,
    useLocation,
    useParams,
} from "react-router-dom";
import { AuthProvider, storeReturnTo } from "./lib/auth";
import { useAuth } from "./lib/useAuth";
import { ThemeProvider } from "./hooks/ThemeProvider";
import { AgoraLoader } from "./components/ui/AgoraLoader";
import { SessionRecoveryPage } from "./pages/SessionRecovery";
import { AuthQueryBoundary } from "./lib/AuthQueryBoundary";

// Page components
import { DashboardLayout } from "./layouts/DashboardLayout";
import { DocsLayout } from "./layouts/DocsLayout";
import { DocsHome } from "./docs/content/DocsHome";
import { Quickstart } from "./docs/content/Quickstart";
import { Installation } from "./docs/content/Installation";
import { CoreConcepts } from "./docs/content/CoreConcepts";
import { PythonSDK } from "./docs/content/sdk/PythonSDK";
import { LangGraphIntegration } from "./docs/content/sdk/LangGraphIntegration";
import { CrewAIIntegration } from "./docs/content/sdk/CrewAIIntegration";
import { APIReference } from "./docs/content/sdk/APIReference";
import { ProofOfDeliberation } from "./docs/content/research/ProofOfDeliberation";
import { MechanismSelector } from "./docs/content/research/MechanismSelector";
import { FactionalDebate } from "./docs/content/research/FactionalDebate";
import { ISPVoting } from "./docs/content/research/ISPVoting";
import { DelphiConsensus } from "./docs/content/research/DelphiConsensus";
import { OnChainArchitecture } from "./docs/content/on-chain/OnChainArchitecture";
import { MerkleVerification } from "./docs/content/on-chain/MerkleVerification";
import { AnchorContract } from "./docs/content/on-chain/AnchorContract";
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
import { BenchmarkAnalytics } from "./pages/BenchmarkAnalytics";

function pathToLabel(pathname: string): string {
    if (pathname.startsWith("/task/") && pathname.endsWith("/receipt"))
        return "On-Chain Receipt";
    if (pathname.startsWith("/task/")) return "Live Deliberation";
    if (pathname.startsWith("/benchmarks")) return "Benchmarks";
    if (pathname === "/tasks") return "Tasks";
    if (pathname === "/api-keys") return "API Keys";
    return "that page";
}

function RedirectToAuth() {
    const location = useLocation();
    storeReturnTo(`${location.pathname}${location.search}${location.hash}`);
    const label = pathToLabel(location.pathname);
    return <Navigate to={`/?from=${encodeURIComponent(label)}`} replace />;
}

function KeyedLiveDeliberation() {
    const { taskId } = useParams();
    return <LiveDeliberation key={taskId ?? "task"} />;
}

function KeyedBenchmarkDetail() {
    const { benchmarkId } = useParams();
    return <BenchmarkDetail key={benchmarkId ?? "benchmark"} />;
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
    const canViewBenchmarks =
        isAuthenticated && (featureFlags?.benchmarks_visible ?? true);
    const canViewApiKeys =
        isAuthenticated && (featureFlags?.api_keys_visible ?? true);

    return (
        <Routes>
            {/* OAuth routes - accessible regardless of auth state */}
            <Route
                path="/auth"
                element={
                    isAuthenticated ? (
                        <Navigate to="/tasks" replace />
                    ) : (
                        <LoginPage />
                    )
                }
            />
            <Route
                path="/login"
                element={
                    isAuthenticated ? (
                        <Navigate to="/tasks" replace />
                    ) : (
                        <LoginRoute />
                    )
                }
            />
            <Route path="/callback" element={<Callback />} />

            {/* Always-accessible docs routes */}
            <Route path="/docs" element={<DocsLayout />}>
                <Route index element={<DocsHome />} />
                <Route path="quickstart" element={<Quickstart />} />
                <Route path="installation" element={<Installation />} />
                <Route path="concepts" element={<CoreConcepts />} />
                <Route path="sdk/python" element={<PythonSDK />} />
                <Route
                    path="sdk/langgraph"
                    element={<LangGraphIntegration />}
                />
                <Route path="sdk/crewai" element={<CrewAIIntegration />} />
                <Route path="sdk/api-reference" element={<APIReference />} />
                <Route
                    path="research/proof-of-deliberation"
                    element={<ProofOfDeliberation />}
                />
                <Route
                    path="research/mechanism-selector"
                    element={<MechanismSelector />}
                />
                <Route
                    path="research/factional-debate"
                    element={<FactionalDebate />}
                />
                <Route path="research/isp-voting" element={<ISPVoting />} />
                <Route
                    path="research/delphi-consensus"
                    element={<DelphiConsensus />}
                />
                <Route
                    path="on-chain/architecture"
                    element={<OnChainArchitecture />}
                />
                <Route
                    path="on-chain/verification"
                    element={<MerkleVerification />}
                />
                <Route
                    path="on-chain/anchor-contract"
                    element={<AnchorContract />}
                />
            </Route>

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
                    <Route
                        path="/tasks"
                        element={
                            <DashboardLayout>
                                <TaskSubmit />
                            </DashboardLayout>
                        }
                    />
                    <Route
                        path="/task/:taskId"
                        element={
                            <DashboardLayout>
                                <KeyedLiveDeliberation />
                            </DashboardLayout>
                        }
                    />
                    <Route
                        path="/task/:taskId/receipt"
                        element={
                            <DashboardLayout>
                                <OnChainReceipt />
                            </DashboardLayout>
                        }
                    />
                    <Route
                        path="/api-keys"
                        element={
                            canViewApiKeys ? (
                                <DashboardLayout>
                                    <ApiKeys />
                                </DashboardLayout>
                            ) : (
                                <Navigate to="/tasks" replace />
                            )
                        }
                    />
                    <Route
                        path="/benchmarks"
                        element={
                            canViewBenchmarks ? (
                                <DashboardLayout>
                                    <Benchmarks />
                                </DashboardLayout>
                            ) : (
                                <Navigate to="/tasks" replace />
                            )
                        }
                    />
                    <Route
                        path="/benchmarks/all"
                        element={
                            canViewBenchmarks ? (
                                <DashboardLayout>
                                    <BenchmarksAll />
                                </DashboardLayout>
                            ) : (
                                <Navigate to="/tasks" replace />
                            )
                        }
                    />
                    <Route
                        path="/benchmarks/analytics"
                        element={
                            canViewBenchmarks ? (
                                <DashboardLayout>
                                    <BenchmarkAnalytics />
                                </DashboardLayout>
                            ) : (
                                <Navigate to="/tasks" replace />
                            )
                        }
                    />
                    <Route
                        path="/benchmarks/:benchmarkId"
                        element={
                            canViewBenchmarks ? (
                                <DashboardLayout>
                                    <KeyedBenchmarkDetail />
                                </DashboardLayout>
                            ) : (
                                <Navigate to="/tasks" replace />
                            )
                        }
                    />
                    <Route
                        path="*"
                        element={<Navigate to="/tasks" replace />}
                    />
                </>
            )}
        </Routes>
    );
}

function App() {
    return (
        <ThemeProvider>
            <AuthProvider>
                <AuthQueryBoundary>
                    <AppRoutes />
                </AuthQueryBoundary>
            </AuthProvider>
        </ThemeProvider>
    );
}

export default App;
