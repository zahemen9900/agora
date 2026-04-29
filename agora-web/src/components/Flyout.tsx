import { useEffect, useRef, useState } from "react";
import { usePostHog } from "@posthog/react";

// ─── Keyframe injection ────────────────────────────────────────────────────────
const FLYOUT_STYLE_ID = "flyout-kf";
function injectFlyoutKeyframes() {
  if (typeof document === "undefined" || document.getElementById(FLYOUT_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = FLYOUT_STYLE_ID;
  s.textContent = `
    @keyframes flyout-slide-in {
      from { opacity: 0; transform: translateX(110%); }
      to   { opacity: 1; transform: translateX(0);    }
    }
    @keyframes flyout-slide-out {
      from { opacity: 1; transform: translateX(0);    }
      to   { opacity: 0; transform: translateX(110%); }
    }
    @keyframes flyout-progress {
      from { width: 100%; }
      to   { width: 0%;   }
    }
    @keyframes flyout-check-draw {
      from { stroke-dashoffset: 48; }
      to   { stroke-dashoffset: 0;  }
    }
    @keyframes flyout-x-draw {
      from { stroke-dashoffset: 24; }
      to   { stroke-dashoffset: 0;  }
    }
    @keyframes flyout-ring-in {
      from { opacity: 0; transform: scale(0.55); }
      to   { opacity: 1; transform: scale(1);    }
    }
  `;
  document.head.appendChild(s);
}

// ─── Animated SVG icon ─────────────────────────────────────────────────────────
function FlyoutIcon({ variant }: { variant: "success" | "error" }) {
  const color = variant === "success" ? "#34d399" : "#f87171";
  return (
    <svg
      width="36"
      height="36"
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0, animation: "flyout-ring-in 0.4s cubic-bezier(0.22,1,0.36,1) 0.05s both" }}
    >
      <circle cx="18" cy="18" r="17" stroke={color} strokeWidth="1.5" strokeOpacity="0.25" />
      <circle cx="18" cy="18" r="13" fill={color} fillOpacity="0.12" />
      {variant === "success" ? (
        <polyline
          points="11,19 16,24 25,13"
          stroke={color}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          strokeDasharray="48"
          strokeDashoffset="48"
          style={{ animation: "flyout-check-draw 0.45s cubic-bezier(0.22,1,0.36,1) 0.2s forwards" }}
        />
      ) : (
        <>
          <line
            x1="13" y1="13" x2="23" y2="23"
            stroke={color} strokeWidth="2.2" strokeLinecap="round"
            strokeDasharray="24" strokeDashoffset="24"
            style={{ animation: "flyout-x-draw 0.35s cubic-bezier(0.22,1,0.36,1) 0.2s forwards" }}
          />
          <line
            x1="23" y1="13" x2="13" y2="23"
            stroke={color} strokeWidth="2.2" strokeLinecap="round"
            strokeDasharray="24" strokeDashoffset="24"
            style={{ animation: "flyout-x-draw 0.35s cubic-bezier(0.22,1,0.36,1) 0.32s forwards" }}
          />
        </>
      )}
    </svg>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────────
export interface FlyoutProps {
  show: boolean;
  variant: "success" | "error";
  title: string;
  body?: string;
  onDismiss: () => void;
  autoDismissMs?: number;
}

export function Flyout({ show, variant, title, body, onDismiss, autoDismissMs = 6000 }: FlyoutProps) {
    const posthog = usePostHog();
  const [visible, setVisible]   = useState(false);
  const [exiting, setExiting]   = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { injectFlyoutKeyframes(); }, []);

  useEffect(() => {
    if (show && !visible && !exiting) {
      setVisible(true);
      timerRef.current = setTimeout(() => handleDismiss(), autoDismissMs);
    }
    if (!show && visible) {
      handleDismiss();
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  function handleDismiss() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setExiting(true);
    setTimeout(() => {
      setVisible(false);
      setExiting(false);
      onDismiss();
    }, 280);
  }

  if (!visible) return null;

  const accentColor = variant === "success" ? "#34d399" : "#f87171";
  const bgColor     = variant === "success" ? "rgba(16,185,129,0.07)" : "rgba(248,113,113,0.07)";
  const borderColor = variant === "success" ? "rgba(52,211,153,0.35)" : "rgba(248,113,113,0.35)";

  return (
    <div
      style={{
        position: "fixed",
        top: "20px",
        right: "20px",
        zIndex: 9999,
        width: "320px",
        background: bgColor,
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: `1px solid ${borderColor}`,
        borderRadius: "14px",
        padding: "14px 14px 0",
        boxShadow: `0 8px 40px rgba(0,0,0,0.45), 0 0 0 1px ${accentColor}18`,
        animation: exiting
          ? "flyout-slide-out 0.28s cubic-bezier(0.55,0,1,0.45) both"
          : "flyout-slide-in 0.36s cubic-bezier(0.22,1,0.36,1) both",
        overflow: "hidden",
      }}
    >
      {/* Content row */}
      <div style={{ display: "flex", gap: "12px", alignItems: "flex-start", paddingBottom: "14px" }}>
        <FlyoutIcon variant={variant} />

        <div style={{ flex: 1, minWidth: 0, paddingTop: "2px" }}>
          <div style={{
            fontFamily: "'Commit Mono', monospace",
            fontSize: "12px",
            fontWeight: 600,
            color: "var(--text-primary)",
            letterSpacing: "0.01em",
            lineHeight: 1.35,
          }}>
            {title}
          </div>
          {body && (
            <div style={{
              fontFamily: "'Commit Mono', monospace",
              fontSize: "10px",
              color: "var(--text-tertiary)",
              marginTop: "4px",
              lineHeight: 1.5,
            }}>
              {body}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={(e: any) => { posthog?.capture('flyout_clicked'); const handler = handleDismiss; if (typeof handler === 'function') (handler as any)(e); }}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
            fontSize: "16px",
            lineHeight: 1,
            padding: "0 2px",
            flexShrink: 0,
            marginTop: "-1px",
          }}
        >
          ×
        </button>
      </div>

      {/* Progress bar */}
      <div style={{ height: "2px", background: `${accentColor}22`, margin: "0 -14px" }}>
        <div
          style={{
            height: "100%",
            background: accentColor,
            animation: `flyout-progress ${autoDismissMs}ms linear both`,
          }}
        />
      </div>
    </div>
  );
}
