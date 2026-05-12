import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/useAuth";
import { LogOut, Menu, User as UserIcon, X } from "lucide-react";
import { ThemeToggle } from "./ui/ThemeToggle";
import { usePostHog } from "@posthog/react";
import { ConfirmActionModal } from "./ConfirmActionModal";

export function NavBar() {
    const posthog = usePostHog();
    const { user, signOut, featureFlags } = useAuth();
    const location = useLocation();
    const [menuState, setMenuState] = useState({
        isOpen: false,
        pathname: location.pathname,
    });
    const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
    const menuOpen =
        menuState.isOpen && menuState.pathname === location.pathname;
    const canViewBenchmarks = featureFlags?.benchmarks_visible ?? true;
    const canViewApiKeys = featureFlags?.api_keys_visible ?? true;

    const isNavActive = (path: string) =>
        location.pathname === path || location.pathname.startsWith(path + "/");

    return (
        <nav className="bg-void border-b border-border-subtle sticky top-0 z-50">
            <div className="h-14 flex items-center justify-between px-4 md:px-6">
                <div className="flex items-center w-auto md:w-[200px]">
                    <Link
                        to="/"
                        className="wordmark text-xl text-text-primary transition-all duration-200 hover:text-accent hover:drop-shadow-[0_0_20px_rgba(0,229,153,0.3)]"
                    >
                        AGORA
                    </Link>
                </div>

                {/* Desktop nav */}
                <div className="hidden md:flex gap-8">
                    <Link
                        to="/tasks"
                        className={`font-medium text-sm relative ${isNavActive("/tasks") ? "text-accent" : "text-text-secondary"}`}
                    >
                        Tasks
                        {isNavActive("/tasks") && (
                            <div className="absolute -bottom-4.5 left-0 right-0 h-0.5 bg-accent shadow-[0_0_20px_rgba(0,229,153,0.25)]" />
                        )}
                    </Link>
                    {canViewBenchmarks ? (
                        <Link
                            to="/benchmarks"
                            className={`font-medium text-sm relative ${isNavActive("/benchmarks") ? "text-accent" : "text-text-secondary"}`}
                        >
                            Benchmarks
                            {isNavActive("/benchmarks") && (
                                <div className="absolute -bottom-4.5 left-0 right-0 h-0.5 bg-accent shadow-[0_0_20px_rgba(0,229,153,0.25)]" />
                            )}
                        </Link>
                    ) : null}
                    <Link
                        to="/docs"
                        className={`font-medium text-sm relative ${isNavActive("/docs") ? "text-accent" : "text-text-secondary"}`}
                    >
                        Docs
                        {isNavActive("/docs") && (
                            <div className="absolute -bottom-4.5 left-0 right-0 h-0.5 bg-accent shadow-[0_0_20px_rgba(0,229,153,0.25)]" />
                        )}
                    </Link>
                    {canViewApiKeys ? (
                        <Link
                            to="/api-keys"
                            className={`font-medium text-sm relative ${isNavActive("/api-keys") ? "text-accent" : "text-text-secondary"}`}
                        >
                            API Keys
                            {isNavActive("/api-keys") && (
                                <div className="absolute -bottom-4.5 left-0 right-0 h-0.5 bg-accent shadow-[0_0_20px_rgba(0,229,153,0.25)]" />
                            )}
                        </Link>
                    ) : null}
                </div>

                <div className="flex items-center justify-end w-auto md:w-[200px] gap-4">
                    <div className="hidden sm:flex items-center gap-2">
                        {user?.profilePictureUrl ? (
                            <img
                                src={user.profilePictureUrl}
                                alt={user.firstName ?? "User"}
                                className="w-7 h-7 rounded-full border border-border-subtle object-cover"
                            />
                        ) : (
                            <div className="w-7 h-7 rounded-full bg-elevated border border-border-subtle flex items-center justify-center">
                                <UserIcon
                                    size={14}
                                    className="text-text-secondary"
                                />
                            </div>
                        )}
                        <span className="mono text-xs text-text-secondary hidden sm:inline">
                            {user?.firstName ?? user?.email ?? "User"}
                        </span>
                    </div>

                    <button
                        onClick={() => {
                            posthog?.capture("navbar_sign_out_clicked");
                            setShowSignOutConfirm(true);
                        }}
                        className="hidden sm:flex items-center text-text-muted hover:text-text-primary transition-colors p-1"
                        title="Sign Out"
                    >
                        <LogOut size={16} />
                    </button>

                    <ThemeToggle />

                    <button
                        onClick={(e: any) => {
                            posthog?.capture("navbar_action_clicked");
                            const handler = () =>
                                setMenuState(({ isOpen }) => ({
                                    isOpen: !isOpen,
                                    pathname: location.pathname,
                                }));
                            if (typeof handler === "function")
                                (handler as any)(e);
                        }}
                        className="md:hidden flex items-center text-text-secondary hover:text-text-primary transition-colors p-1"
                        aria-label={menuOpen ? "Close menu" : "Open menu"}
                    >
                        {menuOpen ? <X size={20} /> : <Menu size={20} />}
                    </button>
                </div>
            </div>

            {/* Mobile slide-down menu */}
            {menuOpen && (
                <div className="md:hidden border-t border-border-subtle bg-void px-4 py-3 flex flex-col gap-1">
                    <Link
                        to="/tasks"
                        className={`py-2.5 px-3 rounded text-sm font-medium transition-colors ${isNavActive("/tasks") ? "text-accent bg-accent/5" : "text-text-secondary hover:text-text-primary hover:bg-elevated"}`}
                    >
                        Tasks
                    </Link>
                    {canViewBenchmarks && (
                        <Link
                            to="/benchmarks"
                            className={`py-2.5 px-3 rounded text-sm font-medium transition-colors ${isNavActive("/benchmarks") ? "text-accent bg-accent/5" : "text-text-secondary hover:text-text-primary hover:bg-elevated"}`}
                        >
                            Benchmarks
                        </Link>
                    )}
                    <Link
                        to="/docs"
                        className={`py-2.5 px-3 rounded text-sm font-medium transition-colors ${isNavActive("/docs") ? "text-accent bg-accent/5" : "text-text-secondary hover:text-text-primary hover:bg-elevated"}`}
                    >
                        Docs
                    </Link>
                    {canViewApiKeys && (
                        <Link
                            to="/api-keys"
                            className={`py-2.5 px-3 rounded text-sm font-medium transition-colors ${isNavActive("/api-keys") ? "text-accent bg-accent/5" : "text-text-secondary hover:text-text-primary hover:bg-elevated"}`}
                        >
                            API Keys
                        </Link>
                    )}
                    <div className="mt-2 pt-2 border-t border-border-subtle flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            {user?.profilePictureUrl ? (
                                <img
                                    src={user.profilePictureUrl}
                                    alt={user.firstName ?? "User"}
                                    className="w-7 h-7 rounded-full border border-border-subtle object-cover"
                                />
                            ) : (
                                <div className="w-7 h-7 rounded-full bg-elevated border border-border-subtle flex items-center justify-center">
                                    <UserIcon
                                        size={14}
                                        className="text-text-secondary"
                                    />
                                </div>
                            )}
                            <span className="mono text-xs text-text-secondary">
                                {user?.firstName ?? user?.email ?? "User"}
                            </span>
                        </div>
                        <button
                            onClick={() => {
                                posthog?.capture("navbar_sign_out_clicked");
                                setShowSignOutConfirm(true);
                            }}
                            className="flex items-center gap-1.5 text-text-muted hover:text-text-primary transition-colors text-sm py-1 px-2"
                        >
                            <LogOut size={14} />
                            Sign Out
                        </button>
                    </div>
                </div>
            )}

            <ConfirmActionModal
                open={showSignOutConfirm}
                eyebrow="Account"
                title="Sign out?"
                body="You'll be returned to the landing page and will need to sign back in to access your tasks and benchmarks."
                confirmLabel="Sign out"
                cancelLabel="Stay signed in"
                tone="warning"
                onCancel={() => setShowSignOutConfirm(false)}
                onConfirm={() => {
                    setShowSignOutConfirm(false);
                    signOut();
                }}
            />
        </nav>
    );
}
