import React, { useState } from "react";

export const CHART_FONT = "'Commit Mono', 'SF Mono', monospace";
export const CHART_KF_ID = "bm-chart-kf";

export function injectChartKeyframes() {
  if (document.getElementById(CHART_KF_ID)) return;
  const s = document.createElement("style");
  s.id = CHART_KF_ID;
  s.textContent = `@keyframes bm-shimmer { 0% { background-position: -600px 0; } 100% { background-position: 600px 0; } } @keyframes bm-spin { to { transform: rotate(360deg); } } @keyframes hm-fade-in { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }`;
  document.head.appendChild(s);
}

export function SkeletonChartBlock({ h, delay = 0 }: { h: string; delay?: number }) {
  return (
    <div style={{
      width: "100%", height: h, borderRadius: "8px",
      background: "linear-gradient(90deg, var(--bg-base) 0%, var(--border-strong) 40%, var(--bg-base) 80%)",
      backgroundSize: "600px 100%",
      animation: `bm-shimmer 1.8s ease-in-out ${delay}s infinite`,
    }} />
  );
}

export function ShimBlock({ w, h, style }: { w: string; h: string; style?: React.CSSProperties }) {
  return (
    <div style={{
      width: w, height: h, borderRadius: "6px",
      background: "linear-gradient(90deg, var(--bg-base) 0%, var(--border-strong) 40%, var(--bg-base) 80%)",
      backgroundSize: "600px 100%",
      animation: "bm-shimmer 1.8s ease-in-out infinite",
      flexShrink: 0,
      ...style,
    }} />
  );
}

// ── Info Tooltip ───────────────────────────────────────────────────────────────

export function InfoTooltip({ text }: { text: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        type="button"
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        aria-label="Chart explanation"
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: "14px", height: "14px", borderRadius: "50%",
          border: `1px solid ${visible ? "var(--accent-emerald)" : "var(--border-strong)"}`,
          background: visible ? "rgba(52,211,153,0.12)" : "transparent",
          color: visible ? "var(--accent-emerald)" : "var(--text-muted)",
          fontFamily: CHART_FONT, fontSize: "8px", fontWeight: 700,
          cursor: "default", padding: 0, lineHeight: 1,
          transition: "border-color 0.15s ease, color 0.15s ease, background 0.15s ease",
          flexShrink: 0,
        }}
      >
        ?
      </button>

      {visible && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: "50%",
          transform: "translateX(-50%)",
          width: "240px", padding: "10px 13px",
          background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
          borderRadius: "8px", zIndex: 9999,
          boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          pointerEvents: "none",
          fontFamily: "'Hanken Grotesk', sans-serif",
          fontSize: "11px", color: "var(--text-secondary)", lineHeight: 1.6,
        }}>
          {text}
        </div>
      )}
    </span>
  );
}

// ── Chart Card ─────────────────────────────────────────────────────────────────

export function ChartCard({
  title, subtitle, tooltip, children,
}: {
  title: string;
  subtitle: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ padding: "20px 24px 16px" }}>
      <div style={{ marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
          <span style={{
            fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.12em",
            textTransform: "uppercase", color: "var(--text-tertiary)", fontWeight: 600,
          }}>
            {title}
          </span>
          {tooltip && <InfoTooltip text={tooltip} />}
        </div>
        <div style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "12px", color: "var(--text-muted)" }}>
          {subtitle}
        </div>
      </div>
      {children}
    </div>
  );
}