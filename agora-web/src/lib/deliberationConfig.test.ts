import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTierModelOptions,
  buildProviderCountBadges,
  resolveTierDefinition,
  type DeliberationRuntimeConfigLike,
} from "./deliberationConfig";

test("buildTierModelOptions exposes full built-in fallback catalog when runtime config is missing", () => {
  assert.deepEqual(
    buildTierModelOptions("pro").map((option) => option.model_id),
    ["gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-2.5-pro"],
  );
  assert.deepEqual(
    buildTierModelOptions("flash").map((option) => option.model_id),
    ["gemini-3.1-flash-lite-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  );
  assert.deepEqual(
    buildTierModelOptions("claude").map((option) => option.model_id),
    ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"],
  );
  assert.deepEqual(
    buildTierModelOptions("openrouter").map((option) => option.model_id),
    [
      "deepseek/deepseek-v3.2-exp",
      "google/gemma-4-31b-it",
      "openai/gpt-oss-120b",
      "z-ai/glm-4.7-flash",
      "qwen/qwen3.5-flash-02-23",
      "moonshotai/kimi-k2-thinking",
    ],
  );
});

test("buildTierModelOptions merges runtime catalog entries with built-in fallback catalog", () => {
  const runtimeConfig: DeliberationRuntimeConfigLike = {
    catalog: {
      openrouter: [
        {
          provider_family: "openrouter",
          model_id: "custom/provider-special",
          display_name: "Provider Special",
          allowed_tiers: ["openrouter"],
        },
      ],
    },
  };

  const modelIds = buildTierModelOptions("openrouter", runtimeConfig).map((option) => option.model_id);
  assert.ok(modelIds.includes("custom/provider-special"));
  assert.ok(modelIds.includes("qwen/qwen3.5-flash-02-23"));
  assert.ok(modelIds.includes("moonshotai/kimi-k2-thinking"));
});

test("resolveTierDefinition uses vendor-specific logos and labels for overridden openrouter-family models", () => {
  const definition = resolveTierDefinition("openrouter", null, {
    openrouter: "google/gemma-4-31b-it",
  });
  assert.equal(definition.displayName, "Gemma 4 31B IT");
  assert.equal(definition.provider, "gemma");
});

test("provider count badges reflect the actual selected model names instead of generic tier labels", () => {
  const badges = buildProviderCountBadges(4, null, {
    openrouter: "openai/gpt-oss-120b",
    claude: "claude-haiku-4-5",
  });

  assert.equal(badges.find((badge) => badge.key === "pro")?.label, "Gemini 3 Flash Preview");
  assert.equal(badges.find((badge) => badge.key === "flash")?.label, "Gemini 3.1 Flash Lite Preview");
  assert.equal(badges.find((badge) => badge.key === "openrouter")?.label, "GPT OSS 120B");
  assert.equal(badges.find((badge) => badge.key === "claude")?.label, "Claude Haiku 4.5");
});
