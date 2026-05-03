import test from "node:test";
import assert from "node:assert/strict";

import type { BenchmarkCatalogEntry, BenchmarkRunStatusPayload } from "./api";
import { mergeCatalogArtifactsWithRuns } from "./benchmarkCatalogRows";

function makeArtifact(id: string): BenchmarkCatalogEntry {
  return {
    artifact_id: id,
    scope: "user",
    owner_user_id: "user-1",
    source: "user_triggered",
    created_at: "2026-04-18T01:00:00+00:00",
    run_count: 1,
    mechanism_counts: { vote: 1 },
    model_counts: { "gemini-3-flash-preview": 1 },
    frequency_score: 1,
    status: "completed",
    latest_mechanism: "vote",
    agent_count: 4,
    total_tokens: 100,
    thinking_tokens: 20,
    total_latency_ms: 50,
    models: ["gemini-3-flash-preview"],
    model_telemetry: {},
    cost: null,
  };
}

function makeRun(
  runId: string,
  status: "queued" | "running" | "completed" | "failed",
  artifactId: string | null,
): BenchmarkRunStatusPayload {
  return {
    run_id: runId,
    status,
    created_at: "2026-04-18T01:00:00+00:00",
    updated_at: "2026-04-18T01:05:00+00:00",
    error: status === "failed" ? "boom" : null,
    artifact_id: artifactId,
    request: null,
    reasoning_presets: null,
    tier_model_overrides: null,
    latest_mechanism: status === "failed" ? "debate" : "delphi",
    agent_count: 4,
    total_tokens: 120,
    thinking_tokens: 30,
    total_latency_ms: 80,
    model_telemetry: {},
    cost: null,
    completed_item_count: 0,
    failed_item_count: status === "failed" ? 1 : 0,
    degraded_item_count: 0,
    failure_counts_by_category: {},
    failure_counts_by_reason: {},
    failure_counts_by_stage: {},
  };
}

test("mergeCatalogArtifactsWithRuns prepends unresolved runs and keeps completed artifacts", () => {
  const rows = mergeCatalogArtifactsWithRuns(
    [makeArtifact("artifact-complete")],
    [
      makeRun("run-running", "running", null),
      makeRun("run-failed", "failed", null),
    ],
  );

  assert.deepEqual(
    rows.map((row) => `${row.kind}:${row.kind === "run" ? row.run.run_id : row.entry.artifact_id}`),
    ["run:run-running", "run:run-failed", "artifact:artifact-complete"],
  );
});

test("mergeCatalogArtifactsWithRuns omits completed run duplicates when artifact exists", () => {
  const rows = mergeCatalogArtifactsWithRuns(
    [makeArtifact("artifact-complete")],
    [
      makeRun("run-complete", "completed", "artifact-complete"),
      makeRun("run-no-artifact", "completed", null),
    ],
  );

  assert.deepEqual(
    rows.map((row) => `${row.kind}:${row.kind === "run" ? row.run.run_id : row.entry.artifact_id}`),
    ["run:run-no-artifact", "artifact:artifact-complete"],
  );
});

test("mergeCatalogArtifactsWithRuns tolerates missing artifact and run arrays", () => {
  assert.deepEqual(mergeCatalogArtifactsWithRuns(undefined, undefined), []);
  assert.deepEqual(mergeCatalogArtifactsWithRuns([makeArtifact("artifact-only")], undefined).map((row) => row.kind), ["artifact"]);
  assert.deepEqual(mergeCatalogArtifactsWithRuns(undefined, [makeRun("run-only", "running", null)]).map((row) => row.kind), ["run"]);
});
