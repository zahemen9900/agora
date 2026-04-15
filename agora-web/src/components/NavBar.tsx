import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { LogOut, User as UserIcon } from 'lucide-react';

export function NavBar() {
  const { user, signOut, featureFlags } = useAuth();
  const location = useLocation();

  const isNavActive = (path: string) => {
    if (path === '/' && location.pathname === '/') return true;
    if (path !== '/' && location.pathname.startsWith(path)) return true;
    return false;
  };

  return (
    <nav className="h-14 bg-void border-b border-border-subtle sticky top-0 z-50 flex items-center justify-between px-4 md:px-6">
      <div className="flex items-center w-auto md:w-[200px]">
        <Link 
          to="/" 
          className="wordmark text-xl text-text-primary transition-all duration-200 hover:text-accent hover:drop-shadow-[0_0_20px_rgba(0,212,170,0.25)]"
        >
          AGORA
        </Link>
      </div>

      <div className="hidden md:flex gap-8">
        <Link 
          to="/" 
          className={`font-medium text-sm relative ${isNavActive('/') ? 'text-accent' : 'text-text-secondary'}`}
        >
          Tasks
          {isNavActive('/') && (
             <div className="absolute -bottom-[18px] left-0 right-0 h-[2px] bg-accent shadow-[0_0_20px_rgba(0,212,170,0.15)]" />
          )}
        </Link>
        {featureFlags?.api_keys_visible ? (
          <Link
            to="/api-keys"
            className={`font-medium text-sm relative ${isNavActive('/api-keys') ? 'text-accent' : 'text-text-secondary'}`}
          >
            API Keys
            {isNavActive('/api-keys') && (
              <div className="absolute -bottom-[18px] left-0 right-0 h-[2px] bg-accent shadow-[0_0_20px_rgba(0,212,170,0.15)]" />
            )}
          </Link>
        ) : null}
      </div>

      <div className="flex items-center justify-end w-auto md:w-[200px] gap-4">
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
          <span className="mono text-xs text-text-secondary hidden sm:inline">
            {user?.firstName ?? user?.email ?? "User"}
          </span>
        </div>
        
        <button 
          onClick={signOut}
          className="flex items-center text-text-muted hover:text-text-primary transition-colors p-1"
          title="Sign Out"
        >
          <LogOut size={16} />
        </button>
      </div>
    </nav>
  );
}
