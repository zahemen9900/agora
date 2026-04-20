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
    return "text-text-primary border-[rgba(255,255,255,0.2)] bg-[rgba(255,255,255,0.06)]";
  }
  if (provider === "claude") {
    return "text-text-primary border-border-muted bg-[rgba(255,255,255,0.03)]";
  }
  if (provider === "kimi") {
    return "text-text-secondary border-border-subtle bg-void";
  }
  return "text-text-muted border-border-subtle bg-void";
}
