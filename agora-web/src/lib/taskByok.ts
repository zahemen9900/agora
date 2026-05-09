import {
  buildBalancedTiers,
  buildProviderFamilyModelOptions,
  resolveTierDefinition,
  type DeliberationRuntimeConfigLike,
  type ModelProviderFamily,
  type RuntimeModelOptionLike,
  type TierModelOverrideState,
} from "./deliberationConfig.ts";

export type TaskByokProviderFamily = ModelProviderFamily;

export interface TaskByokRosterItem {
  id: string;
  provider: TaskByokProviderFamily;
  model: string;
}

export interface TaskByokProviderKeys {
  gemini_api_key: string;
  anthropic_api_key: string;
  openrouter_api_key: string;
}

export interface TaskByokConfig {
  enabled: boolean;
  agentCount: number;
  providerKeys: TaskByokProviderKeys;
  roster: TaskByokRosterItem[];
}

export interface TaskByokValidation {
  canSubmit: boolean;
  rosterMatchesAgentCount: boolean;
  hasMinimumProviderFamilies: boolean;
  selectedProviderFamilies: TaskByokProviderFamily[];
  availableProviderFamilies: TaskByokProviderFamily[];
  missingProviderFamilies: TaskByokProviderFamily[];
  issues: string[];
}

export interface TaskByokRunRequestPayload {
  local_models: Array<{
    provider: TaskByokProviderFamily;
    model: string;
    reasoning_preset?: string | null;
  }>;
  local_provider_keys: Partial<Record<keyof TaskByokProviderKeys, string | null>>;
}

const PROVIDER_FAMILIES: TaskByokProviderFamily[] = [
  "gemini",
  "anthropic",
  "openrouter",
];

const DEFAULT_MODEL_BY_PROVIDER: Record<TaskByokProviderFamily, string> = {
  gemini: "gemini-3-flash-preview",
  anthropic: "claude-sonnet-4-6",
  openrouter: "qwen/qwen3.5-flash-02-23",
};

function providerFamilyForTier(tier: string): TaskByokProviderFamily {
  if (tier === "claude") {
    return "anthropic";
  }
  if (tier === "openrouter") {
    return "openrouter";
  }
  return "gemini";
}

function providerFamilyKey(provider: TaskByokProviderFamily): keyof TaskByokProviderKeys {
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
): TaskByokProviderFamily[] {
  const tiers = buildBalancedTiers(Math.max(2, agentCount), runtimeConfig);
  const families: TaskByokProviderFamily[] = [];
  const seen = new Set<TaskByokProviderFamily>();

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
  provider: TaskByokProviderFamily,
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
  provider: TaskByokProviderFamily,
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

export function buildTaskByokModelOptions(
  provider: TaskByokProviderFamily,
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

export function createDefaultTaskByokConfig(
  agentCount: number,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
  overrides?: TierModelOverrideState,
): TaskByokConfig {
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

export function ensureTaskByokRosterLength(
  roster: TaskByokRosterItem[],
  agentCount: number,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
  overrides?: TierModelOverrideState,
): TaskByokRosterItem[] {
  const normalizedCount = Math.max(2, Math.min(12, Math.trunc(agentCount)));
  const base = createDefaultTaskByokConfig(normalizedCount, runtimeConfig, overrides).roster;
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

export function getTaskByokValidation(config: TaskByokConfig): TaskByokValidation {
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
    issues.push("Local roster must contain exactly one model per agent.");
  }
  if (!hasMinimumProviderFamilies) {
    issues.push("BYOK tasks require at least two provider families in the local roster.");
  }
  if (missingProviderFamilies.length > 0) {
    issues.push(`Missing API keys for: ${missingProviderFamilies.join(", ")}.`);
  }

  return {
    canSubmit: rosterMatchesAgentCount && hasMinimumProviderFamilies && missingProviderFamilies.length === 0,
    rosterMatchesAgentCount,
    hasMinimumProviderFamilies,
    selectedProviderFamilies,
    availableProviderFamilies,
    missingProviderFamilies,
    issues,
  };
}

export function buildTaskByokRunRequest(
  config: TaskByokConfig,
): TaskByokRunRequestPayload {
  const usedProviders = Array.from(new Set(config.roster.map((item) => item.provider)));
  const localProviderKeys = Object.fromEntries(
    usedProviders
      .map((provider) => [providerFamilyKey(provider), config.providerKeys[providerFamilyKey(provider)].trim()] as const)
      .filter(([, value]) => value.length > 0),
  ) as Partial<TaskByokProviderKeys>;

  return {
    local_models: config.roster.map((item) => ({
      provider: item.provider,
      model: item.model.trim(),
      reasoning_preset: null,
    })),
    local_provider_keys: localProviderKeys,
  };
}
