import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDetailMechanismRows,
  buildDetailStageRows,
  buildOverviewLearningCurve,
  detectBenchmarkArtifactKind,
  normalizeBenchmarkSummary,
} from "./benchmarkMetrics";

test("detectBenchmarkArtifactKind distinguishes validation and comparison artifacts", () => {
  assert.equal(
    detectBenchmarkArtifactKind({
      pre_learning: { summary: { per_mode: {} } },
      post_learning: { summary: { per_mode: {} } },
    }),
    "validation",
  );

  assert.equal(
    detectBenchmarkArtifactKind({
      summary: { per_mode: { selector: { accuracy: 1 } } },
      runs: [{ mode: "selector" }],
    }),
    "comparison",
  );
});

test("buildOverviewLearningCurve suppresses fake values for comparison artifacts", () => {
  const learningCurve = buildOverviewLearningCurve({
    summary: { per_mode: { selector: { accuracy: 1 } } },
    runs: [{ mode: "selector" }],
  });

  assert.equal(learningCurve.available, false);
  assert.match(learningCurve.reason ?? "", /comparison artifact/i);
});

test("buildOverviewLearningCurve emits real pre/post values for validation artifacts", () => {
  const learningCurve = buildOverviewLearningCurve({
    pre_learning: { summary: { per_mode: { selector: { accuracy: 0.25 } } } },
    post_learning: { summary: { per_mode: { selector: { accuracy: 0.75 } } } },
  });

  assert.equal(learningCurve.available, true);
  assert.deepEqual(learningCurve.data, [
    { phase: "Pre", accuracy: 25 },
    { phase: "Post", accuracy: 75 },
  ]);
});

test("detail rows keep stage metrics separate from actual mechanism metrics", () => {
  const summary = normalizeBenchmarkSummary(
    {
      per_mode: {
        selector: {
          accuracy: 1,
          run_count: 6,
          scored_run_count: 6,
          proxy_run_count: 2,
          avg_tokens: 10,
          avg_thinking_tokens: 5,
          avg_latency_ms: 25,
          avg_estimated_cost_usd: 0.01,
        },
      },
      per_mechanism: {
        vote: {
          accuracy: 0.8,
          run_count: 6,
          scored_run_count: 6,
          proxy_run_count: 2,
          avg_tokens: 12,
          avg_thinking_tokens: 4,
          avg_latency_ms: 20,
          avg_estimated_cost_usd: 0.02,
        },
      },
      per_category: {
        math: {
          selector: {
            accuracy: 1,
            run_count: 1,
            scored_run_count: 1,
            proxy_run_count: 0,
            avg_tokens: 7,
            avg_thinking_tokens: 2,
            avg_latency_ms: 11,
            avg_estimated_cost_usd: 0.003,
          },
        },
      },
    },
    null,
  );

  const stageRows = buildDetailStageRows(summary);
  const mechanismRows = buildDetailMechanismRows(summary);

  assert.equal(stageRows.find((row) => row.mechanism === "Selector")?.accuracy, 100);
  assert.equal(stageRows.find((row) => row.mechanism === "Selector")?.runCount, 6);
  assert.equal(mechanismRows.find((row) => row.mechanism === "Selector")?.accuracy, null);
  assert.equal(mechanismRows.find((row) => row.mechanism === "Vote")?.accuracy, 80);
});
