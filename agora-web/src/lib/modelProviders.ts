export type ProviderName = "gemini" | "claude" | "kimi" | "other";

export function providerFromModel(model: string): ProviderName {
  const normalized = model.toLowerCase();
  if (normalized.includes("gemini")) {
    return "gemini";
  }
  if (normalized.includes("claude")) {
    return "claude";
  }
  if (normalized.includes("kimi") || normalized.includes("moonshot")) {
    return "kimi";
  }
  return "other";
}

export function providerTone(provider: ProviderName): string {
  if (provider === "gemini") {
    return "text-cyan-300 border-cyan-500/40 bg-cyan-500/10";
  }
  if (provider === "claude") {
    return "text-fuchsia-300 border-fuchsia-500/40 bg-fuchsia-500/10";
  }
  if (provider === "kimi") {
    return "text-amber-300 border-amber-500/40 bg-amber-500/10";
  }
  return "text-text-secondary border-border-muted bg-surface";
}
