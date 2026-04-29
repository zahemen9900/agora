import { useEffect, useRef, useState } from "react";
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

interface TierSelectProps {
  value: string;
  options: Array<{ model_id: string; display_name: string }>;
  onChange: (v: string) => void;
  ariaLabel: string;
}

function TierSelect({ value, options, onChange, ariaLabel }: TierSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.model_id === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }} aria-label={ariaLabel}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", padding: "8px 10px",
          fontFamily: FONT, fontSize: "11px", color: "var(--text-primary)",
          background: open ? "var(--bg-subtle)" : "var(--bg-base)",
          border: `1px solid ${open ? "var(--border-strong)" : "var(--border-default)"}`,
          borderRadius: "8px", cursor: "pointer",
          transition: "border-color 0.15s ease, background 0.15s ease",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {selected?.display_name ?? value}
        </span>
        <ChevronDown
          size={11}
          style={{
            color: "var(--text-tertiary)", flexShrink: 0, marginLeft: "6px",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s ease",
          }}
        />
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
          zIndex: 300,
          background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
          borderRadius: "8px", overflow: "hidden auto",
          maxHeight: "200px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        }}>
          {options.map((opt, i) => (
            <button
              key={opt.model_id}
              type="button"
              onClick={() => { onChange(opt.model_id); setOpen(false); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "8px 12px",
                fontFamily: FONT, fontSize: "11px",
                color: opt.model_id === value ? "var(--accent-emerald)" : "var(--text-secondary)",
                background: opt.model_id === value ? "var(--accent-emerald-soft)" : "transparent",
                border: "none",
                borderBottom: i < options.length - 1 ? "1px solid var(--border-default)" : "none",
                cursor: "pointer",
                transition: "background 0.1s ease",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => { if (opt.model_id !== value) e.currentTarget.style.background = "var(--bg-subtle)"; }}
              onMouseLeave={(e) => { if (opt.model_id !== value) e.currentTarget.style.background = "transparent"; }}
            >
              {opt.display_name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
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
              position: "relative",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <ProviderLogo provider={definition.provider} size={22} />
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontSize: "12px", fontFamily: FONT,
                  color: "var(--text-primary)", fontWeight: 600,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {definition.displayName}
                </div>
                <div style={{ fontSize: "10px", color: "var(--text-tertiary)", fontFamily: FONT }}>
                  {TIER_LABELS[tier]}
                </div>
              </div>
            </div>

            <TierSelect
              value={currentValue}
              options={options}
              onChange={(v) => onChange({ ...value, [tier]: v })}
              ariaLabel={`${TIER_LABELS[tier]} model`}
            />

            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px",
              fontFamily: FONT, fontSize: "9px", color: "var(--text-muted)",
              textTransform: "uppercase", letterSpacing: "0.06em",
            }}>
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