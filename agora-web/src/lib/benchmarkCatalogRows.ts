import type { BenchmarkCatalogEntry, BenchmarkRunStatusPayload } from "./api";

export type BenchmarkCatalogListRow =
  | { kind: "artifact"; entry: BenchmarkCatalogEntry }
  | { kind: "run"; run: BenchmarkRunStatusPayload };

function shouldShowRunInCatalog(run: BenchmarkRunStatusPayload): boolean {
  if (run.status !== "completed") {
    return true;
  }
  return !run.artifact_id;
}

export function mergeCatalogArtifactsWithRuns(
  artifacts: BenchmarkCatalogEntry[] | null | undefined,
  runs: BenchmarkRunStatusPayload[] | null | undefined,
): BenchmarkCatalogListRow[] {
  const safeArtifacts = Array.isArray(artifacts) ? artifacts : [];
  const safeRuns = Array.isArray(runs) ? runs : [];
  const filteredRuns = safeRuns.filter(shouldShowRunInCatalog);
  const unresolvedArtifactIds = new Set(
    filteredRuns
      .map((run) => run.artifact_id?.trim())
      .filter((value): value is string => Boolean(value)),
  );

  const rows: BenchmarkCatalogListRow[] = [
    ...filteredRuns.map((run) => ({ kind: "run", run }) satisfies BenchmarkCatalogListRow),
    ...safeArtifacts
      .filter((entry) => !unresolvedArtifactIds.has(entry.artifact_id))
      .map((entry) => ({ kind: "artifact", entry }) satisfies BenchmarkCatalogListRow),
  ];

  return rows;
}
