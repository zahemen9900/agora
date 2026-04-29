import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { usePostHog } from "@posthog/react";

export function ThemeToggle() {
    const posthog = usePostHog();
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={(e: any) => { posthog?.capture('themetoggle_action_clicked'); const handler = toggleTheme; if (typeof handler === 'function') (handler as any)(e); }}
      className="flex items-center justify-center w-8 h-8 rounded-full bg-elevated border border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-muted transition-colors"
      title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
    >
      {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
    </button>
  );
}
