import type { ProviderName } from "./modelProviders";

export type ProviderTier = "pro" | "flash" | "openrouter" | "claude";
export type GeminiProPreset = "low" | "high";
export type ReasoningPreset = "low" | "medium" | "high";

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

interface TierDefinition {
  provider: ProviderName;
  model: string;
  voteRole: string;
  debateRole: string;
}

const BASE_PARTICIPANT_TIERS: ProviderTier[] = ["pro", "flash", "openrouter", "claude"];

const TIER_DEFINITIONS: Record<ProviderTier, TierDefinition> = {
  pro: {
    provider: "gemini",
    model: "gemini-3-flash-preview",
    voteRole: "Strategic voter",
    debateRole: "Debater",
  },
  flash: {
    provider: "gemini",
    model: "gemini-3.1-flash-lite-preview",
    voteRole: "Fast voter",
    debateRole: "Debater",
  },
  openrouter: {
    provider: "openrouter",
    model: "qwen/qwen3.5-flash-02-23",
    voteRole: "Diversity voter",
    debateRole: "Debater",
  },
  claude: {
    provider: "claude",
    model: "claude-sonnet-4-6",
    voteRole: "Challenge voter",
    debateRole: "Debater",
  },
};

export const DEFAULT_REASONING_PRESETS: ReasoningPresetState = {
  gemini_pro: "high",
  gemini_flash: "medium",
  openrouter: "low",
  claude: "medium",
};

export const REASONING_CONTROL_DEFINITIONS: ReasoningControlDefinition[] = [
  {
    id: "gemini_pro",
    label: "Gemini Pro",
    provider: "gemini",
    help: "Thinking level",
    options: [
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
    ],
  },
  {
    id: "gemini_flash",
    label: "Gemini Flash",
    provider: "gemini",
    help: "Thinking level",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    provider: "openrouter",
    help: "Reasoning effort",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
  },
  {
    id: "claude",
    label: "Claude",
    provider: "claude",
    help: "Adaptive effort",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
  },
];

export function buildBalancedTiers(agentCount: number): ProviderTier[] {
  const count = Math.max(1, agentCount);
  return Array.from({ length: count }, (_, index) => BASE_PARTICIPANT_TIERS[index % 4]);
}

export function buildProviderCounts(agentCount: number): Record<ProviderTier, number> {
  const counts: Record<ProviderTier, number> = {
    pro: 0,
    flash: 0,
    openrouter: 0,
    claude: 0,
  };
  for (const tier of buildBalancedTiers(agentCount)) {
    counts[tier] += 1;
  }
  return counts;
}

export function buildProviderCountBadges(agentCount: number): Array<{
  key: ProviderTier;
  provider: ProviderName;
  label: string;
  count: number;
}> {
  const counts = buildProviderCounts(agentCount);
  return BASE_PARTICIPANT_TIERS.filter((tier) => counts[tier] > 0).map((tier) => ({
    key: tier,
    provider: TIER_DEFINITIONS[tier].provider,
    label: shortProviderLabel(tier),
    count: counts[tier],
  }));
}

export function getBalancedEnsembleLabel(agentCount: number): string {
  const replicas = Math.max(1, Math.ceil(Math.max(1, agentCount) / 4));
  return `${replicas}x balanced ensemble`;
}

export function buildVoteRoster(
  agentCount: number,
  presets: ReasoningPresetState,
): EnsembleRosterItem[] {
  return buildBalancedTiers(agentCount).map((tier, index) => ({
    id: `vote-agent-${index + 1}`,
    provider: TIER_DEFINITIONS[tier].provider,
    model: TIER_DEFINITIONS[tier].model,
    role: TIER_DEFINITIONS[tier].voteRole,
    badge: `Agent ${index + 1}`,
    reasoningLabel: formatReasoningLabel(tier, presets),
  }));
}

export function buildDebateRoster(
  agentCount: number,
  presets: ReasoningPresetState,
): EnsembleRosterItem[] {
  const countedParticipants = buildBalancedTiers(Math.max(3, agentCount)).map((tier, index) => ({
    id: `debate-agent-${index + 1}`,
    provider: TIER_DEFINITIONS[tier].provider,
    model: TIER_DEFINITIONS[tier].model,
    role: TIER_DEFINITIONS[tier].debateRole,
    badge: `Debater ${index + 1}`,
    reasoningLabel: formatReasoningLabel(tier, presets),
  }));

  return [
    ...countedParticipants,
    {
      id: "debate-devils-advocate",
      provider: "openrouter",
      model: TIER_DEFINITIONS.openrouter.model,
      role: "Devil's advocate",
      badge: "Specialist",
      reasoningLabel: formatReasoningLabel("openrouter", presets),
    },
    {
      id: "debate-final-synthesis",
      provider: "gemini",
      model: TIER_DEFINITIONS.pro.model,
      role: "Final synthesis",
      badge: "Specialist",
      reasoningLabel: formatReasoningLabel("pro", presets),
    },
  ];
}

export function getDebateSpecialistSummary(): string {
  return "Plus an OpenRouter devil's advocate and Gemini Pro final synthesis.";
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

function shortProviderLabel(tier: ProviderTier): string {
  if (tier === "pro") {
    return "Pro";
  }
  if (tier === "flash") {
    return "Flash";
  }
  if (tier === "openrouter") {
    return "OpenRouter";
  }
  return "Claude";
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
