import React from "react";

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

export function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: "20px 24px 16px" }}>
      <div style={{ marginBottom: "16px" }}>
        <div style={{
          fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.12em",
          textTransform: "uppercase", color: "var(--text-tertiary)", fontWeight: 600, marginBottom: "4px",
        }}>
          {title}
        </div>
        <div style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "12px", color: "var(--text-muted)" }}>
          {subtitle}
        </div>
      </div>
      {children}
    </div>
  );
}
