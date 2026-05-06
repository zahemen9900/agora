import { providerFromModel, type ProviderName } from "./modelProviders.ts";

export type ProviderTier = "pro" | "flash" | "openrouter" | "claude";
export type GeminiProPreset = "low" | "high";
export type ReasoningPreset = "low" | "medium" | "high";
export type ModelProviderFamily = "gemini" | "anthropic" | "openrouter";
export type TierModelOverrideState = Partial<Record<ProviderTier, string>>;
export interface RuntimeTierModelOverridesPayload {
  pro: string | null;
  flash: string | null;
  openrouter: string | null;
  claude: string | null;
}

export interface ReasoningPresetState {
  gemini_pro: GeminiProPreset;
  gemini_flash: ReasoningPreset;
  openrouter: ReasoningPreset;
  claude: ReasoningPreset;
}

export interface ReasoningControlDefinition {
  id: keyof ReasoningPresetState;
  label: string;
  provider: ProviderName;
  help: string;
  tier: ProviderTier;
  modelId: string;
  options: Array<{ value: string; label: string }>;
}

export interface EnsembleRosterItem {
  id: string;
  provider: ProviderName;
  model: string;
  role: string;
  badge: string;
  reasoningLabel: string;
}

export interface ProviderSummaryItem {
  key: ProviderTier;
  provider: ProviderName;
  label: string;
  count: number;
  sublabel: string;
}

export interface RuntimeTierConfigLike {
  provider_family: string;
  model_id: string;
  display_name: string;
  vote_role: string;
  debate_role: string;
}

export interface RuntimeModelOptionLike {
  provider_family: string;
  model_id: string;
  display_name: string;
  source_url?: string | null;
  stability_tier?: string | null;
  supports_streaming?: boolean;
  supports_json_schema?: boolean;
  supports_reasoning?: boolean;
  supports_reasoning_continuation?: boolean;
  input_usd_per_million?: number | null;
  output_usd_per_million?: number | null;
  usage_telemetry_mode?: string | null;
  allowed_tiers?: ProviderTier[] | null;
}

export interface DeliberationRuntimeConfigLike {
  participant_cycle?: ProviderTier[] | null;
  default_reasoning_presets?: Partial<ReasoningPresetState> | null;
  tiers?: Partial<Record<ProviderTier, RuntimeTierConfigLike>> | null;
  catalog?: Partial<Record<ModelProviderFamily, RuntimeModelOptionLike[]>> | null;
}

interface TierDefinition {
  provider: ProviderName;
  model: string;
  displayName: string;
  voteRole: string;
  debateRole: string;
}

const DEFAULT_PARTICIPANT_TIERS: ProviderTier[] = ["pro", "flash", "openrouter", "claude"];

const STATIC_TIER_DEFINITIONS: Record<ProviderTier, TierDefinition> = {
  pro: {
    provider: "gemini",
    model: "gemini-3-flash-preview",
    displayName: "Gemini 3 Flash Preview",
    voteRole: "Strategic voter",
    debateRole: "Debater",
  },
  flash: {
    provider: "gemini",
    model: "gemini-3.1-flash-lite-preview",
    displayName: "Gemini 3.1 Flash Lite Preview",
    voteRole: "Fast voter",
    debateRole: "Debater",
  },
  openrouter: {
    provider: "openrouter",
    model: "qwen/qwen3.5-flash-02-23",
    displayName: "Qwen 3.5 Flash",
    voteRole: "Diversity voter",
    debateRole: "Debater",
  },
  claude: {
    provider: "claude",
    model: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    voteRole: "Challenge voter",
    debateRole: "Debater",
  },
};

