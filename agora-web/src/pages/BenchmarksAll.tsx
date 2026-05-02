import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronDown, ChevronRight, Filter, RefreshCcw, Search } from "lucide-react";

import { type BenchmarkCatalogEntry, type BenchmarkRunStatusPayload } from "../lib/api";
import { FailedRunRow, LiveRunRow } from "../components/benchmark/BenchmarkRunRow";
import { benchmarkQueryKeys, useBenchmarkCatalogQuery, useStopBenchmarkMutation } from "../lib/benchmarkQueries";
import { mergeCatalogArtifactsWithRuns, type BenchmarkCatalogListRow } from "../lib/benchmarkCatalogRows";
import { ProviderGlyph } from "../components/ProviderGlyph";
import { providerFromModel } from "../lib/modelProviders";
import { injectChartKeyframes, CHART_FONT, ShimBlock } from "../components/benchmark/ChartCard";
import { usePostHog } from "@posthog/react";

type SortMode = "recent" | "frequency";

// ── Formatters ─────────────────────────────────────────────────────────────────

function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || (v as number) <= 0) return "n/a";
  return `$${(v as number).toFixed(4)}`;
}

function fmtInt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "0";
  return Math.round(v).toLocaleString();
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

// ── Skeleton ───────────────────────────────────────────────────────────────────

