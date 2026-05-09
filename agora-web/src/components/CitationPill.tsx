import { useEffect, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import type { CitationItemResponse } from "../lib/api.generated";

const FONT = "'Commit Mono', 'SF Mono', monospace";

export function CitationPill({ item }: { item: CitationItemResponse }) {
  const [hovered, setHovered] = useState(false);
  const [imgErr, setImgErr] = useState(false);

  const domain =
    item.domain ??
    (item.url
      ? (() => { try { return new URL(item.url!).hostname; } catch { return null; } })()
      : null) ??
    item.source_kind ??
    "source";

  const faviconSrc = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;

  const pillContent = (
    <>
      {!imgErr && (
        <img
          src={faviconSrc}
          width={11}
          height={11}
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
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    height: "26px",
    padding: "0 8px 0 7px",
    borderRadius: "999px",
    border: "1px solid var(--border-default)",
    background: "var(--bg-base)",
    fontFamily: FONT,
    fontSize: "10px",
    color: "var(--text-secondary)",
    maxWidth: "200px",
    cursor: item.url ? "pointer" : "default",
    textDecoration: "none",
    transition: "border-color 0.15s ease, background 0.15s ease",
    userSelect: "none",
  };

  return (
    <div
      style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {item.url ? (
        <a href={item.url} target="_blank" rel="noreferrer" style={pillStyle}>
          {pillContent}
        </a>
      ) : (
        <div style={pillStyle}>{pillContent}</div>
      )}

      {hovered && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: 0,
            zIndex: 300,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-strong)",
            borderRadius: "12px",
            padding: "12px 14px",
            minWidth: "220px",
            maxWidth: "300px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            pointerEvents: "none",
            whiteSpace: "normal",
          }}
        >
          <div style={{ fontFamily: FONT, fontSize: "11px", color: "var(--text-primary)", marginBottom: "8px", lineHeight: 1.55, wordBreak: "break-word" }}>
            {item.title}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            {!imgErr && (
              <img
                src={faviconSrc}
                width={12}
                height={12}
                style={{ borderRadius: "2px", objectFit: "contain", flexShrink: 0 }}
                alt=""
              />
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
        </div>
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

  const domain =
    item.domain ??
    (item.url ? (() => { try { return new URL(item.url!).hostname; } catch { return null; } })() : null) ??
    item.source_kind ??
    "source";
  const faviconSrc = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

  return (
    <div
      style={{
        position: "relative",
        marginLeft: index === 0 ? 0 : "-9px",
        zIndex: hovered ? total + 1 : total - index,
        transition: "z-index 0s",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Circle */}
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

      {/* Hover tooltip */}
      {hovered && (
        <div style={{
          position: "absolute",
          bottom: "calc(100% + 10px)",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 500,
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-strong)",
          borderRadius: "12px",
          padding: "12px 14px",
          minWidth: "220px", maxWidth: "280px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
          pointerEvents: "none",
          whiteSpace: "normal",
        }}>
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
        </div>
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

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.6)",
          backdropFilter: "blur(8px)",
          zIndex: 2000,
          animation: "cm-backdrop 0.2s ease both",
        }}
      />
      {/* Panel */}
      <div
        role="dialog"
        aria-label="All citations"
        style={{
          position: "fixed",
          top: "50%", left: "50%",
          width: "min(560px, calc(100vw - 32px))",
          maxHeight: "68vh",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-strong)",
          borderRadius: "20px",
          zIndex: 2001,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          animation: "cm-panel 0.3s cubic-bezier(0.22,1,0.36,1) both",
          boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 20px",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
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

        {/* Scrollable list with blur edges */}
        <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div aria-hidden style={{ position: "absolute", top: 0, left: 0, right: 0, height: "28px", background: "linear-gradient(to bottom, var(--bg-elevated), transparent)", zIndex: 2, pointerEvents: "none" }} />
          <div style={{ overflowY: "auto", flex: 1, padding: "16px 20px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", paddingTop: "4px", paddingBottom: "4px" }}>
              {items.map((item, i) => (
                <CitationPill key={`${item.title}-${i}`} item={item} />
              ))}
            </div>
          </div>
          <div aria-hidden style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "28px", background: "linear-gradient(to top, var(--bg-elevated), transparent)", zIndex: 2, pointerEvents: "none" }} />
        </div>
      </div>
    </>
  );
}

// ─── CitationStack ───────────────────────────────────────────────────────────

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
        {/* Stacked favicon circles */}
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

        {/* "+N more" / "view all" trigger */}
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