import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, X } from "lucide-react";
import type { CitationItemResponse } from "../lib/api.generated";

const FONT = "'Commit Mono', 'SF Mono', monospace";

function extractDomain(item: CitationItemResponse): string {
  if (item.domain) return item.domain;
  if (item.url) {
    try { return new URL(item.url).hostname; } catch { /* fall through */ }
  }
  return item.source_kind ?? "source";
}

// ─── Shared tooltip portal ───────────────────────────────────────────────────
// Renders the tooltip into document.body so it escapes overflow: hidden and
// CSS transform stacking contexts (Framer Motion, canvas transforms, etc.).

interface TooltipPortalProps {
  anchorRect: DOMRect;
  children: React.ReactNode;
}

function TooltipPortal({ anchorRect, children }: TooltipPortalProps) {
  const TOOLTIP_MAX_W = 300;
  const GAP = 8;

  // Position above the anchor; clamp left so it never bleeds off-screen right.
  const left = Math.min(
    anchorRect.left,
    window.innerWidth - TOOLTIP_MAX_W - 8,
  );
  // "bottom" in fixed coords = distance from viewport bottom to where we want
  // the tooltip's bottom edge (= 8px above the anchor's top edge).
  const bottom = window.innerHeight - anchorRect.top + GAP;

  return createPortal(
    <div
      style={{
        position: "fixed",
        bottom,
        left,
        zIndex: 9999,
        maxWidth: TOOLTIP_MAX_W,
        minWidth: 200,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)",
        borderRadius: "12px",
        padding: "12px 14px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
        pointerEvents: "none",
        whiteSpace: "normal",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

// ─── CitationPill ─────────────────────────────────────────────────────────────

export function CitationPill({ item }: { item: CitationItemResponse }) {
  const [hovered, setHovered] = useState(false);
  const [imgErr, setImgErr] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  const domain = extractDomain(item);
  const faviconSrc = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;

  const handleMouseEnter = () => {
    if (anchorRef.current) setAnchorRect(anchorRef.current.getBoundingClientRect());
    setHovered(true);
  };
  const handleMouseLeave = () => { setHovered(false); setAnchorRect(null); };

  const pillContent = (
    <>
      {!imgErr && (
        <img
          src={faviconSrc}
          width={11} height={11}
          style={{ flexShrink: 0, borderRadius: "2px", objectFit: "contain" }}
          onError={() => setImgErr(true)}
          alt=""
        />
      )}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
        {item.title}
      </span>
      {item.url && <ExternalLink size={9} style={{ flexShrink: 0, opacity: 0.45 }} />}
    </>
  );

  const pillStyle: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: "5px",
    height: "26px", padding: "0 8px 0 7px",
    borderRadius: "999px",
    border: "1px solid var(--border-default)",
    background: "var(--bg-base)",
    fontFamily: FONT, fontSize: "10px",
    color: "var(--text-secondary)",
    maxWidth: "200px",
    cursor: item.url ? "pointer" : "default",
    textDecoration: "none",
    transition: "border-color 0.15s ease",
    userSelect: "none",
  };

  return (
    <div
      ref={anchorRef}
      style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {item.url ? (
        <a href={item.url} target="_blank" rel="noreferrer" style={pillStyle}>
          {pillContent}
        </a>
      ) : (
        <div style={pillStyle}>{pillContent}</div>
      )}

      {hovered && anchorRect && (
        <TooltipPortal anchorRect={anchorRect}>
          <div style={{ fontFamily: FONT, fontSize: "11px", color: "var(--text-primary)", marginBottom: "8px", lineHeight: 1.55, wordBreak: "break-word" }}>
            {item.title}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            {!imgErr && (
              <img src={faviconSrc} width={12} height={12} style={{ borderRadius: "2px", objectFit: "contain", flexShrink: 0 }} alt="" />
            )}
            <span style={{ fontFamily: FONT, fontSize: "9px", color: "var(--text-muted)", background: "var(--bg-base)", border: "1px solid var(--border-default)", borderRadius: "4px", padding: "1px 6px" }}>
              {domain}
            </span>
            {typeof item.rank === "number" && (
              <span style={{ fontFamily: FONT, fontSize: "9px", color: "var(--text-muted)" }}>rank {item.rank}</span>
            )}
          </div>
          {item.note && (
            <div style={{ fontFamily: FONT, fontSize: "9px", color: "var(--text-muted)", marginTop: "6px", lineHeight: 1.5 }}>
              {item.note}
            </div>
          )}
        </TooltipPortal>
      )}
    </div>
  );
}

// ─── CitationFaviconBubble ───────────────────────────────────────────────────

function CitationFaviconBubble({
  item, index, total,
}: {
  item: CitationItemResponse;
  index: number;
  total: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [imgErr, setImgErr] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  const domain = extractDomain(item);
  const faviconSrc = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

  const handleMouseEnter = () => {
    if (anchorRef.current) setAnchorRect(anchorRef.current.getBoundingClientRect());
    setHovered(true);
  };
  const handleMouseLeave = () => { setHovered(false); setAnchorRect(null); };

  return (
    <div
      ref={anchorRef}
      style={{
        position: "relative",
        marginLeft: index === 0 ? 0 : "-9px",
        zIndex: hovered ? total + 1 : total - index,
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div style={{
        width: 28, height: 28,
        borderRadius: "50%",
        border: "2px solid var(--bg-elevated)",
        background: "var(--bg-base)",
        display: "flex", alignItems: "center", justifyContent: "center",
        overflow: "hidden",
        cursor: item.url ? "pointer" : "default",
        transform: hovered ? "translateY(-3px) scale(1.08)" : "translateY(0) scale(1)",
        transition: "transform 0.15s ease",
      }}>
        {!imgErr ? (
          <img
            src={faviconSrc}
            width={16} height={16}
            style={{ objectFit: "contain" }}
            onError={() => setImgErr(true)}
            alt=""
          />
        ) : (
          <span style={{ fontFamily: FONT, fontSize: "10px", color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase" }}>
            {domain.charAt(0)}
          </span>
        )}
      </div>

      {hovered && anchorRect && (
        <TooltipPortal anchorRect={anchorRect}>
          <div style={{ fontFamily: FONT, fontSize: "11px", color: "var(--text-primary)", marginBottom: "8px", lineHeight: 1.55, wordBreak: "break-word" }}>
            {item.title}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            {!imgErr && (
              <img src={faviconSrc} width={12} height={12} style={{ borderRadius: "2px", flexShrink: 0 }} alt="" />
            )}
            <span style={{ fontFamily: FONT, fontSize: "9px", color: "var(--text-muted)", background: "var(--bg-base)", border: "1px solid var(--border-default)", borderRadius: "4px", padding: "1px 6px" }}>
              {domain}
            </span>
            {typeof item.rank === "number" && (
              <span style={{ fontFamily: FONT, fontSize: "9px", color: "var(--text-muted)" }}>rank {item.rank}</span>
            )}
          </div>
        </TooltipPortal>
      )}
    </div>
  );
}

// ─── CitationsModal ──────────────────────────────────────────────────────────

const CM_STYLE_ID = "citation-modal-kf";

export function CitationsModal({ items, onClose }: { items: CitationItemResponse[]; onClose: () => void }) {
  useEffect(() => {
    if (document.getElementById(CM_STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = CM_STYLE_ID;
    s.textContent = `
      @keyframes cm-backdrop { from { opacity: 0; } to { opacity: 1; } }
      @keyframes cm-panel {
        from { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
        to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      }
    `;
    document.head.appendChild(s);
  }, []);

  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    document.documentElement.style.overscrollBehavior = "none";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
    };
  }, []);

  return createPortal(
    <>
      {/* Full-viewport backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.6)",
          backdropFilter: "blur(8px)",
          zIndex: 9000,
          animation: "cm-backdrop 0.2s ease both",
        }}
      />
      {/* Centered panel */}
      <div
        role="dialog"
        aria-label="All citations"
        style={{
          position: "fixed",
          top: "50%", left: "50%",
          width: "min(580px, calc(100vw - 32px))",
          maxHeight: "68vh",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-strong)",
          borderRadius: "20px",
          zIndex: 9001,
          display: "flex",
          flexDirection: "column",
          animation: "cm-panel 0.3s cubic-bezier(0.22,1,0.36,1) both",
          boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
          // No overflow: hidden here — tooltips inside need to escape
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 20px",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
          borderRadius: "20px 20px 0 0",
          background: "var(--bg-elevated)",
        }}>
          <div style={{ fontFamily: FONT, fontSize: "10px", letterSpacing: "0.12em", color: "var(--text-muted)", fontWeight: 600 }}>
            CITATIONS{" "}
            <span style={{ color: "var(--accent-emerald)", fontWeight: 400 }}>· {items.length}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              color: "var(--text-muted)", display: "flex", alignItems: "center",
              padding: "4px", borderRadius: "6px",
              transition: "color 0.15s ease",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)"; }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Scrollable content with blur overlays */}
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
          {/* Top blur */}
          <div aria-hidden style={{
            position: "absolute", top: 0, left: 0, right: 0, height: "28px",
            background: "linear-gradient(to bottom, var(--bg-elevated), transparent)",
            zIndex: 2, pointerEvents: "none",
          }} />
          {/* Scroll container */}
          <div
            style={{
              height: "100%",
              overflowY: "auto",
              overscrollBehavior: "contain",
              WebkitOverflowScrolling: "touch",
              padding: "16px 20px",
            }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", paddingTop: "6px", paddingBottom: "6px" }}>
              {items.map((item, i) => (
                <CitationPill key={`${item.title}-${i}`} item={item} />
              ))}
            </div>
          </div>
          {/* Bottom blur */}
          <div aria-hidden style={{
            position: "absolute", bottom: 0, left: 0, right: 0, height: "28px",
            background: "linear-gradient(to top, var(--bg-elevated), transparent)",
            zIndex: 2, pointerEvents: "none",
          }} />
        </div>

        {/* Rounded bottom edge bg — compensates for no overflow:hidden on panel */}
        <div style={{
          height: "20px", flexShrink: 0,
          background: "var(--bg-elevated)",
          borderRadius: "0 0 20px 20px",
          borderTop: "1px solid var(--border-default)",
        }} />
      </div>
    </>,
    document.body,
  );
}

// ─── CitationStack ────────────────────────────────────────────────────────────

export function CitationStack({
  items,
  maxShown = 5,
}: {
  items: CitationItemResponse[];
  maxShown?: number;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  if (items.length === 0) return null;

  const shown = items.slice(0, maxShown);
  const remaining = items.length - maxShown;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          {shown.map((item, i) => (
            <CitationFaviconBubble
              key={`${item.title}-${i}`}
              item={item}
              index={i}
              total={shown.length}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          style={{
            marginLeft: "8px",
            display: "inline-flex", alignItems: "center",
            height: "24px", padding: "0 9px",
            borderRadius: "999px",
            border: "1px solid var(--border-default)",
            background: "var(--bg-base)",
            fontFamily: FONT, fontSize: "10px",
            color: "var(--text-secondary)",
            cursor: "pointer",
            whiteSpace: "nowrap",
            transition: "border-color 0.15s ease, color 0.15s ease",
          }}
          onMouseEnter={(e) => {
            const b = e.currentTarget as HTMLButtonElement;
            b.style.borderColor = "var(--accent-emerald)";
            b.style.color = "var(--accent-emerald)";
          }}
          onMouseLeave={(e) => {
            const b = e.currentTarget as HTMLButtonElement;
            b.style.borderColor = "var(--border-default)";
            b.style.color = "var(--text-secondary)";
          }}
        >
          {remaining > 0 ? `+${remaining} more` : "view all"}
        </button>
      </div>

      {modalOpen && <CitationsModal items={items} onClose={() => setModalOpen(false)} />}
    </>
  );
}