function SkeletonBenchmarkCard({ delay = 0 }: { delay?: number }) {
  return (
    <div style={{
      padding: "14px 16px", borderRadius: "12px",
      border: "1px solid var(--border-default)", background: "var(--bg-base)",
    }}>
      {/* Top row: id + badges */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
        <ShimBlock w="6px" h="6px" style={{ borderRadius: "50%", flexShrink: 0 }} />
        <ShimBlock w="220px" h="12px" style={{ animationDelay: `${delay}s` }} />
        <ShimBlock w="52px" h="18px" style={{ borderRadius: "20px", animationDelay: `${delay + 0.05}s` }} />
        <ShimBlock w="52px" h="18px" style={{ borderRadius: "20px", animationDelay: `${delay + 0.08}s` }} />
        <div style={{ marginLeft: "auto" }}>
          <ShimBlock w="80px" h="10px" style={{ animationDelay: `${delay + 0.12}s` }} />
        </div>
      </div>
      {/* Model glyphs row */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        {[0, 1, 2, 3].map((i) => (
          <ShimBlock key={i} w="22px" h="22px" style={{ borderRadius: "6px", animationDelay: `${delay + 0.06 * i}s` }} />
        ))}
        <ShimBlock w="90px" h="10px" style={{ marginLeft: "4px", animationDelay: `${delay + 0.2}s` }} />
      </div>
    </div>
  );
}

// ── Model chips ────────────────────────────────────────────────────────────────

function ModelRow({ models }: { models: string[] }) {
  if (!models.length) return null;
  const shown = models.slice(0, 3);
  const overflow = models.length - shown.length;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
      {/* Overlapping glyph stack */}
      <div style={{ display: "flex", alignItems: "center" }}>
        {shown.map((model, i) => (
          <div key={model} title={model} style={{
            width: "22px", height: "22px", borderRadius: "6px",
            background: "var(--bg-subtle)", border: "1.5px solid var(--bg-base)",
            display: "flex", alignItems: "center", justifyContent: "center",
            marginLeft: i > 0 ? "-6px" : 0, flexShrink: 0,
            position: "relative", zIndex: shown.length - i,
          }}>
            <ProviderGlyph provider={providerFromModel(model)} size={12} />
          </div>
        ))}
      </div>
      {/* Short name of first model */}
      <span style={{ fontFamily: CHART_FONT, fontSize: "10px", color: "var(--text-tertiary)" }}>
        {shown[0]?.replace(/^.*\//, "").replace(/-\d{8}$/, "").slice(0, 24)}
        {shown.length > 1 && ` · ${shown[1]?.replace(/^.*\//, "").replace(/-\d{8}$/, "").slice(0, 20)}`}
      </span>
      {overflow > 0 && (
        <span style={{
          fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.04em",
          color: "var(--text-muted)", padding: "1px 6px", borderRadius: "10px",
          background: "var(--bg-subtle)", border: "1px solid var(--border-default)",
        }}>+{overflow}</span>
      )}
    </div>
  );
}

// ── Badge ──────────────────────────────────────────────────────────────────────

function Chip({ label }: { label: string }) {
  return (
    <span style={{
      fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.06em", textTransform: "uppercase",
      padding: "2px 8px", borderRadius: "20px",
      background: "var(--bg-subtle)", color: "var(--text-tertiary)",
      border: "1px solid var(--border-default)", flexShrink: 0,
    }}>
      {label}
    </span>
  );
}

// ── Card ───────────────────────────────────────────────────────────────────────

function BenchmarkCard({ entry, onOpen }: { entry: BenchmarkCatalogEntry; onOpen: () => void }) {
    const posthog = usePostHog();
  const [hovered, setHovered] = useState(false);
  const models = (entry.models?.length ? entry.models : Object.keys(entry.model_counts));
  const mechanism = Object.keys(entry.mechanism_counts ?? {})[0] ?? entry.latest_mechanism ?? null;
  const shortId = entry.artifact_id.length > 36
    ? `${entry.artifact_id.slice(0, 36)}…`
    : entry.artifact_id;

  return (
    <button
      type="button"
      onClick={(e: any) => { posthog?.capture('benchmarksall_action_clicked'); const handler = onOpen; if (typeof handler === 'function') (handler as any)(e); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: "100%", textAlign: "left", display: "block",
        padding: "14px 16px", borderRadius: "12px",
        border: `1px solid ${hovered ? "var(--border-strong)" : "var(--border-default)"}`,
        background: hovered ? "var(--bg-subtle)" : "var(--bg-base)",
        cursor: "pointer",
        transition: "border-color 0.15s ease, background 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease",
        transform: hovered ? "translateY(-2px)" : "translateY(0)",
        boxShadow: hovered ? "0 6px 20px rgba(0,0,0,0.12)" : "none",
      }}
    >
      {/* Top row */}
      <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "10px", flexWrap: "wrap" }}>
        <span style={{
          display: "inline-block", width: "6px", height: "6px", borderRadius: "50%",
          background: "var(--accent-emerald)", flexShrink: 0,
          opacity: hovered ? 1 : 0.5, transition: "opacity 0.15s ease",
        }} />
        <span style={{
          fontFamily: CHART_FONT, fontSize: "11px",
          color: hovered ? "var(--text-primary)" : "var(--text-secondary)",
          fontWeight: 600, transition: "color 0.15s ease",
        }}>
          {shortId}
        </span>
        {entry.scope && <Chip label={entry.scope} />}
        {mechanism && <Chip label={mechanism} />}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontFamily: CHART_FONT, fontSize: "10px", color: "var(--text-muted)" }}>
            {fmtDate(entry.created_at)}
          </span>
          <ChevronRight
            size={12}
            style={{
              color: hovered ? "var(--accent-emerald)" : "var(--text-muted)",
              transition: "color 0.15s ease, transform 0.15s ease",
              transform: hovered ? "translateX(2px)" : "translateX(0)",
            }}
          />
        </div>
      </div>

      {/* Model row */}
      <ModelRow models={models} />

      {/* Hover-reveal stats strip */}
      <div style={{
        display: "flex", gap: "14px", marginTop: hovered ? "10px" : "0",
        maxHeight: hovered ? "20px" : "0",
        overflow: "hidden",
        opacity: hovered ? 1 : 0,
        transition: "max-height 0.2s ease, opacity 0.2s ease, margin-top 0.2s ease",
      }}>
        {[
          { label: "Runs", value: fmtInt(entry.run_count) },
          { label: "Cost", value: fmtUsd(entry.cost?.estimated_cost_usd ?? null) },
          { label: "Score", value: entry.frequency_score.toFixed(1) },
          { label: "Agents", value: String(entry.agent_count ?? "n/a") },
        ].map(({ label, value }) => (
          <span key={label} style={{ fontFamily: CHART_FONT, fontSize: "9px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
            <span style={{ color: "var(--text-tertiary)" }}>{label} </span>
            <span style={{ color: "var(--text-secondary)" }}>{value}</span>
          </span>
        ))}
      </div>
    </button>
  );
}

// ── Filter dropdown ────────────────────────────────────────────────────────────

function FilterDropdown({ value, onChange }: { value: SortMode; onChange: (v: SortMode) => void }) {
    const posthog = usePostHog();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={(e: any) => { posthog?.capture('benchmarksall_action_clicked'); const handler = () => setOpen((v) => !v); if (typeof handler === 'function') (handler as any)(e); }}
        style={{
          display: "inline-flex", alignItems: "center", gap: "6px",
          fontFamily: CHART_FONT, fontSize: "10px", letterSpacing: "0.05em",
          padding: "5px 10px", borderRadius: "7px",
          border: `1px solid ${open ? "var(--border-strong)" : "var(--border-default)"}`,
          background: open ? "var(--bg-subtle)" : "var(--bg-base)",
          color: "var(--text-secondary)", cursor: "pointer",
          transition: "all 0.15s ease",
        }}
      >
        <Filter size={11} />
        {titleCase(value)}
        <ChevronDown size={11} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s ease" }} />
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 100,
          background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
          borderRadius: "8px", overflow: "hidden", minWidth: "130px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          {(["recent", "frequency"] as SortMode[]).map((option, i) => (
            <button
              key={option}
              type="button"
              onClick={(e: any) => { posthog?.capture('benchmarksall_action_clicked'); const handler = () => { onChange(option); setOpen(false); }; if (typeof handler === 'function') (handler as any)(e); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "9px 13px", fontFamily: CHART_FONT, fontSize: "11px",
                color: value === option ? "var(--accent-emerald)" : "var(--text-secondary)",
                background: value === option ? "var(--accent-emerald-soft)" : "transparent",
                border: "none",
                borderBottom: i === 0 ? "1px solid var(--border-default)" : "none",
                cursor: "pointer", transition: "background 0.1s ease",
              }}
            >
              {titleCase(option)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Section ────────────────────────────────────────────────────────────────────

function BenchmarkSection({
  title, rows, sortMode, onSortChange, onOpen, onStop, isStoppingRunId, isLoading,
}: {
  title: string;
  rows: BenchmarkCatalogListRow[];
  sortMode: SortMode;
  onSortChange: (v: SortMode) => void;
  onOpen: (row: BenchmarkCatalogListRow) => void;
  onStop: (run: BenchmarkRunStatusPayload) => void;
  isStoppingRunId: string | null;
  isLoading: boolean;
}) {
  return (
    <div style={{
      borderRadius: "16px", border: "1px solid var(--border-default)",
      background: "var(--bg-base)", overflow: "hidden",
    }}>
      {/* Section header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px 20px", borderBottom: "1px solid var(--border-default)",
        background: "var(--bg-subtle)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{
            fontFamily: CHART_FONT, fontSize: "11px", letterSpacing: "0.1em",
            textTransform: "uppercase", color: "var(--text-primary)", fontWeight: 600,
          }}>
            {title}
          </span>
          {!isLoading && (
            <span style={{
              fontFamily: CHART_FONT, fontSize: "9px", padding: "1px 7px", borderRadius: "10px",
              background: "var(--bg-elevated)", color: "var(--text-tertiary)",
              border: "1px solid var(--border-default)",
            }}>
              {rows.length}
            </span>
          )}
        </div>
        <FilterDropdown value={sortMode} onChange={onSortChange} />
      </div>

      {/* Body */}
      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: "6px" }}>
        {isLoading ? (
          <>
            <SkeletonBenchmarkCard delay={0} />
            <SkeletonBenchmarkCard delay={0.08} />
            <SkeletonBenchmarkCard delay={0.16} />
          </>
        ) : rows.length === 0 ? (
          <p style={{ fontFamily: CHART_FONT, fontSize: "11px", color: "var(--text-muted)", padding: "16px 0", textAlign: "center" }}>
            No matching benchmark artifacts.
          </p>
        ) : (
          rows.map((row) => {
            if (row.kind === "artifact") {
              const entry = row.entry;
              return (
                <BenchmarkCard
                  key={`${entry.scope}:${entry.artifact_id}`}
                  entry={entry}
                  onOpen={() => onOpen(row)}
                />
              );
            }
            const run = row.run;
            if (run.status === "failed") {
              return (
                <FailedRunRow
                  key={`run:${run.run_id}`}
                  run={run}
                  onOpen={() => onOpen(row)}
                />
              );
            }
            return (
              <LiveRunRow
                key={`run:${run.run_id}`}
                run={run}
                onStop={onStop}
                isStopping={isStoppingRunId === run.run_id}
                onOpen={() => onOpen(row)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export function BenchmarksAll() {
    const posthog = usePostHog();
  useEffect(() => { injectChartKeyframes(); }, []);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const catalogQuery = useBenchmarkCatalogQuery(100);
  const stopBenchmarkMutation = useStopBenchmarkMutation();
  const [yourSortMode, setYourSortMode] = useState<SortMode>("recent");
  const [globalSortMode, setGlobalSortMode] = useState<SortMode>("recent");
  const [query, setQuery] = useState("");
  const catalog = catalogQuery.data ?? null;
  const isLoading = catalogQuery.isLoading;
  const isRefreshing = catalogQuery.isFetching && Boolean(catalog);
  const loadError = !catalog && catalogQuery.error instanceof Error
    ? catalogQuery.error.message
    : null;

  const filterArtifacts = useCallback((entries: BenchmarkCatalogEntry[] | null | undefined) => {
    const safeEntries = Array.isArray(entries) ? entries : [];
    const q = query.trim().toLowerCase();
    if (!q) return safeEntries;
    return safeEntries.filter((e) => {
      const models = e.models?.length ? e.models : Object.keys(e.model_counts);
      return (
        e.artifact_id.toLowerCase().includes(q)
        || e.scope.toLowerCase().includes(q)
        || models.some((m) => m.toLowerCase().includes(q))
      );
    });
  }, [query]);

  const filterRuns = useCallback((runs: BenchmarkRunStatusPayload[] | null | undefined) => {
    const safeRuns = Array.isArray(runs) ? runs : [];
    const q = query.trim().toLowerCase();
    if (!q) return safeRuns;
    return safeRuns.filter((run) => {
      const models = Object.keys(run.model_telemetry ?? {});
      return (
        run.run_id.toLowerCase().includes(q)
        || String(run.status).toLowerCase().includes(q)
        || String(run.latest_mechanism ?? "").toLowerCase().includes(q)
        || models.some((m) => m.toLowerCase().includes(q))
      );
    });
  }, [query]);

  const yourRows = useMemo(
    () => mergeCatalogArtifactsWithRuns(
      filterArtifacts(catalog ? (yourSortMode === "recent" ? catalog.user_recent : catalog.user_frequency) : []),
      filterRuns(catalog ? (yourSortMode === "recent" ? catalog.user_tests_recent : catalog.user_tests_frequency) : []),
    ),
    [catalog, filterArtifacts, filterRuns, yourSortMode],
  );
  const globalRows = useMemo(
    () => mergeCatalogArtifactsWithRuns(
      filterArtifacts(catalog ? (globalSortMode === "recent" ? catalog.global_recent : catalog.global_frequency) : []),
      filterRuns(catalog ? (globalSortMode === "recent" ? catalog.global_tests_recent : catalog.global_tests_frequency) : []),
    ),
    [catalog, filterArtifacts, filterRuns, globalSortMode],
  );

  const handleStopBenchmarkRun = useCallback(async (run: BenchmarkRunStatusPayload) => {
    await stopBenchmarkMutation.mutateAsync(run.run_id);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: benchmarkQueryKeys.catalogAll() }),
      queryClient.invalidateQueries({ queryKey: benchmarkQueryKeys.overviewAll() }),
      queryClient.invalidateQueries({ queryKey: benchmarkQueryKeys.detail(run.run_id) }),
    ]);
  }, [queryClient, stopBenchmarkMutation]);

  return (
    <>
      <title>All Benchmarks — Agora</title>
      <meta
        name="description"
        content="Full catalog of Agora benchmark runs. Compare outcomes across tasks, mechanisms, and model configurations."
      />
      <div className="max-w-250 mx-auto pb-20 w-full">
        {/* Header */}
        <header style={{ marginBottom: "28px" }}>
          <button
            type="button"
            onClick={(e: any) => { posthog?.capture('benchmarksall_benchmarks_clicked'); const handler = () => navigate("/benchmarks"); if (typeof handler === 'function') (handler as any)(e); }}
            style={{
              display: "inline-flex", alignItems: "center", gap: "5px",
              fontFamily: CHART_FONT, fontSize: "9px", letterSpacing: "0.08em",
              textTransform: "uppercase", color: "var(--text-tertiary)",
              background: "none", border: "none", cursor: "pointer", padding: 0,
              marginBottom: "16px", transition: "color 0.15s ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-secondary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
          >
            <ArrowLeft size={12} /> Benchmarks
          </button>
          <h1 style={{
            fontFamily: CHART_FONT, fontSize: "clamp(22px, 4vw, 32px)",
            letterSpacing: "0.05em", textTransform: "uppercase",
            color: "var(--text-primary)", margin: 0, marginBottom: "8px",
          }}>
            All Benchmarks
          </h1>
          <p style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "14px", color: "var(--text-muted)", margin: 0, maxWidth: "560px" }}>
            Browse personal and global benchmark runs in one place.
          </p>
        </header>

        {/* Search + refresh bar */}
        <div style={{
          display: "flex", alignItems: "center", gap: "8px",
          marginBottom: "20px",
          padding: "8px 12px", borderRadius: "10px",
          border: "1px solid var(--border-default)", background: "var(--bg-subtle)",
        }}>
          <Search size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search artifact ID, scope, or model…"
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none",
              fontFamily: CHART_FONT, fontSize: "11px", color: "var(--text-primary)",
              letterSpacing: "0.02em",
            }}
          />
          {query && (
            <button
              type="button"
              onClick={(e: any) => { posthog?.capture('benchmarksall_clicked'); const handler = () => setQuery(""); if (typeof handler === 'function') (handler as any)(e); }}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: "var(--text-muted)", fontFamily: CHART_FONT, fontSize: "10px",
                padding: "0 4px", transition: "color 0.15s",
              }}
            >
              ✕
            </button>
          )}
          <button
            type="button"
            onClick={(e: any) => { posthog?.capture('benchmarksall_refresh_clicked'); const handler = () => void catalogQuery.refetch(); if (typeof handler === 'function') (handler as any)(e); }}
            title="Refresh"
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--text-muted)", padding: "2px", display: "flex", alignItems: "center",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-secondary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <RefreshCcw size={13} style={{ animation: isRefreshing ? "bm-spin 0.8s linear infinite" : "none" }} />
          </button>
        </div>

        {/* Content */}
        {loadError ? (
          <div style={{
            padding: "20px 24px", borderRadius: "12px",
            border: "1px solid var(--border-default)", background: "var(--bg-subtle)",
          }}>
            <p style={{ fontFamily: CHART_FONT, fontSize: "11px", color: "var(--accent-rose)" }}>{loadError}</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <BenchmarkSection
              title="Your Benchmarks"
              rows={yourRows}
              sortMode={yourSortMode}
              onSortChange={setYourSortMode}
              onStop={handleStopBenchmarkRun}
              isStoppingRunId={stopBenchmarkMutation.isPending ? stopBenchmarkMutation.variables ?? null : null}
              onOpen={(row) => navigate(`/benchmarks/${row.kind === "run" ? row.run.run_id : row.entry.artifact_id}`)}
              isLoading={isLoading}
            />
            <BenchmarkSection
              title="Global Benchmarks"
              rows={globalRows}
              sortMode={globalSortMode}
              onSortChange={setGlobalSortMode}
              onStop={handleStopBenchmarkRun}
              isStoppingRunId={stopBenchmarkMutation.isPending ? stopBenchmarkMutation.variables ?? null : null}
              onOpen={(row) => navigate(`/benchmarks/${row.kind === "run" ? row.run.run_id : row.entry.artifact_id}`)}
              isLoading={isLoading}
            />
          </div>
        )}
      </div>
    </>
  );
}
