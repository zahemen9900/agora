import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { BenchmarkCatalogEntry, BenchmarkRunStatusPayload } from "../../lib/api";
import { ProviderGlyph } from "../ProviderGlyph";
import { providerFromModel } from "../../lib/modelProviders";

const FONT = "'Commit Mono', 'SF Mono', monospace";
const ROW_KF_ID = "bm-row-kf";

function injectRowKeyframes() {
  if (document.getElementById(ROW_KF_ID)) return;
  const s = document.createElement("style");
  s.id = ROW_KF_ID;
  s.textContent = `
    @keyframes bm-shimmer {
      0%   { background-position: -600px 0; }
      100% { background-position:  600px 0; }
    }
    @keyframes bm-live-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.35; }
    }
  `;
  document.head.appendChild(s);
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "0";
  return Math.round(v).toLocaleString();
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || (v as number) <= 0) return "n/a";
  return `$${(v as number).toFixed(4)}`;
}

function fmtBudgetPerAgent(
  cost: number | null | undefined,
  agentCount: number | null | undefined,
): string {
  if (
    cost == null
    || !Number.isFinite(cost)
    || cost <= 0
    || agentCount == null
    || !Number.isFinite(agentCount)
    || agentCount <= 0
  ) {
    return "n/a";
  }
  return `$${(cost / agentCount).toFixed(4)}`;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function titleCase(v: string): string {
  return v.split(/[_\s-]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

// ── Primitives ─────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const isLive = status === "running" || status === "queued";
  let color = "var(--text-muted)";
  if (status === "running") color = "var(--accent-emerald)";
  else if (status === "queued") color = "var(--accent-amber)";
  else if (status === "failed") color = "var(--accent-rose)";
  return (
    <span style={{
      display: "inline-block", width: "7px", height: "7px", borderRadius: "50%",
      background: color, flexShrink: 0,
      animation: isLive ? "bm-live-pulse 2s ease-in-out infinite" : undefined,
    }} />
  );
}

function StatusBadge({ status }: { status: string }) {
  let bg = "var(--bg-subtle)", color = "var(--text-muted)", border = "var(--border-default)";
  if (status === "running") {
    bg = "var(--accent-emerald-soft)"; color = "var(--accent-emerald)"; border = "rgba(34,211,138,0.35)";
  } else if (status === "queued") {
    bg = "var(--accent-amber-soft)"; color = "var(--accent-amber)"; border = "rgba(251,191,36,0.35)";
  } else if (status === "failed") {
    bg = "var(--accent-rose-soft)"; color = "var(--accent-rose)"; border = "rgba(248,113,113,0.35)";
  }
  return (
    <span style={{
      fontFamily: FONT, fontSize: "9px", letterSpacing: "0.06em", textTransform: "uppercase",
      padding: "1px 7px", borderRadius: "4px",
      background: bg, color, border: `1px solid ${border}`,
    }}>{status}</span>
  );
}

function TagBadge({ label }: { label: string }) {
  return (
    <span style={{
      fontFamily: FONT, fontSize: "9px", letterSpacing: "0.05em", textTransform: "uppercase",
      padding: "1px 7px", borderRadius: "4px",
      background: "var(--bg-subtle)", color: "var(--text-tertiary)",
      border: "1px solid var(--border-default)",
    }}>{label}</span>
  );
}

function ModelCluster({ models }: { models: string[] }) {
  if (!models.length) return null;
  const shown = models.slice(0, 4);
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {shown.map((model, i) => (
        <div key={model} title={model} style={{
          width: "20px", height: "20px", borderRadius: "4px",
          background: "var(--bg-subtle)", border: "1.5px solid var(--bg-elevated)",
          display: "flex", alignItems: "center", justifyContent: "center",
          marginLeft: i > 0 ? "-5px" : 0, flexShrink: 0,
          position: "relative", zIndex: shown.length - i,
        }}>
          <ProviderGlyph provider={providerFromModel(model)} size={11} />
        </div>
      ))}
    </div>
  );
}

function RunShell({
  children, onOpen, accentHex,
}: {
  children: React.ReactNode;
  onOpen: () => void;
  accentHex?: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        width: "100%", textAlign: "left", display: "block",
        padding: "11px 16px", borderRadius: "10px",
        border: `1px solid ${
          hovered
            ? (accentHex ? accentHex : "var(--border-strong)")
            : (accentHex ? `${accentHex}44` : "var(--border-default)")
        }`,
        background: hovered
          ? (accentHex ? `${accentHex}0a` : "var(--bg-subtle)")
          : (accentHex ? `${accentHex}04` : "var(--bg-base)"),
        cursor: "pointer",
        transition: "border-color 0.15s ease, background 0.15s ease",
      }}
    >{children}</div>
  );
}

