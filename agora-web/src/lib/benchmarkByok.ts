import {
  buildBalancedTiers,
  buildProviderFamilyModelOptions,
  resolveTierDefinition,
  type DeliberationRuntimeConfigLike,
  type ModelProviderFamily,
  type RuntimeModelOptionLike,
  type TierModelOverrideState,
} from "./deliberationConfig.ts";
import type { BenchmarkRunRequestPayload } from "./api.ts";

export type BenchmarkByokProviderFamily = ModelProviderFamily;

export interface BenchmarkByokRosterItem {
  id: string;
  provider: BenchmarkByokProviderFamily;
  model: string;
}

export interface BenchmarkByokProviderKeys {
  gemini_api_key: string;
  anthropic_api_key: string;
  openrouter_api_key: string;
}

export interface BenchmarkByokConfig {
  enabled: boolean;
  agentCount: number;
  providerKeys: BenchmarkByokProviderKeys;
  roster: BenchmarkByokRosterItem[];
}

export interface BenchmarkByokValidation {
  canSubmit: boolean;
  rosterMatchesAgentCount: boolean;
  hasMinimumProviderFamilies: boolean;
  selectedProviderFamilies: BenchmarkByokProviderFamily[];
  availableProviderFamilies: BenchmarkByokProviderFamily[];
  missingProviderFamilies: BenchmarkByokProviderFamily[];
  issues: string[];
}

const PROVIDER_FAMILIES: BenchmarkByokProviderFamily[] = [
  "gemini",
  "anthropic",
  "openrouter",
];

const DEFAULT_MODEL_BY_PROVIDER: Record<BenchmarkByokProviderFamily, string> = {
  gemini: "gemini-3-flash-preview",
  anthropic: "claude-sonnet-4-6",
  openrouter: "qwen/qwen3.5-flash-02-23",
};

function providerFamilyForTier(tier: string): BenchmarkByokProviderFamily {
  if (tier === "claude") {
    return "anthropic";
  }
  if (tier === "openrouter") {
    return "openrouter";
  }
  return "gemini";
}

function providerFamilyKey(
  provider: BenchmarkByokProviderFamily,
): keyof BenchmarkByokProviderKeys {
  if (provider === "anthropic") {
    return "anthropic_api_key";
  }
  if (provider === "openrouter") {
    return "openrouter_api_key";
  }
  return "gemini_api_key";
}

function pickDefaultRosterFamilies(
  agentCount: number,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
): BenchmarkByokProviderFamily[] {
  const tiers = buildBalancedTiers(Math.max(2, agentCount), runtimeConfig);
  const families: BenchmarkByokProviderFamily[] = [];
  const seen = new Set<BenchmarkByokProviderFamily>();

  for (const tier of tiers) {
    const family = providerFamilyForTier(tier);
    if (families.length < 2 && seen.has(family)) {
      continue;
    }
    families.push(family);
    seen.add(family);
    if (families.length >= agentCount && seen.size >= Math.min(2, agentCount)) {
      break;
    }
  }

  for (const fallbackFamily of PROVIDER_FAMILIES) {
    if (families.length >= agentCount && seen.size >= Math.min(2, agentCount)) {
      break;
    }
    if (seen.has(fallbackFamily) && seen.size < Math.min(2, agentCount)) {
      continue;
    }
    families.push(fallbackFamily);
    seen.add(fallbackFamily);
  }

  let index = 0;
  while (families.length < agentCount) {
    families.push(families[index % families.length] ?? "gemini");
    index += 1;
  }

  return families.slice(0, agentCount);
}

function pickDefaultModelForProvider(
  provider: BenchmarkByokProviderFamily,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
  overrides?: TierModelOverrideState,
): string {
  if (provider === "gemini") {
    return resolveTierDefinition("pro", runtimeConfig, overrides).model;
  }
  if (provider === "anthropic") {
    return resolveTierDefinition("claude", runtimeConfig, overrides).model;
  }
  return resolveTierDefinition("openrouter", runtimeConfig, overrides).model;
}

function normalizeModelForProvider(
  provider: BenchmarkByokProviderFamily,
  model: string,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
  overrides?: TierModelOverrideState,
): string {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    return pickDefaultModelForProvider(provider, runtimeConfig, overrides);
  }

  const available = buildProviderFamilyModelOptions(provider, runtimeConfig);
  if (available.some((entry) => entry.model_id === normalizedModel)) {
    return normalizedModel;
  }

  return pickDefaultModelForProvider(provider, runtimeConfig, overrides);
}

