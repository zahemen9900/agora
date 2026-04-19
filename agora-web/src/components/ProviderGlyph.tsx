import { Bot, Brain, Cpu, Sparkles } from "lucide-react";

import type { ProviderName } from "../lib/modelProviders";

export function ProviderGlyph({
  provider,
  size = 12,
}: {
  provider: ProviderName;
  size?: number;
}) {
  if (provider === "gemini") {
    return <Sparkles size={size} />;
  }
  if (provider === "claude") {
    return <Bot size={size} />;
  }
  if (provider === "kimi") {
    return <Brain size={size} />;
  }
  return <Cpu size={size} />;
}
