import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { LogOut, Menu, User as UserIcon, X } from 'lucide-react';

export function NavBar() {
  const { user, signOut, featureFlags } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const canViewBenchmarks = featureFlags?.benchmarks_visible ?? true;
  const canViewApiKeys = featureFlags?.api_keys_visible ?? true;

  // Close mobile menu on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const isNavActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  return (
    <nav className="bg-void border-b border-border-subtle sticky top-0 z-50">
      <div className="h-14 flex items-center justify-between px-4 md:px-6">
        <div className="flex items-center w-auto md:w-[200px]">
          <Link
            to="/"
            className="wordmark text-xl text-text-primary transition-all duration-200 hover:text-accent hover:drop-shadow-[0_0_20px_rgba(0,212,170,0.25)]"
          >
            AGORA
          </Link>
        </div>

        {/* Desktop nav */}
        <div className="hidden md:flex gap-8">
          <Link
            to="/tasks"
            className={`font-medium text-sm relative ${isNavActive('/tasks') ? 'text-accent' : 'text-text-secondary'}`}
          >
            Tasks
            {isNavActive('/tasks') && (
               <div className="absolute -bottom-4.5 left-0 right-0 h-0.5 bg-accent shadow-[0_0_20px_rgba(0,212,170,0.15)]" />
            )}
          </Link>
          {canViewBenchmarks ? (
            <Link
              to="/benchmarks"
              className={`font-medium text-sm relative ${isNavActive('/benchmarks') ? 'text-accent' : 'text-text-secondary'}`}
            >
              Benchmarks
              {isNavActive('/benchmarks') && (
                <div className="absolute -bottom-4.5 left-0 right-0 h-0.5 bg-accent shadow-[0_0_20px_rgba(0,212,170,0.15)]" />
              )}
            </Link>
          ) : null}
          {canViewApiKeys ? (
            <Link
              to="/api-keys"
              className={`font-medium text-sm relative ${isNavActive('/api-keys') ? 'text-accent' : 'text-text-secondary'}`}
            >
              API Keys
              {isNavActive('/api-keys') && (
                <div className="absolute -bottom-4.5 left-0 right-0 h-0.5 bg-accent shadow-[0_0_20px_rgba(0,212,170,0.15)]" />
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
                <UserIcon size={14} className="text-text-secondary" />
              </div>
            )}
            <span className="mono text-xs text-text-secondary hidden sm:inline">
              {user?.firstName ?? user?.email ?? "User"}
            </span>
          </div>

          <button
            onClick={signOut}
            className="hidden sm:flex items-center text-text-muted hover:text-text-primary transition-colors p-1"
            title="Sign Out"
          >
            <LogOut size={16} />
          </button>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMenuOpen(o => !o)}
            className="md:hidden flex items-center text-text-secondary hover:text-text-primary transition-colors p-1"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
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
            className={`py-2.5 px-3 rounded text-sm font-medium transition-colors ${isNavActive('/tasks') ? 'text-accent bg-accent/5' : 'text-text-secondary hover:text-text-primary hover:bg-elevated'}`}
          >
            Tasks
          </Link>
          {canViewBenchmarks && (
            <Link
              to="/benchmarks"
              className={`py-2.5 px-3 rounded text-sm font-medium transition-colors ${isNavActive('/benchmarks') ? 'text-accent bg-accent/5' : 'text-text-secondary hover:text-text-primary hover:bg-elevated'}`}
            >
              Benchmarks
            </Link>
          )}
          {canViewApiKeys && (
            <Link
              to="/api-keys"
              className={`py-2.5 px-3 rounded text-sm font-medium transition-colors ${isNavActive('/api-keys') ? 'text-accent bg-accent/5' : 'text-text-secondary hover:text-text-primary hover:bg-elevated'}`}
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
                  <UserIcon size={14} className="text-text-secondary" />
                </div>
              )}
              <span className="mono text-xs text-text-secondary">
                {user?.firstName ?? user?.email ?? "User"}
              </span>
            </div>
            <button
              onClick={signOut}
              className="flex items-center gap-1.5 text-text-muted hover:text-text-primary transition-colors text-sm py-1 px-2"
            >
              <LogOut size={14} />
              Sign Out
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}
