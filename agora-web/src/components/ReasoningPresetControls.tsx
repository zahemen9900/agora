import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ProviderGlyph } from "./ProviderGlyph";
import {
  buildReasoningControlDefinitions,
  type DeliberationRuntimeConfigLike,
  type ReasoningPresetState,
  type TierModelOverrideState,
} from "../lib/deliberationConfig";
import { providerTone } from "../lib/modelProviders";

const FONT = "'Commit Mono', 'SF Mono', monospace";

interface InlineSelectProps {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}

function InlineSelect({ value, options, onChange }: InlineSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", padding: "7px 12px",
          fontFamily: FONT, fontSize: "11px", color: "var(--text-primary)",
          background: open ? "var(--bg-subtle)" : "var(--bg-base)",
          border: `1px solid ${open ? "var(--border-strong)" : "var(--border-subtle)"}`,
          borderRadius: "8px", cursor: "pointer",
          transition: "border-color 0.15s ease, background 0.15s ease",
        }}
      >
        <span>{selected?.label ?? value}</span>
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
          borderRadius: "8px", overflow: "hidden",
          boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        }}>
          {options.map((opt, i) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "8px 12px",
                fontFamily: FONT, fontSize: "11px",
                color: opt.value === value ? "var(--accent-emerald)" : "var(--text-secondary)",
                background: opt.value === value ? "var(--accent-emerald-soft)" : "transparent",
                border: "none",
                borderBottom: i < options.length - 1 ? "1px solid var(--border-default)" : "none",
                cursor: "pointer",
                transition: "background 0.1s ease",
              }}
              onMouseEnter={(e) => { if (opt.value !== value) e.currentTarget.style.background = "var(--bg-subtle)"; }}
              onMouseLeave={(e) => { if (opt.value !== value) e.currentTarget.style.background = "transparent"; }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ReasoningPresetControlsProps {
  value: ReasoningPresetState;
  onChange: (next: ReasoningPresetState) => void;
  runtimeConfig?: DeliberationRuntimeConfigLike | null;
  tierModelOverrides?: TierModelOverrideState;
}

export function ReasoningPresetControls({
  value,
  onChange,
  runtimeConfig,
  tierModelOverrides,
}: ReasoningPresetControlsProps) {
  const definitions = buildReasoningControlDefinitions(runtimeConfig, tierModelOverrides);

  return (
    <div className={`grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3`}>
      {definitions.map((definition) => (
        <div
          key={definition.id}
          className={`flex flex-col p-4 border border-border-subtle rounded-xl ${providerTone(definition.provider).replace(/border-[^\s]+/, "")}`}
          style={{ position: "relative" }}
        >
          <div className="flex items-center gap-2 mb-2">
            <ProviderGlyph provider={definition.provider} size={14} />
            <div className="min-w-0">
              <div className="mono text-xs font-medium truncate">{definition.label}</div>
              <div className="mono text-[10px] text-text-muted truncate">{definition.modelId}</div>
            </div>
          </div>
          <div className="mono text-[10px] text-text-muted mb-3 flex-1">{definition.help}</div>
          <InlineSelect
            value={value[definition.id]}
            options={definition.options.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(v) => onChange({ ...value, [definition.id]: v } as ReasoningPresetState)}
          />
        </div>
      ))}
    </div>
  );
}