import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOverviewAccuracyData,
  buildOverviewCostData,
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
    pre_learning: { summary: { per_mode: { selector: { accuracy: 0.25, scored_run_count: 3 } } } },
    post_learning: { summary: { per_mode: { selector: { accuracy: 0.75, scored_run_count: 3 } } } },
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

test("overview accuracy data keeps truly absent coverage at null instead of fake zeroes", () => {
  const summary = normalizeBenchmarkSummary(
    {
      per_category: {
        demo: {
          selector: {
            accuracy: 1,
            run_count: 1,
            scored_run_count: 1,
            proxy_run_count: 1,
            avg_tokens: 10,
            avg_thinking_tokens: 1,
            avg_latency_ms: 20,
            avg_estimated_cost_usd: 0.01,
          },
        },
        math: {
          debate: {
            accuracy: 0,
            run_count: 1,
            scored_run_count: 0,
            proxy_run_count: 0,
            avg_tokens: 10,
            avg_thinking_tokens: 0,
            avg_latency_ms: 20,
            avg_estimated_cost_usd: 0.01,
          },
        },
      },
    },
    null,
  );

  const rows = buildOverviewAccuracyData(summary);
  assert.equal(rows.find((row) => row.category === "Demo")?.selector, 100);
  assert.equal(rows.find((row) => row.category === "Math")?.debate, null);
});

test("overview accuracy data prefers actual executed mechanism category coverage", () => {
  const summary = normalizeBenchmarkSummary(
    {
      per_category: {
        math: {
          selector: {
            accuracy: 1,
            run_count: 1,
            scored_run_count: 1,
            proxy_run_count: 0,
            avg_tokens: 10,
            avg_thinking_tokens: 1,
            avg_latency_ms: 20,
            avg_estimated_cost_usd: 0.01,
          },
        },
      },
      per_category_by_mechanism: {
        math: {
          vote: {
            accuracy: 0.5,
            run_count: 2,
            scored_run_count: 2,
            proxy_run_count: 0,
            avg_tokens: 10,
            avg_thinking_tokens: 1,
            avg_latency_ms: 20,
            avg_estimated_cost_usd: 0.01,
          },
        },
      },
    },
    null,
  );

  const rows = buildOverviewAccuracyData(summary);
  const math = rows.find((row) => row.category === "Math");
  assert.equal(math?.selector, null);
  assert.equal(math?.vote, 50);
});

test("overview derives actual mechanism category coverage from validation payloads", () => {
  const summary = normalizeBenchmarkSummary(
    {
      per_category: {
        math: {
          selector: {
            accuracy: 1,
            run_count: 1,
            scored_run_count: 1,
            proxy_run_count: 0,
            avg_tokens: 10,
            avg_thinking_tokens: 1,
            avg_latency_ms: 20,
            avg_estimated_cost_usd: 0.01,
          },
        },
      },
    },
    {
      post_learning: {
        runs: [
          {
            item_status: "completed",
            mode: "selector",
            mechanism_used: "debate",
            category: "math",
            correct: true,
            scored: true,
            scoring_mode: "exact_match",
            tokens_used: 100,
            thinking_tokens_used: 20,
            latency_ms: 200,
            estimated_cost_usd: 0.02,
          },
        ],
      },
    },
  );

  const rows = buildOverviewAccuracyData(summary);
  const math = rows.find((row) => row.category === "Math");
  assert.equal(math?.selector, null);
  assert.equal(math?.debate, 100);
});

test("overview cost data uses actual executed mechanism cost before requested stage cost", () => {
  const summary = normalizeBenchmarkSummary(
    {
      per_mode: {
        selector: {
          accuracy: 1,
          run_count: 2,
          scored_run_count: 2,
          proxy_run_count: 0,
          avg_tokens: 10,
          avg_thinking_tokens: 1,
          avg_latency_ms: 20,
          avg_estimated_cost_usd: 0.01,
        },
      },
      per_mechanism: {
        debate: {
          accuracy: 1,
          run_count: 1,
          scored_run_count: 1,
          proxy_run_count: 0,
          avg_tokens: 20,
          avg_thinking_tokens: 2,
          avg_latency_ms: 40,
          avg_estimated_cost_usd: 0.03,
        },
      },
    },
    null,
  );

  const rows = buildOverviewCostData(summary);
  assert.equal(rows.find((row) => row.mechanism === "Debate")?.estimatedCostUsd, 0.03);
  assert.equal(rows.find((row) => row.mechanism === "Selector")?.estimatedCostUsd, null);
});
