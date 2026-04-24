import { Cpu } from "lucide-react";

import type { ProviderName } from "../lib/modelProviders";

export function ProviderGlyph({
  provider,
  size = 12,
}: {
  provider: ProviderName;
  size?: number;
}) {
  if (provider !== "other" && provider !== "openrouter") {
    return (
      <img
        src={`/models/${provider}.png`}
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
