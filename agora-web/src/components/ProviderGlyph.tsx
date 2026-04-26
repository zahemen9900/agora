import { Cpu } from "lucide-react";

import type { ProviderName } from "../lib/modelProviders";

const MODEL_ICON_SOURCES: Partial<Record<ProviderName, string>> = {
  gemini: "/models/gemini.png",
  claude: "/models/claude.png",
  kimi: "/models/kimi.png",
  gemma: "/models/gemma.png",
  gpt: "/models/gpt.png",
  glm: "/models/glm.png",
  qwen: "/models/qwen.png",
  deepseek: "/models/deepseek.png",
};

export function ProviderGlyph({
  provider,
  size = 12,
}: {
  provider: ProviderName;
  size?: number;
}) {
  const source = MODEL_ICON_SOURCES[provider];
  if (source) {
    return (
      <img
        src={source}
        alt={provider}
        width={size}
        height={size}
        style={{ borderRadius: "3px", objectFit: "contain", flexShrink: 0 }}
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      />
    );
  }
  return <Cpu size={size} />;
}