const STATIC_RUNTIME_MODEL_CATALOG: Record<ModelProviderFamily, RuntimeModelOptionLike[]> = {
  gemini: [
    {
      provider_family: "gemini",
      model_id: "gemini-3-flash-preview",
      display_name: "Gemini 3 Flash Preview",
      allowed_tiers: ["pro"],
    },
    {
      provider_family: "gemini",
      model_id: "gemini-3.1-pro-preview",
      display_name: "Gemini 3.1 Pro Preview",
      allowed_tiers: ["pro"],
    },
    {
      provider_family: "gemini",
      model_id: "gemini-3.1-flash-lite-preview",
      display_name: "Gemini 3.1 Flash Lite Preview",
      allowed_tiers: ["flash"],
    },
    {
      provider_family: "gemini",
      model_id: "gemini-2.5-pro",
      display_name: "Gemini 2.5 Pro",
      allowed_tiers: ["pro"],
    },
    {
      provider_family: "gemini",
      model_id: "gemini-2.5-flash",
      display_name: "Gemini 2.5 Flash",
      allowed_tiers: ["flash"],
    },
    {
      provider_family: "gemini",
      model_id: "gemini-2.5-flash-lite",
      display_name: "Gemini 2.5 Flash Lite",
      allowed_tiers: ["flash"],
    },
  ],
  anthropic: [
    {
      provider_family: "anthropic",
      model_id: "claude-sonnet-4-6",
      display_name: "Claude Sonnet 4.6",
      allowed_tiers: ["claude"],
    },
    {
      provider_family: "anthropic",
      model_id: "claude-sonnet-4-5",
      display_name: "Claude Sonnet 4.5",
      allowed_tiers: ["claude"],
    },
    {
      provider_family: "anthropic",
      model_id: "claude-haiku-4-5",
      display_name: "Claude Haiku 4.5",
      allowed_tiers: ["claude"],
    },
  ],
  openrouter: [
    {
      provider_family: "openrouter",
      model_id: "deepseek/deepseek-v3.2-exp",
      display_name: "DeepSeek V3.2 Exp",
      allowed_tiers: ["openrouter"],
    },
    {
      provider_family: "openrouter",
      model_id: "google/gemma-4-31b-it",
      display_name: "Gemma 4 31B IT",
      allowed_tiers: ["openrouter"],
    },
    {
      provider_family: "openrouter",
      model_id: "openai/gpt-oss-120b",
      display_name: "GPT OSS 120B",
      allowed_tiers: ["openrouter"],
    },
    {
      provider_family: "openrouter",
      model_id: "z-ai/glm-4.7-flash",
      display_name: "GLM 4.7 Flash",
      allowed_tiers: ["openrouter"],
    },
    {
      provider_family: "openrouter",
      model_id: "qwen/qwen3.5-flash-02-23",
      display_name: "Qwen 3.5 Flash",
      allowed_tiers: ["openrouter"],
    },
    {
      provider_family: "openrouter",
      model_id: "moonshotai/kimi-k2-thinking",
      display_name: "Kimi K2 Thinking",
      allowed_tiers: ["openrouter"],
    },
  ],
};

export const DEFAULT_REASONING_PRESETS: ReasoningPresetState = {
  gemini_pro: "high",
  gemini_flash: "medium",
  openrouter: "low",
  claude: "medium",
};

const REASONING_CONTROL_BLUEPRINTS: Array<
  Omit<ReasoningControlDefinition, "label" | "provider" | "modelId">
> = [
  {
    id: "gemini_pro",
    tier: "pro",
    help: "Thinking level",
    options: [
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
    ],
  },
  {
    id: "gemini_flash",
    tier: "flash",
    help: "Thinking level",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
  },
  {
    id: "openrouter",
    tier: "openrouter",
    help: "Reasoning effort",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
  },
  {
    id: "claude",
    tier: "claude",
    help: "Adaptive effort",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
  },
];

