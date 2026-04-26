import { ChevronDown } from "lucide-react";

import { ProviderGlyph } from "./ProviderGlyph";
import type { ProviderName } from "../lib/modelProviders";
import {
  buildTierModelOptions,
  resolveTierDefinition,
  type DeliberationRuntimeConfigLike,
  type ProviderTier,
  type TierModelOverrideState,
} from "../lib/deliberationConfig";

const FONT = "'Commit Mono', 'SF Mono', monospace";
const TIER_ORDER: ProviderTier[] = ["pro", "flash", "openrouter", "claude"];

const TIER_LABELS: Record<ProviderTier, string> = {
  pro: "Pro Tier",
  flash: "Flash Tier",
  openrouter: "Reasoning Tier",
  claude: "Claude Tier",
};

function ProviderLogo({ provider, size = 18 }: { provider: ProviderName; size?: number }) {
  return <ProviderGlyph provider={provider} size={size} />;
}

export function TierModelSelectorGrid({
  runtimeConfig,
  value,
  onChange,
}: {
  runtimeConfig?: DeliberationRuntimeConfigLike | null;
  value: TierModelOverrideState;
  onChange: (next: TierModelOverrideState) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "10px" }}>
      {TIER_ORDER.map((tier) => {
        const definition = resolveTierDefinition(tier, runtimeConfig, value);
        const options = buildTierModelOptions(tier, runtimeConfig);
        const currentValue = value[tier]?.trim() || definition.model;

        return (
          <div
            key={tier}
            style={{
              padding: "14px 16px",
              background: "var(--bg-base)",
              border: "1px solid var(--border-default)",
              borderRadius: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <ProviderLogo provider={definition.provider} size={22} />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "12px",
                    fontFamily: FONT,
                    color: "var(--text-primary)",
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {definition.displayName}
                </div>
                <div
                  style={{
                    fontSize: "10px",
                    color: "var(--text-tertiary)",
                    fontFamily: FONT,
                  }}
                >
                  {TIER_LABELS[tier]}
                </div>
              </div>
            </div>

            <div style={{ position: "relative" }}>
              <select
                value={currentValue}
                onChange={(event) => onChange({ ...value, [tier]: event.target.value })}
                style={{
                  width: "100%",
                  appearance: "none",
                  background: "var(--bg-base)",
                  border: "1px solid var(--border-default)",
                  borderRadius: "8px",
                  padding: "8px 34px 8px 10px",
                  color: "var(--text-primary)",
                  fontFamily: FONT,
                  fontSize: "11px",
                  outline: "none",
                  cursor: "pointer",
                }}
                aria-label={`${TIER_LABELS[tier]} model`}
              >
                {options.map((option) => (
                  <option key={option.model_id} value={option.model_id}>
                    {option.display_name}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={12}
                style={{
                  position: "absolute",
                  right: "10px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--text-tertiary)",
                  pointerEvents: "none",
                }}
              />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "8px",
                fontFamily: FONT,
                fontSize: "9px",
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              <div>
                <div style={{ marginBottom: "2px" }}>Vote</div>
                <div style={{ color: "var(--text-secondary)", textTransform: "none", letterSpacing: 0 }}>
                  {definition.voteRole}
                </div>
              </div>
              <div>
                <div style={{ marginBottom: "2px" }}>Debate</div>
                <div style={{ color: "var(--text-secondary)", textTransform: "none", letterSpacing: 0 }}>
                  {definition.debateRole}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
