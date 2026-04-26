import {
  useMutation,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";

import {
  getBenchmarkCatalog,
  getBenchmarkDetail,
  getBenchmarkPromptTemplates,
  getBenchmarks,
  triggerBenchmarkRun,
  type BenchmarkCatalogEntry,
  type BenchmarkCatalogPayload,
  type BenchmarkDetailPayload,
  type BenchmarkPromptTemplatesPayload,
  type BenchmarkRunRequestPayload,
  type BenchmarkRunResponsePayload,
  type BenchmarkRunStatusPayload,
} from "./api";
import { useAuth } from "./useAuth";

export const benchmarkQueryKeys = {
  all: ["benchmarks"] as const,
  overviewAll: () => [...benchmarkQueryKeys.all, "overview"] as const,
  overview: (includeDemo = true) => [
    ...benchmarkQueryKeys.overviewAll(),
    includeDemo ? "include-demo" : "no-demo",
  ] as const,
  catalogAll: () => [...benchmarkQueryKeys.all, "catalog"] as const,
  catalog: (limit: number) => [...benchmarkQueryKeys.catalogAll(), limit] as const,
  promptTemplates: () => [...benchmarkQueryKeys.all, "prompt-templates"] as const,
  detail: (benchmarkId: string) => [...benchmarkQueryKeys.all, "detail", benchmarkId] as const,
};

function benchmarkDetailAliases(
  detail: BenchmarkDetailPayload,
  requestedId?: string,
): string[] {
  return Array.from(
    new Set(
      [requestedId, detail.benchmark_id, detail.artifact_id, detail.run_id]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
    ),
  );
}

function sortRunsByUpdatedAt(runs: BenchmarkRunStatusPayload[]): BenchmarkRunStatusPayload[] {
  return [...runs].sort(
    (left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime(),
  );
}

function sortCatalogEntriesByRecent(entries: BenchmarkCatalogEntry[]): BenchmarkCatalogEntry[] {
  return [...entries].sort(
    (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime(),
  );
}

function sortCatalogEntriesByFrequency(entries: BenchmarkCatalogEntry[]): BenchmarkCatalogEntry[] {
  return [...entries].sort((left, right) => {
    if (right.frequency_score !== left.frequency_score) {
      return right.frequency_score - left.frequency_score;
    }
    return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
  });
}

function upsertRunStatus(
  runs: BenchmarkRunStatusPayload[],
  nextRun: BenchmarkRunStatusPayload,
): BenchmarkRunStatusPayload[] {
  const next = runs.filter((entry) => entry.run_id !== nextRun.run_id);
  next.unshift(nextRun);
  return sortRunsByUpdatedAt(next);
}

function upsertCatalogEntry(
  entries: BenchmarkCatalogEntry[],
  nextEntry: BenchmarkCatalogEntry,
  sortMode: "recent" | "frequency",
): BenchmarkCatalogEntry[] {
  const next = entries.filter((entry) => entry.artifact_id !== nextEntry.artifact_id);
  next.unshift(nextEntry);
  return sortMode === "recent"
    ? sortCatalogEntriesByRecent(next)
    : sortCatalogEntriesByFrequency(next);
}

function toBenchmarkRunStatusSnapshot(
  detail: BenchmarkDetailPayload,
): BenchmarkRunStatusPayload | null {
  if (!detail.run_id) {
    return null;
  }

  return {
    run_id: detail.run_id,
    status: detail.status === "queued" || detail.status === "running" || detail.status === "failed"
      ? detail.status
      : "completed",
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    error:
      detail.status === "failed"
        ? String(detail.failure_counts_by_reason?.stream ?? detail.active_item?.failure_reason ?? "")
        : null,
    artifact_id: detail.artifact_id,
    request: detail.request,
    reasoning_presets: detail.reasoning_presets,
    tier_model_overrides: detail.tier_model_overrides,
    latest_mechanism: detail.latest_mechanism,
    agent_count: detail.agent_count,
    total_tokens: detail.total_tokens,
    thinking_tokens: detail.thinking_tokens,
    total_latency_ms: detail.total_latency_ms,
    model_telemetry: detail.model_telemetry,
    cost: detail.cost,
    completed_item_count: detail.completed_item_count,
    failed_item_count: detail.failed_item_count,
    degraded_item_count: detail.degraded_item_count,
    failure_counts_by_category: detail.failure_counts_by_category,
    failure_counts_by_reason: detail.failure_counts_by_reason,
    failure_counts_by_stage: detail.failure_counts_by_stage,
  };
}

function toBenchmarkCatalogEntrySnapshot(
  detail: BenchmarkDetailPayload,
): BenchmarkCatalogEntry | null {
  if (!detail.artifact_id) {
    return null;
  }

  return {
    artifact_id: detail.artifact_id,
    scope: detail.scope,
    owner_user_id: detail.owner_user_id,
    source: detail.source,
    created_at: detail.created_at,
    run_count: detail.run_count,
    mechanism_counts: detail.mechanism_counts,
    model_counts: detail.model_counts,
    frequency_score: detail.frequency_score,
    status: detail.status,
    latest_mechanism: detail.latest_mechanism,
    agent_count: detail.agent_count,
    total_tokens: detail.total_tokens,
    thinking_tokens: detail.thinking_tokens,
    total_latency_ms: detail.total_latency_ms,
    models: detail.models,
    model_telemetry: detail.model_telemetry,
    cost: detail.cost,
  };
}

function syncCatalogPayloadWithRunStatus(
  catalog: BenchmarkCatalogPayload,
  runStatus: BenchmarkRunStatusPayload,
): BenchmarkCatalogPayload {
  return {
    ...catalog,
    user_tests_recent: upsertRunStatus(catalog.user_tests_recent, runStatus),
    user_tests_frequency: upsertRunStatus(catalog.user_tests_frequency, runStatus),
  };
}

function syncCatalogPayloadWithDetail(
  catalog: BenchmarkCatalogPayload,
  detail: BenchmarkDetailPayload,
): BenchmarkCatalogPayload {
  let nextCatalog = catalog;
  const runSnapshot = detail.scope === "user" ? toBenchmarkRunStatusSnapshot(detail) : null;
  if (runSnapshot) {
    nextCatalog = syncCatalogPayloadWithRunStatus(nextCatalog, runSnapshot);
  }

  const entrySnapshot = toBenchmarkCatalogEntrySnapshot(detail);
  if (!entrySnapshot) {
    return nextCatalog;
  }

  const updateScopeLists = (
    recentEntries: BenchmarkCatalogEntry[],
    frequencyEntries: BenchmarkCatalogEntry[],
  ) => ({
    recent: upsertCatalogEntry(recentEntries, entrySnapshot, "recent"),
    frequency: upsertCatalogEntry(frequencyEntries, entrySnapshot, "frequency"),
  });

  if (detail.scope === "global") {
    const next = updateScopeLists(nextCatalog.global_recent, nextCatalog.global_frequency);
    return {
      ...nextCatalog,
      global_recent: next.recent,
      global_frequency: next.frequency,
    };
  }

  const next = updateScopeLists(nextCatalog.user_recent, nextCatalog.user_frequency);
  return {
    ...nextCatalog,
    user_recent: next.recent,
    user_frequency: next.frequency,
  };
}

export function setBenchmarkDetailCache(
  queryClient: QueryClient,
  detail: BenchmarkDetailPayload,
  requestedId?: string,
): void {
  for (const alias of benchmarkDetailAliases(detail, requestedId)) {
    queryClient.setQueryData(benchmarkQueryKeys.detail(alias), detail);
  }
  syncBenchmarkCatalogCache(queryClient, detail);
}

export function patchBenchmarkDetailCache(
  queryClient: QueryClient,
  benchmarkId: string,
  updater: (current: BenchmarkDetailPayload | undefined) => BenchmarkDetailPayload | undefined,
): void {
  let nextValue: BenchmarkDetailPayload | undefined;
  queryClient.setQueryData<BenchmarkDetailPayload | undefined>(
    benchmarkQueryKeys.detail(benchmarkId),
    (current) => {
      nextValue = updater(current);
      return nextValue;
    },
  );

  if (!nextValue) {
    return;
  }

  for (const alias of benchmarkDetailAliases(nextValue, benchmarkId)) {
    if (alias === benchmarkId) {
      continue;
    }
    queryClient.setQueryData(benchmarkQueryKeys.detail(alias), nextValue);
  }
  syncBenchmarkCatalogCache(queryClient, nextValue);
}

export function syncBenchmarkCatalogCache(
  queryClient: QueryClient,
  detail: BenchmarkDetailPayload,
): void {
  queryClient.setQueriesData<BenchmarkCatalogPayload | undefined>(
    { queryKey: benchmarkQueryKeys.catalogAll() },
    (current) => {
      if (!current) {
        return current;
      }
      return syncCatalogPayloadWithDetail(current, detail);
    },
  );
}

export function seedTriggeredBenchmarkRunCache(
  queryClient: QueryClient,
  run: BenchmarkRunResponsePayload,
): void {
  const seededRun: BenchmarkRunStatusPayload = {
    run_id: run.run_id,
    status: run.status,
    created_at: run.created_at,
    updated_at: run.created_at,
    error: null,
    artifact_id: null,
    request: null,
    reasoning_presets: null,
    tier_model_overrides: null,
    latest_mechanism: null,
    agent_count: null,
    total_tokens: null,
    thinking_tokens: null,
    total_latency_ms: null,
    model_telemetry: {},
    cost: null,
    completed_item_count: 0,
    failed_item_count: 0,
    degraded_item_count: 0,
    failure_counts_by_category: {},
    failure_counts_by_reason: {},
    failure_counts_by_stage: {},
  };

  queryClient.setQueriesData<BenchmarkCatalogPayload | undefined>(
    { queryKey: benchmarkQueryKeys.catalogAll() },
    (current) => {
      if (!current) {
        return current;
      }
      return syncCatalogPayloadWithRunStatus(current, seededRun);
    },
  );
}

export function useBenchmarkOverviewQuery(includeDemo = true) {
  const { authStatus, getAccessToken } = useAuth();

  return useQuery({
    queryKey: benchmarkQueryKeys.overview(includeDemo),
    enabled: authStatus === "authenticated",
    queryFn: async () => {
      const token = await getAccessToken();
      return getBenchmarks(token, includeDemo);
    },
  });
}

export function useBenchmarkCatalogQuery(limit = 25) {
  const { authStatus, getAccessToken } = useAuth();

  return useQuery({
    queryKey: benchmarkQueryKeys.catalog(limit),
    enabled: authStatus === "authenticated",
    queryFn: async () => {
      const token = await getAccessToken();
      return getBenchmarkCatalog(token, limit);
    },
  });
}

export function useBenchmarkPromptTemplatesQuery() {
  const { authStatus, getAccessToken } = useAuth();

  return useQuery({
    queryKey: benchmarkQueryKeys.promptTemplates(),
    enabled: authStatus === "authenticated",
    queryFn: async (): Promise<BenchmarkPromptTemplatesPayload> => {
      const token = await getAccessToken();
      return getBenchmarkPromptTemplates(token);
    },
  });
}

export function useBenchmarkDetailQuery(benchmarkId: string | undefined) {
  const { authStatus, getAccessToken } = useAuth();

  return useQuery({
    queryKey: benchmarkId ? benchmarkQueryKeys.detail(benchmarkId) : [...benchmarkQueryKeys.all, "detail", "missing"],
    enabled: authStatus === "authenticated" && Boolean(benchmarkId),
    queryFn: async () => {
      if (!benchmarkId) {
        throw new Error("Benchmark id is required");
      }
      const token = await getAccessToken();
      return getBenchmarkDetail(token, benchmarkId);
    },
  });
}

export function useTriggerBenchmarkMutation() {
  const { getAccessToken } = useAuth();

  return useMutation<BenchmarkRunResponsePayload, Error, BenchmarkRunRequestPayload>({
    mutationFn: async (payload) => {
      const token = await getAccessToken();
      if (!token) {
        throw new Error("Authentication token is unavailable.");
      }
      return triggerBenchmarkRun(token, payload);
    },
  });
}
