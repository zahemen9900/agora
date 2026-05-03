import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";

import { benchmarkQueryKeys, removeDeletedBenchmarkFromCaches } from "./benchmarkQueries";

test("removeDeletedBenchmarkFromCaches drops user artifact, run, and detail aliases", () => {
  const queryClient = new QueryClient();

  queryClient.setQueryData(benchmarkQueryKeys.detail("run-123"), { benchmark_id: "run-123" });
  queryClient.setQueryData(benchmarkQueryKeys.detail("artifact-123"), { benchmark_id: "artifact-123" });
  queryClient.setQueryData(benchmarkQueryKeys.catalog(25), {
    global_recent: [{ artifact_id: "global-1", scope: "global" }],
    global_frequency: [{ artifact_id: "global-1", scope: "global" }],
    global_tests_recent: [{ run_id: "global-run" }],
    global_tests_frequency: [{ run_id: "global-run" }],
    user_recent: [{ artifact_id: "artifact-123", scope: "user" }, { artifact_id: "artifact-keep", scope: "user" }],
    user_frequency: [{ artifact_id: "artifact-123", scope: "user" }],
    user_tests_recent: [{ run_id: "run-123" }, { run_id: "run-keep" }],
    user_tests_frequency: [{ run_id: "run-123" }],
  });

  removeDeletedBenchmarkFromCaches(queryClient, {
    benchmark_id: "run-123",
    run_id: "run-123",
    artifact_id: "artifact-123",
    scope: "user",
    deleted_at: "2026-05-03T10:00:00Z",
    stopped_before_delete: true,
  });

  assert.equal(queryClient.getQueryData(benchmarkQueryKeys.detail("run-123")), undefined);
  assert.equal(queryClient.getQueryData(benchmarkQueryKeys.detail("artifact-123")), undefined);

  const catalog = queryClient.getQueryData<{
    user_recent: Array<{ artifact_id: string }>;
    user_frequency: Array<{ artifact_id: string }>;
    user_tests_recent: Array<{ run_id: string }>;
    user_tests_frequency: Array<{ run_id: string }>;
    global_recent: Array<{ artifact_id: string }>;
  }>(benchmarkQueryKeys.catalog(25));

  assert.ok(catalog);
  assert.deepEqual(catalog.user_recent.map((entry) => entry.artifact_id), ["artifact-keep"]);
  assert.deepEqual(catalog.user_frequency.map((entry) => entry.artifact_id), []);
  assert.deepEqual(catalog.user_tests_recent.map((entry) => entry.run_id), ["run-keep"]);
  assert.deepEqual(catalog.user_tests_frequency.map((entry) => entry.run_id), []);
  assert.deepEqual(catalog.global_recent.map((entry) => entry.artifact_id), ["global-1"]);
});
