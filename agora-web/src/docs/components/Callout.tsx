import { Info, AlertTriangle, Lightbulb, AlertOctagon } from 'lucide-react';
import type { ReactNode, ComponentType } from 'react';

type CalloutType = 'info' | 'warning' | 'tip' | 'danger';

interface CalloutConfig {
  borderColor: string;
  bg: string;
  textColor: string;
  Icon: ComponentType<{ size?: number }>;
  defaultTitle: string;
}

const config: Record<CalloutType, CalloutConfig> = {
  info: {
    borderColor: 'var(--accent-emerald)',
    bg: 'var(--accent-emerald-soft)',
    textColor: 'var(--accent-emerald)',
    Icon: Info,
    defaultTitle: 'Note',
  },
  warning: {
    borderColor: 'var(--accent-amber)',
    bg: 'var(--accent-amber-soft)',
    textColor: 'var(--accent-amber)',
    Icon: AlertTriangle,
    defaultTitle: 'Warning',
  },
  tip: {
    borderColor: 'var(--accent-emerald)',
    bg: 'var(--accent-emerald-soft)',
    textColor: 'var(--accent-emerald)',
    Icon: Lightbulb,
    defaultTitle: 'Tip',
  },
  danger: {
    borderColor: 'var(--accent-rose)',
    bg: 'var(--accent-rose-soft)',
    textColor: 'var(--accent-rose)',
    Icon: AlertOctagon,
    defaultTitle: 'Danger',
  },
};

export interface CalloutProps {
  type?: CalloutType;
  title?: string;
  children: ReactNode;
}

export function Callout({ type = 'info', title, children }: CalloutProps) {
  const { borderColor, bg, textColor, Icon, defaultTitle } = config[type];

  return (
    <div
      className="rounded-r-lg p-4 my-5"
      style={{
        borderLeft: `3px solid ${borderColor}`,
        background: bg,
      }}
    >
      {/* Title row */}
      <div
        className="flex items-center gap-2 font-semibold text-sm mb-1.5"
        style={{ color: textColor }}
      >
        <Icon size={14} />
        <span>{title ?? defaultTitle}</span>
      </div>

      {/* Body */}
      <div
        className="text-sm leading-relaxed"
        style={{ color: 'var(--text-secondary)' }}
      >
        {children}
      </div>
    </div>
  );
}