export function buildBenchmarkByokModelOptions(
  provider: BenchmarkByokProviderFamily,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
): RuntimeModelOptionLike[] {
  const options = buildProviderFamilyModelOptions(provider, runtimeConfig);
  if (options.length > 0) {
    return options;
  }

  return [{
    provider_family: provider,
    model_id: DEFAULT_MODEL_BY_PROVIDER[provider],
    display_name: DEFAULT_MODEL_BY_PROVIDER[provider],
  }];
}

export function createDefaultBenchmarkByokConfig(
  agentCount: number,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
  overrides?: TierModelOverrideState,
): BenchmarkByokConfig {
  const normalizedCount = Math.max(2, Math.min(12, Math.trunc(agentCount)));
  const families = pickDefaultRosterFamilies(normalizedCount, runtimeConfig);
  return {
    enabled: false,
    agentCount: normalizedCount,
    providerKeys: {
      gemini_api_key: "",
      anthropic_api_key: "",
      openrouter_api_key: "",
    },
    roster: families.map((provider, index) => ({
      id: `agent-${index + 1}`,
      provider,
      model: pickDefaultModelForProvider(provider, runtimeConfig, overrides),
    })),
  };
}

export function ensureBenchmarkByokRosterLength(
  roster: BenchmarkByokRosterItem[],
  agentCount: number,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
  overrides?: TierModelOverrideState,
): BenchmarkByokRosterItem[] {
  const normalizedCount = Math.max(2, Math.min(12, Math.trunc(agentCount)));
  const base = createDefaultBenchmarkByokConfig(
    normalizedCount,
    runtimeConfig,
    overrides,
  ).roster;
  const next = roster
    .slice(0, normalizedCount)
    .map((item, index) => ({
      id: item.id || `agent-${index + 1}`,
      provider: item.provider,
      model: normalizeModelForProvider(item.provider, item.model, runtimeConfig, overrides),
    }));

  while (next.length < normalizedCount) {
    const fallback = base[next.length];
    next.push({
      id: `agent-${next.length + 1}`,
      provider: fallback.provider,
      model: fallback.model,
    });
  }

  return next;
}

export function getBenchmarkByokValidation(
  config: BenchmarkByokConfig,
): BenchmarkByokValidation {
  const normalizedRoster = config.roster.filter((item) => item.model.trim().length > 0);
  const selectedProviderFamilies = Array.from(
    new Set(normalizedRoster.map((item) => item.provider)),
  );
  const availableProviderFamilies = PROVIDER_FAMILIES.filter((provider) => (
    config.providerKeys[providerFamilyKey(provider)].trim().length > 0
  ));
  const missingProviderFamilies = selectedProviderFamilies.filter((provider) => (
    config.providerKeys[providerFamilyKey(provider)].trim().length === 0
  ));
  const rosterMatchesAgentCount = normalizedRoster.length === config.agentCount;
  const hasMinimumProviderFamilies = selectedProviderFamilies.length >= 2;

  const issues: string[] = [];
  if (!rosterMatchesAgentCount) {
    issues.push("Local roster must contain exactly one model per benchmark agent.");
  }
  if (!hasMinimumProviderFamilies) {
    issues.push("Benchmark BYOK requires at least 2 distinct provider families.");
  }
  if (missingProviderFamilies.length > 0) {
    issues.push(
      `Provide API keys for: ${missingProviderFamilies.map((provider) => provider.toUpperCase()).join(", ")}.`,
    );
  }

  return {
    canSubmit: issues.length === 0,
    rosterMatchesAgentCount,
    hasMinimumProviderFamilies,
    selectedProviderFamilies,
    availableProviderFamilies,
    missingProviderFamilies,
    issues,
  };
}

export function buildBenchmarkByokRunRequest(
  config: BenchmarkByokConfig,
): Pick<
  BenchmarkRunRequestPayload,
  "local_models" | "local_provider_keys"
> {
  const selectedProviders = new Set(config.roster.map((item) => item.provider));
  return {
    local_models: config.roster.map((item) => ({
      provider: item.provider,
      model: item.model,
    })),
    local_provider_keys: {
      gemini_api_key: selectedProviders.has("gemini")
        ? (config.providerKeys.gemini_api_key.trim() || undefined)
        : undefined,
      anthropic_api_key: selectedProviders.has("anthropic")
        ? (config.providerKeys.anthropic_api_key.trim() || undefined)
        : undefined,
      openrouter_api_key: selectedProviders.has("openrouter")
        ? (config.providerKeys.openrouter_api_key.trim() || undefined)
        : undefined,
    },
  };
}
