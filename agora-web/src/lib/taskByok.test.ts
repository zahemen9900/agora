import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskByokRunRequest,
  createDefaultTaskByokConfig,
  ensureTaskByokRosterLength,
  getTaskByokValidation,
  type TaskByokConfig,
} from "./taskByok.ts";

function withKeys(config: TaskByokConfig): TaskByokConfig {
  return {
    ...config,
    providerKeys: {
      gemini_api_key: "gemini-key",
      anthropic_api_key: "anthropic-key",
      openrouter_api_key: "openrouter-key",
    },
  };
}

test("createDefaultTaskByokConfig seeds a two-agent roster with two provider families", () => {
  const config = createDefaultTaskByokConfig(2);

  assert.equal(config.agentCount, 2);
  assert.equal(config.roster.length, 2);
  assert.equal(Array.from(new Set(config.roster.map((item) => item.provider))).length, 2);
});

test("ensureTaskByokRosterLength preserves existing slots and appends defaults", () => {
  const initial = createDefaultTaskByokConfig(3);
  const extended = ensureTaskByokRosterLength(initial.roster, 5);

  assert.equal(extended.length, 5);
  assert.deepEqual(
    extended.slice(0, 3).map((item) => item.id),
    initial.roster.map((item) => item.id),
  );
});

test("getTaskByokValidation rejects single-provider rosters and missing provider keys", () => {
  const config = createDefaultTaskByokConfig(3);
  const broken: TaskByokConfig = {
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

  const validation = getTaskByokValidation(broken);

  assert.equal(validation.canSubmit, false);
  assert.equal(validation.hasMinimumProviderFamilies, false);
  assert.deepEqual(validation.missingProviderFamilies, []);
  assert.match(validation.issues.join(" "), /at least two provider families/i);
});

test("getTaskByokValidation detects selected providers whose keys are missing", () => {
  const config = createDefaultTaskByokConfig(4);
  const partial: TaskByokConfig = {
    ...config,
    providerKeys: {
      gemini_api_key: "gemini-key",
      anthropic_api_key: "",
      openrouter_api_key: "",
    },
  };

  const validation = getTaskByokValidation(partial);

  assert.equal(validation.canSubmit, false);
  assert.deepEqual(validation.missingProviderFamilies.sort(), ["anthropic", "openrouter"]);
});

test("buildTaskByokRunRequest emits only the selected provider keys", () => {
  const config = withKeys(createDefaultTaskByokConfig(4));
  const request = buildTaskByokRunRequest(config);

  assert.equal(request.local_models.length, 4);
  assert.deepEqual(Object.keys(request.local_provider_keys).sort(), [
    "anthropic_api_key",
    "gemini_api_key",
    "openrouter_api_key",
  ]);
});

test("buildTaskByokRunRequest omits unused provider keys from the ephemeral payload", () => {
  const config = createDefaultTaskByokConfig(2);
  const request = buildTaskByokRunRequest({
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
  });
});
