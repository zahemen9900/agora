import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronRight, RefreshCcw, Search } from "lucide-react";

import { type BenchmarkCatalogEntry } from "../lib/api";
import { useBenchmarkCatalogQuery } from "../lib/benchmarkQueries";
import { ProviderGlyph } from "../components/ProviderGlyph";
import { providerFromModel, providerTone } from "../lib/modelProviders";

type SortMode = "recent" | "frequency";

export function BenchmarksAll() {
  const navigate = useNavigate();
  const catalogQuery = useBenchmarkCatalogQuery(100);
  const [yourSortMode, setYourSortMode] = useState<SortMode>("recent");
  const [globalSortMode, setGlobalSortMode] = useState<SortMode>("recent");
  const [query, setQuery] = useState("");
  const catalog = catalogQuery.data ?? null;
  const loadError = !catalog && catalogQuery.error instanceof Error
    ? catalogQuery.error.message
    : null;
  const isRefreshing = catalogQuery.isFetching && Boolean(catalog);

  const filterEntries = useCallback((entries: BenchmarkCatalogEntry[]) => {
    const loweredQuery = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (!loweredQuery) {
        return true;
      }

      const modelCandidates = entry.models?.length ? entry.models : Object.keys(entry.model_counts);
      return (
        entry.artifact_id.toLowerCase().includes(loweredQuery)
        || entry.scope.toLowerCase().includes(loweredQuery)
        || modelCandidates.some((model) => model.toLowerCase().includes(loweredQuery))
      );
    });
  }, [query]);

  const yourEntries = useMemo(
    () => filterEntries(catalog ? (yourSortMode === "recent" ? catalog.user_recent : catalog.user_frequency) : []),
    [catalog, filterEntries, yourSortMode],
  );
  const globalEntries = useMemo(
    () => filterEntries(catalog ? (globalSortMode === "recent" ? catalog.global_recent : catalog.global_frequency) : []),
    [catalog, filterEntries, globalSortMode],
  );

  return (
    <div className="max-w-250 mx-auto pb-20 w-full">
      <header className="mb-8">
        <button type="button" onClick={() => navigate("/benchmarks")} className="btn-secondary mb-4 inline-flex items-center gap-2">
          <ArrowLeft size={14} /> Back to overview
        </button>
        <h1 className="text-3xl md:text-4xl mb-4">All Benchmarks</h1>
        <p className="text-text-secondary text-lg max-w-160">
          Browse both personal and global benchmark runs in one place with direct report navigation.
        </p>
      </header>

      <div className="card p-4 sm:p-6 mb-6">
        <div className="flex flex-col lg:flex-row lg:items-end gap-4">
          <label className="block flex-1 max-w-120">
            <div className="mono text-xs text-text-muted mb-2">SEARCH</div>
            <div className="border border-border-subtle rounded-md bg-void px-3 py-2 flex items-center gap-2">
              <Search size={14} className="text-text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-full bg-transparent border-none outline-none text-sm text-text-primary"
                placeholder="artifact id, scope, or model"
              />
            </div>
          </label>

          <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={() => void catalogQuery.refetch()}>
            {isRefreshing ? <RefreshCcw size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
            Refresh
          </button>
        </div>
      </div>

      {loadError ? (
        <div className="card p-6 border border-border-subtle">
          <p className="text-text-secondary">{loadError}</p>
        </div>
      ) : !catalog ? (
        <div className="card p-6 border border-border-subtle">
          <p className="text-text-secondary">Loading benchmark catalog...</p>
        </div>
      ) : yourEntries.length === 0 && globalEntries.length === 0 ? (
        <div className="card p-6 border border-border-subtle">
          <p className="text-text-secondary">No benchmark artifacts match the current filters.</p>
        </div>
      ) : (
        <div className="space-y-6">
          <BenchmarkSection
            title="Your Benchmarks"
            entries={yourEntries}
            sortMode={yourSortMode}
            onSortChange={setYourSortMode}
            onOpen={(artifactId) => navigate(`/benchmarks/${artifactId}`)}
          />
          <BenchmarkSection
            title="Global Benchmarks"
            entries={globalEntries}
            sortMode={globalSortMode}
            onSortChange={setGlobalSortMode}
            onOpen={(artifactId) => navigate(`/benchmarks/${artifactId}`)}
          />
        </div>
      )}
    </div>
  );
}

function BenchmarkSection({
  title,
  entries,
  sortMode,
  onSortChange,
  onOpen,
}: {
  title: string;
  entries: BenchmarkCatalogEntry[];
  sortMode: SortMode;
  onSortChange: (value: SortMode) => void;
  onOpen: (artifactId: string) => void;
}) {
  return (
    <section className="card p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-xl text-text-primary">{title}</h2>
        <div className="inline-flex border border-border-subtle rounded-md overflow-hidden">
          {(["recent", "frequency"] as SortMode[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onSortChange(option)}
              className={`mono px-3 py-1.5 text-xs transition-colors ${
                sortMode === option ? "bg-accent-muted text-accent" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {titleCase(option)}
            </button>
          ))}
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-text-secondary">No matching benchmark artifacts.</p>
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => (
            <button
              key={`${entry.scope}:${entry.artifact_id}`}
              type="button"
              onClick={() => onOpen(entry.artifact_id)}
              className="w-full text-left border border-border-subtle rounded-md px-4 py-4 bg-void hover:border-accent transition-colors"
            >
              <div className="flex flex-wrap gap-2 items-center mb-2">
                <span className="mono text-xs text-text-muted">{entry.artifact_id}</span>
                <span className="badge">{titleCase(entry.scope)}</span>
                {entry.latest_mechanism ? <span className="badge">{titleCase(entry.latest_mechanism)}</span> : null}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-6 gap-2 text-xs text-text-secondary mb-3">
                <div>Runs {formatInt(entry.run_count)}</div>
                <div>Agents {entry.agent_count ?? "n/a"}</div>
                <div>Tokens {formatInt(entry.total_tokens ?? 0)}</div>
                <div>Thinking {formatInt(entry.thinking_tokens ?? 0)}</div>
                <div>Cost {formatUsd(entry.cost?.estimated_cost_usd ?? null)}</div>
                <div>Score {entry.frequency_score.toFixed(2)}</div>
              </div>

              <div className="flex flex-wrap items-center gap-2 mb-2">
                {(entry.models?.length ? entry.models : Object.keys(entry.model_counts)).slice(0, 8).map((model) => {
                  const provider = providerFromModel(model);
                  return (
                    <span
                      key={model}
                      className={`inline-flex items-center gap-1.5 border rounded-full px-2 py-1 mono text-[11px] ${providerTone(provider)}`}
                    >
                      <ProviderGlyph provider={provider} />
                      <span className="truncate max-w-56">{model}</span>
                    </span>
                  );
                })}
              </div>

              <div className="flex items-center justify-between text-xs text-text-muted">
                <span>{formatDateTime(entry.created_at)}</span>
                <span className="inline-flex items-center gap-1">Open report <ChevronRight size={12} /></span>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "n/a";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return "n/a";
  }
  return `$${value.toFixed(6)}`;
}

function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  return Math.round(value).toLocaleString();
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