export function resolveDefaultReasoningPresets(
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
): ReasoningPresetState {
  const candidate = runtimeConfig?.default_reasoning_presets ?? null;
  if (!candidate) {
    return { ...DEFAULT_REASONING_PRESETS };
  }

  return {
    gemini_pro: candidate.gemini_pro === "low" ? "low" : "high",
    gemini_flash: normalizeStandardPreset(candidate.gemini_flash, DEFAULT_REASONING_PRESETS.gemini_flash),
    openrouter: normalizeStandardPreset(candidate.openrouter, DEFAULT_REASONING_PRESETS.openrouter),
    claude: normalizeStandardPreset(candidate.claude, DEFAULT_REASONING_PRESETS.claude),
  };
}

export function buildBalancedTiers(
  agentCount: number,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
): ProviderTier[] {
  const cycle = runtimeConfig?.participant_cycle?.length
    ? runtimeConfig.participant_cycle
    : DEFAULT_PARTICIPANT_TIERS;
  const count = Math.max(1, agentCount);
  return Array.from({ length: count }, (_, index) => cycle[index % cycle.length]);
}

export function buildProviderCounts(
  agentCount: number,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
): Record<ProviderTier, number> {
  const counts: Record<ProviderTier, number> = {
    pro: 0,
    flash: 0,
    openrouter: 0,
    claude: 0,
  };
  for (const tier of buildBalancedTiers(agentCount, runtimeConfig)) {
    counts[tier] += 1;
  }
  return counts;
}

export function buildProviderCountBadges(
  agentCount: number,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
  overrides?: TierModelOverrideState,
): Array<{
  key: ProviderTier;
  provider: ProviderName;
  label: string;
  count: number;
}> {
  const counts = buildProviderCounts(agentCount, runtimeConfig);
  return DEFAULT_PARTICIPANT_TIERS.filter((tier) => counts[tier] > 0).map((tier) => {
    const definition = resolveTierDefinition(tier, runtimeConfig, overrides);
    return {
      key: tier,
      provider: definition.provider,
      label: definition.displayName,
      count: counts[tier],
    };
  });
}

export function buildProviderSummary(
  agentCount: number,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
  overrides?: TierModelOverrideState,
): ProviderSummaryItem[] {
  const counts = buildProviderCounts(agentCount, runtimeConfig);
  return DEFAULT_PARTICIPANT_TIERS.filter((tier) => counts[tier] > 0).map((tier) => {
    const definition = resolveTierDefinition(tier, runtimeConfig, overrides);
    return {
      key: tier,
      provider: definition.provider,
      label: definition.displayName,
      count: counts[tier],
      sublabel: `${shortProviderLabel(tier)} tier · ${definition.model}`,
    };
  });
}

export function getBalancedEnsembleLabel(
  agentCount: number,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
): string {
  const cycleLength = runtimeConfig?.participant_cycle?.length || DEFAULT_PARTICIPANT_TIERS.length;
  const replicas = Math.max(1, Math.ceil(Math.max(1, agentCount) / cycleLength));
  return `${replicas}x balanced ensemble`;
}

export function buildVoteRoster(
  agentCount: number,
  presets: ReasoningPresetState,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
  overrides?: TierModelOverrideState,
): EnsembleRosterItem[] {
  return buildBalancedTiers(agentCount, runtimeConfig).map((tier, index) => {
    const definition = resolveTierDefinition(tier, runtimeConfig, overrides);
    return {
      id: `vote-agent-${index + 1}`,
      provider: definition.provider,
      model: definition.model,
      role: definition.voteRole,
      badge: `Agent ${index + 1}`,
      reasoningLabel: formatReasoningLabel(tier, presets),
    };
  });
}

