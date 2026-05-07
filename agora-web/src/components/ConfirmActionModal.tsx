import { useEffect } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { Button } from "./ui/Button";

const MODAL_KF_ID = "confirm-action-modal-kf";

function injectModalKeyframes() {
  if (typeof document === "undefined" || document.getElementById(MODAL_KF_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = MODAL_KF_ID;
  style.textContent = `
    @keyframes confirm-modal-backdrop-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes confirm-modal-panel-in {
      from { opacity: 0; transform: translateY(16px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes confirm-modal-sheen {
      0% { transform: translateX(-130%) rotate(12deg); opacity: 0; }
      35% { opacity: 0.16; }
      100% { transform: translateX(130%) rotate(12deg); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

export interface ConfirmActionModalProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  eyebrow?: string;
  tone?: "warning" | "danger";
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmActionModal({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  eyebrow = "Confirm action",
  tone = "warning",
  isLoading = false,
  onConfirm,
  onCancel,
}: ConfirmActionModalProps) {
  useEffect(() => {
    injectModalKeyframes();
  }, []);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isLoading) {
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isLoading, onCancel, open]);

  if (!open) {
    return null;
  }

  const accentColor = tone === "danger" ? "rgba(248,113,113,0.92)" : "rgba(251,191,36,0.92)";
  const iconColor = tone === "danger" ? "var(--accent-rose)" : "var(--accent-amber)";
  const panelBorder = tone === "danger" ? "rgba(248,113,113,0.32)" : "rgba(251,191,36,0.26)";
  const panelGlow = tone === "danger" ? "rgba(248,113,113,0.10)" : "rgba(251,191,36,0.10)";

  return (
    <div
      aria-modal="true"
      role="dialog"
      onClick={() => {
        if (!isLoading) {
          onCancel();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(10px)",
        animation: "confirm-modal-backdrop-in 160ms ease-out both",
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "relative",
          width: "min(100%, 520px)",
          borderRadius: "18px",
          overflow: "hidden",
          border: `1px solid ${panelBorder}`,
          background: "var(--bg-elevated)",
          boxShadow: `0 30px 90px rgba(0,0,0,0.3), 0 0 0 1px ${panelGlow}`,
          animation: "confirm-modal-panel-in 220ms cubic-bezier(0.22,1,0.36,1) both",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -40,
            left: -80,
            width: "220px",
            height: "180px",
            background: `linear-gradient(90deg, transparent 0%, ${accentColor} 50%, transparent 100%)`,
            filter: "blur(18px)",
            animation: "confirm-modal-sheen 900ms ease-out both",
            pointerEvents: "none",
          }}
        />
        <div style={{ padding: "24px 24px 20px", position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "14px", marginBottom: "14px" }}>
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "12px",
                border: `1px solid ${panelBorder}`,
                background: "var(--bg-subtle)",
                display: "grid",
                placeItems: "center",
                color: iconColor,
                flexShrink: 0,
              }}
            >
              <AlertTriangle size={18} />
            </div>
            <div>
              <div
                style={{
                  fontFamily: "'Commit Mono', monospace",
                  fontSize: "11px",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--text-tertiary)",
                  marginBottom: "4px",
                }}
              >
                {eyebrow}
              </div>
              <h3
                style={{
                  margin: 0,
                  fontFamily: "'Commit Mono', monospace",
                  fontSize: "18px",
                  lineHeight: 1.2,
                  color: "var(--text-primary)",
                }}
              >
                {title}
              </h3>
            </div>
          </div>
          <p
            style={{
              margin: 0,
              fontFamily: "'Hanken Grotesk', sans-serif",
              fontSize: "15px",
              lineHeight: 1.6,
              color: "var(--text-secondary)",
            }}
          >
            {body}
          </p>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
            padding: "0 24px 24px",
          }}
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isLoading}
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === "danger" ? "danger" : "glow"}
            size="sm"
            disabled={isLoading}
            onClick={onConfirm}
            leftIcon={isLoading ? <Loader2 size={14} className="animate-spin" /> : undefined}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
