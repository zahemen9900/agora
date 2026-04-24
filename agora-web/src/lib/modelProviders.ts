export type ProviderName =
  | "gemini"
  | "claude"
  | "openrouter"
  | "kimi"
  | "gemma"
  | "gpt"
  | "glm"
  | "qwen"
  | "deepseek"
  | "other";

export function providerFromModel(model: string): ProviderName {
  const normalized = model.toLowerCase();
  if (normalized.includes("gemini")) {
    return "gemini";
  }
  if (normalized.includes("claude")) {
    return "claude";
  }
  if (normalized.includes("moonshot") || normalized.includes("kimi")) {
    return "kimi";
  }
  if (normalized.includes("gemma")) {
    return "gemma";
  }
  if (normalized.includes("gpt-oss") || normalized.startsWith("openai/")) {
    return "gpt";
  }
  if (normalized.includes("glm")) {
    return "glm";
  }
  if (normalized.includes("qwen")) {
    return "qwen";
  }
  if (normalized.includes("deepseek")) {
    return "deepseek";
  }
  if (normalized.includes("/")) {
    return "openrouter";
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
  if (provider === "gpt") {
    return "text-[#d1fae5] border-[rgba(16,185,129,0.25)] bg-[rgba(16,185,129,0.08)]";
  }
  if (provider === "glm") {
    return "text-[#e0f2fe] border-[rgba(56,189,248,0.25)] bg-[rgba(56,189,248,0.08)]";
  }
  if (provider === "qwen") {
    return "text-[#fef3c7] border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.08)]";
  }
  if (provider === "gemma") {
    return "text-[#ede9fe] border-[rgba(139,92,246,0.25)] bg-[rgba(139,92,246,0.08)]";
  }
  if (provider === "deepseek") {
    return "text-[#dbeafe] border-[rgba(59,130,246,0.25)] bg-[rgba(59,130,246,0.08)]";
  }
  if (provider === "kimi" || provider === "openrouter") {
    return "text-text-secondary border-border-subtle bg-void";
  }
  return "text-text-muted border-border-subtle bg-void";
}