function StatsRow({ items, action }: { items: { label: string; value: string }[]; action: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", minWidth: 0 }}>
        {items.map((it, i) => (
          <span key={it.label} style={{ fontFamily: FONT, fontSize: "10px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
            {i > 0 && <span style={{ margin: "0 5px", opacity: 0.35 }}>·</span>}
            <span style={{ color: "var(--text-tertiary)" }}>{it.label} </span>
            <span style={{ color: "var(--text-secondary)" }}>{it.value}</span>
          </span>
        ))}
      </div>
      <span style={{
        fontFamily: FONT, fontSize: "10px", color: "var(--text-muted)",
        display: "inline-flex", alignItems: "center", gap: "1px", flexShrink: 0,
      }}>
        {action}<ChevronRight size={10} />
      </span>
    </div>
  );
}

// ── Shimmer / Skeleton ─────────────────────────────────────────────────────────

function ShimBlock({ w, h, radius = "4px", delay = 0 }: { w: string; h: string; radius?: string; delay?: number }) {
  return (
    <div style={{
      width: w, height: h, borderRadius: radius, flexShrink: 0,
      background: "linear-gradient(90deg, var(--bg-base) 0%, var(--border-strong) 40%, var(--bg-base) 80%)",
      backgroundSize: "600px 100%",
      animation: `bm-shimmer 1.8s ease-in-out ${delay}s infinite`,
    }} />
  );
}

export function SkeletonRunRow({ delay = 0 }: { delay?: number }) {
  useEffect(() => { injectRowKeyframes(); }, []);
  return (
    <div style={{
      padding: "11px 16px", borderRadius: "10px",
      border: "1px solid var(--border-default)", background: "var(--bg-base)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <ShimBlock w="7px" h="7px" radius="50%" delay={delay} />
        <ShimBlock w="180px" h="11px" delay={delay + 0.05} />
        <ShimBlock w="48px" h="11px" delay={delay + 0.1} />
        <div style={{ marginLeft: "auto" }}>
          <ShimBlock w="80px" h="10px" delay={delay + 0.15} />
        </div>
      </div>
      <div style={{ display: "flex", gap: "12px" }}>
        <ShimBlock w="90px" h="10px" delay={delay + 0.2} />
        <ShimBlock w="70px" h="10px" delay={delay + 0.25} />
        <ShimBlock w="60px" h="10px" delay={delay + 0.3} />
      </div>
    </div>
  );
}

// ── Public Components ──────────────────────────────────────────────────────────

export function CatalogRunRow({ entry, onOpen }: { entry: BenchmarkCatalogEntry; onOpen: () => void }) {
  useEffect(() => { injectRowKeyframes(); }, []);
  const models = (entry.models?.length ? entry.models : Object.keys(entry.model_telemetry ?? {})).length
    ? (entry.models?.length ? entry.models : Object.keys(entry.model_telemetry ?? {}))
    : Object.keys(entry.model_counts);
  const mechanism = Object.keys(entry.mechanism_counts)[0] ?? entry.latest_mechanism ?? null;
  return (
    <RunShell onOpen={onOpen}>
      <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", flexWrap: "wrap" }}>
        <StatusDot status="completed" />
        <span style={{ fontFamily: FONT, fontSize: "11px", color: "var(--text-primary)", fontWeight: 600 }}>
          {entry.artifact_id.length > 22 ? `${entry.artifact_id.slice(0, 22)}…` : entry.artifact_id}
        </span>
        {entry.scope && <TagBadge label={entry.scope} />}
        {mechanism && <TagBadge label={mechanism} />}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
          <ModelCluster models={models} />
          <span style={{ fontFamily: FONT, fontSize: "10px", color: "var(--text-muted)" }}>{fmtDate(entry.created_at)}</span>
        </div>
      </div>
      <StatsRow
        items={[
          { label: "Runs", value: fmt(entry.run_count) },
          { label: "Thinking", value: fmt(entry.thinking_tokens) },
          { label: "Tokens", value: fmt(entry.total_tokens) },
          { label: "Cost", value: fmtUsd(entry.cost?.estimated_cost_usd) },
          { label: "Budget/Agent", value: fmtBudgetPerAgent(entry.cost?.estimated_cost_usd, entry.agent_count) },
          { label: "Agents", value: String(entry.agent_count ?? "n/a") },
        ]}
        action="Open"
      />
    </RunShell>
  );
}

export function LiveRunRow({
  run,
  onOpen,
  onStop,
  isStopping = false,
}: {
  run: BenchmarkRunStatusPayload;
  onOpen: () => void;
  onStop?: (run: BenchmarkRunStatusPayload) => void;
  isStopping?: boolean;
}) {
  useEffect(() => { injectRowKeyframes(); }, []);
  const isRunning = run.status === "running";
  const accentHex = isRunning ? "#22D38A" : run.status === "queued" ? "#FBBF24" : undefined;
  const models = Object.keys(run.model_telemetry ?? {});
  return (
    <RunShell onOpen={onOpen} accentHex={accentHex}>
      <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", flexWrap: "wrap" }}>
        <StatusDot status={run.status} />
        <span style={{ fontFamily: FONT, fontSize: "11px", color: "var(--text-primary)", fontWeight: 600 }}>
          {run.run_id.length > 22 ? `${run.run_id.slice(0, 22)}…` : run.run_id}
        </span>
        <StatusBadge status={run.status} />
        {run.latest_mechanism && <TagBadge label={titleCase(run.latest_mechanism)} />}
        {isRunning && (
          <span style={{ fontFamily: FONT, fontSize: "9px", color: "var(--accent-emerald)", display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: "var(--accent-emerald)", display: "inline-block", animation: "bm-live-pulse 1.8s ease-in-out infinite" }} />
            live
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
          {onStop && (
            <button
              type="button"
              disabled={isStopping}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onStop(run);
              }}
              style={{
                fontFamily: FONT,
                fontSize: "9px",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "4px 8px",
                borderRadius: "6px",
                border: "1px solid rgba(248,113,113,0.35)",
                background: isStopping ? "rgba(248,113,113,0.08)" : "rgba(248,113,113,0.12)",
                color: "var(--accent-rose)",
                cursor: isStopping ? "progress" : "pointer",
                opacity: isStopping ? 0.8 : 1,
              }}
            >
              {isStopping ? "Stopping…" : "Stop"}
            </button>
          )}
          <ModelCluster models={models} />
          <span style={{ fontFamily: FONT, fontSize: "10px", color: "var(--text-muted)" }}>{fmtDate(run.updated_at)}</span>
        </div>
      </div>
      <StatsRow
        items={[
          { label: "Tokens", value: fmt(run.total_tokens) },
          { label: "Thinking", value: fmt(run.thinking_tokens) },
          { label: "Cost", value: fmtUsd(run.cost?.estimated_cost_usd) },
          { label: "Budget/Agent", value: fmtBudgetPerAgent(run.cost?.estimated_cost_usd, run.agent_count) },
          { label: "Agents", value: String(run.agent_count ?? "n/a") },
        ]}
        action={isRunning ? "Open live view" : "Open queued run"}
      />
    </RunShell>
  );
}

export function FailedRunRow({ run, onOpen }: { run: BenchmarkRunStatusPayload; onOpen: () => void }) {
  useEffect(() => { injectRowKeyframes(); }, []);
  const models = Object.keys(run.model_telemetry ?? {});
  return (
    <RunShell onOpen={onOpen} accentHex="#F87171">
      <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: run.error ? "6px" : "7px", flexWrap: "wrap" }}>
        <StatusDot status="failed" />
        <span style={{ fontFamily: FONT, fontSize: "11px", color: "var(--text-primary)", fontWeight: 600 }}>
          {run.run_id.length > 22 ? `${run.run_id.slice(0, 22)}…` : run.run_id}
        </span>
        <StatusBadge status="failed" />
        {run.latest_mechanism && <TagBadge label={titleCase(run.latest_mechanism)} />}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
          <ModelCluster models={models} />
          <span style={{ fontFamily: FONT, fontSize: "10px", color: "var(--text-muted)" }}>{fmtDate(run.updated_at)}</span>
        </div>
      </div>
      {run.error && (
        <div style={{
          fontFamily: FONT, fontSize: "10px", color: "var(--accent-rose)",
          marginBottom: "7px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {run.error}
        </div>
      )}
      <StatsRow
        items={[
          { label: "Tokens", value: fmt(run.total_tokens) },
          { label: "Thinking", value: fmt(run.thinking_tokens) },
          { label: "Cost", value: fmtUsd(run.cost?.estimated_cost_usd) },
          { label: "Budget/Agent", value: fmtBudgetPerAgent(run.cost?.estimated_cost_usd, run.agent_count) },
          { label: "Agents", value: String(run.agent_count ?? "n/a") },
        ]}
        action="Open failed report"
      />
    </RunShell>
  );
}
