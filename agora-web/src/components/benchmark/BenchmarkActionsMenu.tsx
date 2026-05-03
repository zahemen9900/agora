import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Loader2, MoreHorizontal, Square, Trash2 } from "lucide-react";

import { ConfirmActionModal } from "../ConfirmActionModal";

const FONT = "'Commit Mono', 'SF Mono', monospace";

export interface BenchmarkActionsMenuProps {
  canStop?: boolean;
  canDelete?: boolean;
  isRunning?: boolean;
  isStopping?: boolean;
  isDeleting?: boolean;
  onStop?: () => void;
  onDelete?: () => void;
}

export function BenchmarkActionsMenu({
  canStop = false,
  canDelete = false,
  isRunning = false,
  isStopping = false,
  isDeleting = false,
  onStop,
  onDelete,
}: BenchmarkActionsMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showStopWarning, setShowStopWarning] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setConfirmDelete(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [menuOpen]);

  if (!canStop && !canDelete) {
    return null;
  }

  const handleDeleteIntent = () => {
    if (!canDelete || isDeleting) {
      return;
    }
    if (isRunning) {
      setShowStopWarning(true);
      setMenuOpen(false);
      setConfirmDelete(false);
      return;
    }
    setConfirmDelete(true);
  };

  const handleDeleteConfirm = () => {
    if (!canDelete || isDeleting) {
      return;
    }
    onDelete?.();
    setMenuOpen(false);
    setConfirmDelete(false);
  };

  return (
    <>
      <div
        ref={containerRef}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        style={{ position: "relative", display: "flex", alignItems: "center" }}
      >
        <button
          type="button"
          aria-label="Benchmark actions"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setMenuOpen((current) => !current);
            if (menuOpen) {
              setConfirmDelete(false);
            }
          }}
          style={{
            width: "28px",
            height: "28px",
            borderRadius: "8px",
            display: "grid",
            placeItems: "center",
            border: "1px solid var(--border-default)",
            background: menuOpen ? "var(--bg-elevated)" : "var(--bg-subtle)",
            color: "var(--text-muted)",
            cursor: "pointer",
            transition: "all 0.15s ease",
          }}
        >
          {(isStopping || isDeleting) ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={14} />}
        </button>

        {menuOpen ? (
          <div
            role="menu"
            style={{
              position: "absolute",
              top: "34px",
              right: 0,
              minWidth: "190px",
              padding: "8px",
              borderRadius: "12px",
              border: "1px solid var(--border-strong)",
              background: "rgba(10,14,22,0.96)",
              boxShadow: "0 16px 40px rgba(0,0,0,0.4)",
              zIndex: 40,
              backdropFilter: "blur(12px)",
            }}
          >
            {canStop ? (
              <button
                type="button"
                role="menuitem"
                disabled={isStopping || isDeleting}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onStop?.();
                  setMenuOpen(false);
                  setConfirmDelete(false);
                }}
                style={menuItemStyle({
                  tone: "danger",
                  disabled: isStopping || isDeleting,
                })}
              >
                <Square size={12} />
                <span>{isStopping ? "Stopping benchmark…" : "Stop benchmark"}</span>
              </button>
            ) : null}

            {canDelete ? (
              confirmDelete ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={isDeleting}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    handleDeleteConfirm();
                  }}
                  style={menuItemStyle({
                    tone: "danger",
                    disabled: isDeleting,
                    accent: true,
                  })}
                >
                  <Trash2 size={12} />
                  <span>{isDeleting ? "Deleting benchmark…" : "Confirm delete"}</span>
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  disabled={isDeleting || isStopping}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    handleDeleteIntent();
                  }}
                  style={menuItemStyle({
                    tone: "danger",
                    disabled: isDeleting || isStopping,
                  })}
                >
                  <Trash2 size={12} />
                  <span>Delete benchmark</span>
                </button>
              )
            ) : null}
          </div>
        ) : null}
      </div>

      <ConfirmActionModal
        open={showStopWarning}
        title="Stop before deleting?"
        body="This benchmark is still running. Deleting it will first issue a stop request, then remove your personal benchmark from the catalog. Shared global benchmarks stay untouched."
        confirmLabel={isDeleting ? "Deleting…" : "Stop and delete"}
        cancelLabel="Keep running"
        tone="warning"
        isLoading={isDeleting}
        onCancel={() => setShowStopWarning(false)}
        onConfirm={() => {
          setShowStopWarning(false);
          onDelete?.();
        }}
      />
    </>
  );
}

function menuItemStyle({
  tone,
  disabled,
  accent = false,
}: {
  tone: "default" | "danger";
  disabled: boolean;
  accent?: boolean;
}): CSSProperties {
  const isDanger = tone === "danger";
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "9px",
    border: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    borderRadius: "8px",
    padding: "9px 10px",
    fontFamily: FONT,
    fontSize: "10px",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    background: accent
      ? "rgba(248,113,113,0.14)"
      : isDanger
        ? "rgba(248,113,113,0.06)"
        : "transparent",
    color: isDanger ? "var(--accent-rose)" : "var(--text-secondary)",
    transition: "background 0.15s ease, color 0.15s ease",
  };
}
