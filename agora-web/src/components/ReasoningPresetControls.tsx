import { ProviderGlyph } from "./ProviderGlyph";
import {
  REASONING_CONTROL_DEFINITIONS,
  type ReasoningPresetState,
} from "../lib/deliberationConfig";
import { providerTone } from "../lib/modelProviders";

interface ReasoningPresetControlsProps {
  value: ReasoningPresetState;
  onChange: (next: ReasoningPresetState) => void;
}

export function ReasoningPresetControls({
  value,
  onChange,
}: ReasoningPresetControlsProps) {
  return (
    <div>
      <div className="mono text-text-muted text-xs mb-3">REASONING PRESETS</div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {REASONING_CONTROL_DEFINITIONS.map((definition) => (
          <label
            key={definition.id}
            className={`flex flex-col p-4 border border-border-subtle rounded-xl transition-colors hover:border-[rgba(255,255,255,0.3)] ${providerTone(definition.provider).replace(/border-[^\s]+/, '')}`}
          >
            <div className="flex items-center gap-2 mb-2">
              <ProviderGlyph provider={definition.provider} size={14} />
              <span className="mono text-xs font-medium">{definition.label}</span>
            </div>
            <div className="mono text-[10px] text-text-muted mb-4 flex-1">{definition.help}</div>
            <select
              value={value[definition.id]}
              onChange={(event) =>
                onChange({
                  ...value,
                  [definition.id]: event.target.value,
                } as ReasoningPresetState)
              }
              className="w-full rounded-full border border-border-subtle bg-transparent px-4 py-2 text-sm text-text-primary focus:outline-none focus:border-border-muted appearance-none disabled:opacity-50"
            >
              {definition.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}