export function buildDebateRoster(
  agentCount: number,
  presets: ReasoningPresetState,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
  overrides?: TierModelOverrideState,
): EnsembleRosterItem[] {
  const countedParticipants = buildBalancedTiers(Math.max(3, agentCount), runtimeConfig).map((tier, index) => {
    const definition = resolveTierDefinition(tier, runtimeConfig, overrides);
    return {
      id: `debate-agent-${index + 1}`,
      provider: definition.provider,
      model: definition.model,
      role: definition.debateRole,
      badge: `Debater ${index + 1}`,
      reasoningLabel: formatReasoningLabel(tier, presets),
    };
  });

  const openrouterDefinition = resolveTierDefinition("openrouter", runtimeConfig, overrides);
  const proDefinition = resolveTierDefinition("pro", runtimeConfig, overrides);

  return [
    ...countedParticipants,
    {
      id: "debate-devils-advocate",
      provider: openrouterDefinition.provider,
      model: openrouterDefinition.model,
      role: "Devil's advocate",
      badge: "Specialist",
      reasoningLabel: formatReasoningLabel("openrouter", presets),
    },
    {
      id: "debate-final-synthesis",
      provider: proDefinition.provider,
      model: proDefinition.model,
      role: "Final synthesis",
      badge: "Specialist",
      reasoningLabel: formatReasoningLabel("pro", presets),
    },
  ];
}

export function getDebateSpecialistSummary(
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
  overrides?: TierModelOverrideState,
): string {
  const openrouterDefinition = resolveTierDefinition("openrouter", runtimeConfig, overrides);
  const proDefinition = resolveTierDefinition("pro", runtimeConfig, overrides);
  return `Plus an ${openrouterDefinition.displayName} devil's advocate and ${proDefinition.displayName} final synthesis.`;
}

export function resolveTierDefinition(
  tier: ProviderTier,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
  overrides?: TierModelOverrideState,
): TierDefinition {
  const runtimeTier = runtimeConfig?.tiers?.[tier];
  const fallback = STATIC_TIER_DEFINITIONS[tier];
  const selectedModel = overrides?.[tier]?.trim();
  const model = selectedModel || runtimeTier?.model_id || fallback.model;
  const catalogOption = resolveCatalogModel(model, runtimeConfig);
  const displayName = catalogOption?.display_name || runtimeTier?.display_name || fallback.displayName;
  const providerFamily = catalogOption?.provider_family || runtimeTier?.provider_family || inferFamilyFromTier(tier);

  return {
    provider: providerNameFromFamily(providerFamily, tier, model),
    model,
    displayName,
    voteRole: runtimeTier?.vote_role || fallback.voteRole,
    debateRole: runtimeTier?.debate_role || fallback.debateRole,
  };
}

export function buildReasoningControlDefinitions(
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
  overrides?: TierModelOverrideState,
): ReasoningControlDefinition[] {
  return REASONING_CONTROL_BLUEPRINTS.map((definition) => {
    const tierDefinition = resolveTierDefinition(definition.tier, runtimeConfig, overrides);
    return {
      ...definition,
      label: tierDefinition.displayName,
      provider: tierDefinition.provider,
      modelId: tierDefinition.model,
    };
  });
}

export function buildTierModelOptions(
  tier: ProviderTier,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
): RuntimeModelOptionLike[] {
  const catalogEntries = flattenRuntimeCatalog(runtimeConfig).filter(
    (entry): entry is RuntimeModelOptionLike => Boolean(entry?.model_id),
  );

  const filtered = catalogEntries.filter((entry) => {
    const allowedTiers = entry.allowed_tiers ?? [];
    return allowedTiers.length === 0 || allowedTiers.includes(tier);
  });
  if (filtered.length > 0) {
    return filtered;
  }

  const fallback = resolveTierDefinition(tier, runtimeConfig);
  return [
    {
      provider_family: inferFamilyFromTier(tier),
      model_id: fallback.model,
      display_name: fallback.displayName,
      allowed_tiers: [tier],
    },
  ];
}

export function buildProviderFamilyModelOptions(
  providerFamily: ModelProviderFamily,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
): RuntimeModelOptionLike[] {
  const catalogEntries = flattenRuntimeCatalog(runtimeConfig).filter(
    (entry): entry is RuntimeModelOptionLike => (
      Boolean(entry?.model_id)
      && entry.provider_family === providerFamily
    ),
  );
  return catalogEntries;
}

