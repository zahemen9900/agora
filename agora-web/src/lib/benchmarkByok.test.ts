import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBenchmarkByokRunRequest,
  createDefaultBenchmarkByokConfig,
  ensureBenchmarkByokRosterLength,
  getBenchmarkByokValidation,
  type BenchmarkByokConfig,
} from "./benchmarkByok.ts";

function withKeys(config: BenchmarkByokConfig): BenchmarkByokConfig {
  return {
    ...config,
    providerKeys: {
      gemini_api_key: "gemini-key",
      anthropic_api_key: "anthropic-key",
      openrouter_api_key: "openrouter-key",
    },
  };
}

test("createDefaultBenchmarkByokConfig seeds a two-agent roster with two provider families", () => {
  const config = createDefaultBenchmarkByokConfig(2);

  assert.equal(config.agentCount, 2);
  assert.equal(config.roster.length, 2);
  assert.equal(Array.from(new Set(config.roster.map((item) => item.provider))).length, 2);
});

test("ensureBenchmarkByokRosterLength preserves existing slots and appends defaults", () => {
  const initial = createDefaultBenchmarkByokConfig(3);
  const extended = ensureBenchmarkByokRosterLength(initial.roster, 5);

  assert.equal(extended.length, 5);
  assert.deepEqual(
    extended.slice(0, 3).map((item) => item.id),
    initial.roster.map((item) => item.id),
  );
});

test("getBenchmarkByokValidation rejects single-provider rosters and missing provider keys", () => {
  const config = createDefaultBenchmarkByokConfig(3);
  const broken: BenchmarkByokConfig = {
    ...config,
    roster: config.roster.map((item) => ({
      ...item,
      provider: "gemini",
      model: "gemini-3-flash-preview",
    })),
    providerKeys: {
      gemini_api_key: "gemini-key",
      anthropic_api_key: "",
      openrouter_api_key: "",
    },
  };

  const validation = getBenchmarkByokValidation(broken);

  assert.equal(validation.canSubmit, false);
  assert.equal(validation.hasMinimumProviderFamilies, false);
  assert.deepEqual(validation.missingProviderFamilies, []);
  assert.match(validation.issues.join(" "), /at least 2 distinct provider families/i);
});

test("getBenchmarkByokValidation detects selected providers whose keys are missing", () => {
  const config = createDefaultBenchmarkByokConfig(4);
  const partial: BenchmarkByokConfig = {
    ...config,
    providerKeys: {
      gemini_api_key: "gemini-key",
      anthropic_api_key: "",
      openrouter_api_key: "",
    },
  };

  const validation = getBenchmarkByokValidation(partial);

  assert.equal(validation.canSubmit, false);
  assert.deepEqual(validation.missingProviderFamilies.sort(), ["anthropic", "openrouter"]);
});

test("buildBenchmarkByokRunRequest emits only the selected provider keys", () => {
  const config = withKeys(createDefaultBenchmarkByokConfig(4));
  const request = buildBenchmarkByokRunRequest(config);

  assert.equal(request.local_models.length, 4);
  assert.deepEqual(Object.keys(request.local_provider_keys ?? {}).sort(), [
    "anthropic_api_key",
    "gemini_api_key",
    "openrouter_api_key",
  ]);
});

test("buildBenchmarkByokRunRequest omits unused provider keys from the ephemeral payload", () => {
  const config = createDefaultBenchmarkByokConfig(2);
  const request = buildBenchmarkByokRunRequest({
    ...config,
    roster: [
      {
        id: "agent-1",
        provider: "gemini",
        model: "gemini-3-flash-preview",
      },
      {
        id: "agent-2",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    ],
    providerKeys: {
      gemini_api_key: "gemini-key",
      anthropic_api_key: "anthropic-key",
      openrouter_api_key: "should-not-be-sent",
    },
  });

  assert.deepEqual(request.local_provider_keys, {
    gemini_api_key: "gemini-key",
    anthropic_api_key: "anthropic-key",
    openrouter_api_key: undefined,
  });
});
