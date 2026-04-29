import React, { type ButtonHTMLAttributes, forwardRef } from 'react';
import { usePostHog } from '@posthog/react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'glow' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  trackingEvent?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className = '',
      variant = 'primary',
      size = 'md',
      isLoading = false,
      leftIcon,
      rightIcon,
      children,
      disabled,
      trackingEvent,
      onClick,
      ...props
    },
    ref
  ) => {
    const posthog = usePostHog();

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      if (trackingEvent) {
        posthog?.capture(trackingEvent);
      }
      if (onClick) {
        onClick(e);
      }
    };

    const baseClasses =
      'group relative inline-flex items-center justify-center font-sans font-semibold outline-none transition-all duration-200 ease-out disabled:cursor-not-allowed disabled:opacity-50 overflow-hidden rounded-full';

    const sizeClasses = {
      sm: 'text-xs',
      md: 'text-sm',
      lg: 'text-base',
    };

    const sizeStyles: Record<string, React.CSSProperties> = {
      sm: { padding: '8px 24px', minWidth: '120px' },
      md: { padding: '12px 32px', minWidth: '150px' },
      lg: { padding: '14px 40px', minWidth: '180px' },
    };

    const variantStyles: Record<string, React.CSSProperties> = {
      primary: {
        background: 'var(--accent)',
        color: 'var(--text-inverse)',
      },
      secondary: {
        background: 'var(--bg-elevated)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-muted)',
      },
      ghost: {
        background: 'transparent',
        color: 'var(--text-secondary)',
      },
      glow: {
        background: 'rgba(0,229,153,0.08)',
        color: 'var(--accent)',
        border: '1px solid rgba(0,229,153,0.2)',
      },
      danger: {
        background: 'rgba(255,71,87,0.08)',
        color: 'var(--danger)',
        border: '1px solid rgba(255,71,87,0.2)',
      },
    };

    return (
      <button
        ref={ref}
        className={`${baseClasses} ${sizeClasses[size]} ${className}`}
        style={{ ...variantStyles[variant], ...sizeStyles[size] }}
        disabled={disabled || isLoading}
        onClick={(e: any) => { posthog?.capture('button_action_clicked'); const handler = handleClick; if (typeof handler === 'function') (handler as any)(e); }}
        {...props}
      >
        <span className="relative z-10 inline-flex items-center gap-2.5">
          {isLoading && (
            <svg className="animate-spin h-4 w-4 text-current" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          )}

          {!isLoading && leftIcon && (
            <span className="flex items-center justify-center">{leftIcon}</span>
          )}

          <span className="inline-flex items-center gap-2">{children}</span>

          {!isLoading && rightIcon && (
            <span className="flex items-center justify-center transition-transform group-hover:translate-x-0.5 duration-200">
              {rightIcon}
            </span>
          )}
        </span>
      </button>
    );
  }
);

Button.displayName = 'Button';