export function resolveModelOption(
  modelId: string,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
): RuntimeModelOptionLike | null {
  return resolveCatalogModel(modelId, runtimeConfig);
}

function providerNameFromFamily(
  providerFamily: string,
  tier: ProviderTier,
  modelId?: string,
): ProviderName {
  if (providerFamily === "gemini") {
    return "gemini";
  }
  if (providerFamily === "anthropic") {
    return "claude";
  }
  if (providerFamily === "openrouter") {
    return modelId ? providerFromModel(modelId) : (tier === "openrouter" ? "openrouter" : "other");
  }
  return modelId ? providerFromModel(modelId) : tier === "claude" ? "claude" : tier === "openrouter" ? "openrouter" : "other";
}

export function buildTierModelOverridesPayload(
  overrides: TierModelOverrideState,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
): RuntimeTierModelOverridesPayload | undefined {
  const payload = Object.fromEntries(
    Object.entries(overrides).filter(([tier, model]) => {
      if (!model || typeof model !== "string" || !model.trim()) {
        return false;
      }
      return resolveTierDefinition(tier as ProviderTier, runtimeConfig).model !== model.trim();
    }).map(([tier, model]) => [tier, model.trim()]),
  ) as TierModelOverrideState;
  if (Object.keys(payload).length === 0) {
    return undefined;
  }
  return {
    pro: payload.pro ?? null,
    flash: payload.flash ?? null,
    openrouter: payload.openrouter ?? null,
    claude: payload.claude ?? null,
  };
}

function formatReasoningLabel(
  tier: ProviderTier,
  presets: ReasoningPresetState,
): string {
  if (tier === "pro") {
    return `Thinking level: ${titleCase(presets.gemini_pro)}`;
  }
  if (tier === "flash") {
    return `Thinking level: ${titleCase(presets.gemini_flash)}`;
  }
  if (tier === "openrouter") {
    return `Reasoning effort: ${titleCase(presets.openrouter)}`;
  }
  return `Adaptive effort: ${titleCase(presets.claude)}`;
}

function normalizeStandardPreset(
  value: string | null | undefined,
  fallback: ReasoningPreset,
): ReasoningPreset {
  return value === "low" || value === "medium" || value === "high" ? value : fallback;
}

function shortProviderLabel(tier: ProviderTier): string {
  if (tier === "pro") {
    return "Pro";
  }
  if (tier === "flash") {
    return "Flash";
  }
  if (tier === "openrouter") {
    return "Reasoning";
  }
  return "Claude";
}

function resolveCatalogModel(
  modelId: string,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
): RuntimeModelOptionLike | null {
  const catalogEntries = flattenRuntimeCatalog(runtimeConfig);
  return (
    catalogEntries.find(
      (entry) => entry?.model_id?.trim().toLowerCase() === modelId.trim().toLowerCase(),
    ) ?? null
  );
}

function inferFamilyFromTier(tier: ProviderTier): ModelProviderFamily {
  if (tier === "claude") {
    return "anthropic";
  }
  if (tier === "openrouter") {
    return "openrouter";
  }
  return "gemini";
}

function flattenRuntimeCatalog(
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
): RuntimeModelOptionLike[] {
  const merged = new Map<string, RuntimeModelOptionLike>();
  for (const provider of ["gemini", "anthropic", "openrouter"] as const) {
    for (const entry of STATIC_RUNTIME_MODEL_CATALOG[provider]) {
      merged.set(entry.model_id.toLowerCase(), entry);
    }
    for (const entry of runtimeConfig?.catalog?.[provider] ?? []) {
      if (!entry?.model_id) {
        continue;
      }
      merged.set(entry.model_id.toLowerCase(), entry);
    }
  }
  return Array.from(merged.values());
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
