import { AlertTriangle, KeyRound, Minus, Plus } from "lucide-react";

import { ProviderGlyph } from "../ProviderGlyph";
import {
  buildBenchmarkByokModelOptions,
  ensureBenchmarkByokRosterLength,
  getBenchmarkByokValidation,
  type BenchmarkByokConfig,
  type BenchmarkByokProviderFamily,
} from "../../lib/benchmarkByok";
import {
  resolveModelOption,
  type DeliberationRuntimeConfigLike,
  type TierModelOverrideState,
} from "../../lib/deliberationConfig";
import type { ProviderName } from "../../lib/modelProviders";

const PROVIDER_LABELS: Record<BenchmarkByokProviderFamily, string> = {
  gemini: "Gemini",
  anthropic: "Claude",
  openrouter: "OpenRouter",
};

const PROVIDER_HELP: Record<BenchmarkByokProviderFamily, string> = {
  gemini: "Gemini API key",
  anthropic: "Anthropic API key",
  openrouter: "OpenRouter API key",
};

const PROVIDER_KEY_FIELDS: Record<
  BenchmarkByokProviderFamily,
  keyof BenchmarkByokConfig["providerKeys"]
> = {
  gemini: "gemini_api_key",
  anthropic: "anthropic_api_key",
  openrouter: "openrouter_api_key",
};

function ProviderLogo({ provider, size = 18 }: { provider: ProviderName; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <ProviderGlyph provider={provider} size={size} />
    </div>
  );
}

function providerGlyphName(provider: BenchmarkByokProviderFamily): ProviderName {
  if (provider === "anthropic") {
    return "claude";
  }
  return provider;
}

function providerOptions(
  provider: BenchmarkByokProviderFamily,
  runtimeConfig?: DeliberationRuntimeConfigLike | null,
) {
  return buildBenchmarkByokModelOptions(provider, runtimeConfig);
}

interface BenchmarkByokConfigPanelProps {
  value: BenchmarkByokConfig;
  onChange: (next: BenchmarkByokConfig) => void;
  runtimeConfig?: DeliberationRuntimeConfigLike | null;
  tierModelOverrides: TierModelOverrideState;
}

export function BenchmarkByokConfigPanel({
  value,
  onChange,
  runtimeConfig,
  tierModelOverrides,
}: BenchmarkByokConfigPanelProps) {
  const validation = getBenchmarkByokValidation(value);

  const updateRoster = (
    nextAgentCount: number,
    updater?: (roster: BenchmarkByokConfig["roster"]) => BenchmarkByokConfig["roster"],
  ) => {
    const resized = ensureBenchmarkByokRosterLength(
      updater ? updater(value.roster) : value.roster,
      nextAgentCount,
      runtimeConfig,
      tierModelOverrides,
    );
    onChange({
      ...value,
      agentCount: nextAgentCount,
      roster: resized,
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <div
        style={{
          padding: "16px 18px",
          background: "rgba(34,211,138,0.06)",
          border: "1px solid rgba(34,211,138,0.22)",
          borderRadius: "12px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
            style={{ accentColor: "var(--accent-emerald)" }}
          />
          <span
            style={{
              fontSize: "12px",
              fontFamily: "'Commit Mono', monospace",
              color: "var(--text-primary)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Use my own provider keys for this benchmark
          </span>
        </label>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "10px",
            fontSize: "11px",
            color: "var(--text-secondary)",
            fontFamily: "'Commit Mono', monospace",
            lineHeight: 1.6,
          }}
        >
          <KeyRound
            size={14}
            style={{ color: "var(--accent-emerald)", flexShrink: 0, marginTop: "2px" }}
          />
          <span>
            BYOK benchmark runs are ephemeral. Provider keys are used only to
            start this active run and are never stored in benchmark records,
            benchmark events, recovery metadata, or artifacts.
          </span>
        </div>
      </div>

      <div
        style={{
          opacity: value.enabled ? 1 : 0.58,
          pointerEvents: value.enabled ? "auto" : "none",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "11px",
              fontFamily: "'Commit Mono', monospace",
              color: "var(--text-tertiary)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: "12px",
            }}
          >
            Provider Keys
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: "10px",
            }}
          >
            {(["gemini", "anthropic", "openrouter"] as const).map((provider) => {
              const field = PROVIDER_KEY_FIELDS[provider];
              const selected = validation.selectedProviderFamilies.includes(provider);
              const hasKey = value.providerKeys[field].trim().length > 0;
              return (
                <label
                  key={provider}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                    padding: "14px 16px",
                    background: "var(--bg-base)",
                    border: `1px solid ${selected && !hasKey ? "rgba(248,113,113,0.35)" : "var(--border-default)"}`,
                    borderRadius: "12px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <ProviderLogo provider={providerGlyphName(provider)} />
                    <div>
                      <div
                        style={{
                          fontSize: "12px",
                          fontFamily: "'Commit Mono', monospace",
                          color: "var(--text-primary)",
                          fontWeight: 600,
                        }}
                      >
                        {PROVIDER_LABELS[provider]}
                      </div>
                      <div
                        style={{
                          fontSize: "10px",
                          color: "var(--text-tertiary)",
                          fontFamily: "'Commit Mono', monospace",
                        }}
                      >
                        {PROVIDER_HELP[provider]}
                      </div>
                    </div>
                  </div>
                  <input
                    type="password"
                    autoComplete="off"
                    value={value.providerKeys[field]}
                    onChange={(event) => onChange({
                      ...value,
                      providerKeys: {
                        ...value.providerKeys,
                        [field]: event.target.value,
                      },
                    })}
                    placeholder={`Paste ${PROVIDER_LABELS[provider]} key`}
                    style={{
                      background: "var(--bg-elevated)",
                      border: `1px solid ${selected && !hasKey ? "rgba(248,113,113,0.35)" : "var(--border-default)"}`,
                      borderRadius: "8px",
                      padding: "10px 12px",
                      color: "var(--text-primary)",
                      fontFamily: "'Commit Mono', monospace",
                      fontSize: "11px",
                      outline: "none",
                    }}
                  />
                </label>
              );
            })}
          </div>
        </div>

        <div>
          <div
            style={{
              fontSize: "11px",
              fontFamily: "'Commit Mono', monospace",
              color: "var(--text-tertiary)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: "12px",
            }}
          >
            Local Benchmark Agent Count
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              padding: "14px 16px",
              background: "var(--bg-base)",
              border: "1px solid var(--border-default)",
              borderRadius: "12px",
            }}
          >
            <button
              type="button"
              onClick={() => updateRoster(Math.max(2, value.agentCount - 1))}
              disabled={value.agentCount <= 2}
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "8px",
                border: "1px solid var(--border-default)",
                background: "transparent",
                color: "var(--text-secondary)",
                cursor: value.agentCount <= 2 ? "not-allowed" : "pointer",
              }}
            >
              <Minus size={14} />
            </button>
            <input
              type="number"
              min={2}
              max={12}
              value={value.agentCount}
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(next)) {
                  updateRoster(Math.max(2, Math.min(12, next)));
                }
              }}
              style={{
                width: "76px",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-default)",
                borderRadius: "8px",
                padding: "9px 10px",
                color: "var(--text-primary)",
                fontFamily: "'Commit Mono', monospace",
                fontSize: "14px",
                outline: "none",
                textAlign: "center",
              }}
            />
            <button
              type="button"
              onClick={() => updateRoster(Math.min(12, value.agentCount + 1))}
              disabled={value.agentCount >= 12}
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "8px",
                border: "1px solid var(--border-default)",
                background: "transparent",
                color: "var(--text-secondary)",
                cursor: value.agentCount >= 12 ? "not-allowed" : "pointer",
              }}
            >
              <Plus size={14} />
            </button>
            <span
              style={{
                fontFamily: "'Commit Mono', monospace",
                fontSize: "10px",
                color: "var(--text-muted)",
              }}
            >
              BYOK benchmarks support 2 to 12 explicitly selected agents.
            </span>
          </div>
        </div>

        <div>
          <div
            style={{
              fontSize: "11px",
              fontFamily: "'Commit Mono', monospace",
              color: "var(--text-tertiary)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: "12px",
            }}
          >
            Local Agent Roster
          </div>
          <div style={{ display: "grid", gap: "10px" }}>
            {value.roster.map((item, index) => {
              const options = providerOptions(item.provider, runtimeConfig);
              const resolvedOption = resolveModelOption(item.model, runtimeConfig);
              return (
                <div
                  key={item.id}
                  style={{
                    padding: "14px 16px",
                    background: "var(--bg-base)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "12px",
                    display: "grid",
                    gridTemplateColumns: "140px 1fr 1fr",
                    gap: "10px",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontFamily: "'Commit Mono', monospace",
                        fontSize: "10px",
                        color: "var(--text-tertiary)",
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        marginBottom: "4px",
                      }}
                    >
                      Agent {index + 1}
                    </div>
                    <div
                      style={{
                        fontFamily: "'Commit Mono', monospace",
                        fontSize: "10px",
                        color: "var(--text-muted)",
                      }}
                    >
                      Local execution slot
                    </div>
                  </div>

                  <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <span
                      style={{
                        fontFamily: "'Commit Mono', monospace",
                        fontSize: "9px",
                        color: "var(--text-tertiary)",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                      }}
                    >
                      Provider
                    </span>
                    <select
                      value={item.provider}
                      onChange={(event) => {
                        const nextProvider = event.target.value as BenchmarkByokProviderFamily;
                        const nextOptions = providerOptions(nextProvider, runtimeConfig);
                        const nextModel =
                          nextOptions[0]?.model_id
                          ?? value.roster[index]?.model
                          ?? item.model;
                        updateRoster(value.agentCount, (roster) => roster.map((candidate, candidateIndex) => (
                          candidateIndex === index
                            ? {
                              ...candidate,
                              provider: nextProvider,
                              model: nextModel,
                            }
                            : candidate
                        )));
                      }}
                      style={{
                        background: "var(--bg-elevated)",
                        border: "1px solid var(--border-default)",
                        borderRadius: "8px",
                        padding: "10px 12px",
                        color: "var(--text-primary)",
                        fontFamily: "'Commit Mono', monospace",
                        fontSize: "11px",
                        outline: "none",
                      }}
                    >
                      {(["gemini", "anthropic", "openrouter"] as const).map((provider) => (
                        <option key={provider} value={provider}>
                          {PROVIDER_LABELS[provider]}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <span
                      style={{
                        fontFamily: "'Commit Mono', monospace",
                        fontSize: "9px",
                        color: "var(--text-tertiary)",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                      }}
                    >
                      Model
                    </span>
                    <select
                      value={item.model}
                      onChange={(event) => {
                        const nextModel = event.target.value;
                        updateRoster(value.agentCount, (roster) => roster.map((candidate, candidateIndex) => (
                          candidateIndex === index
                            ? { ...candidate, model: nextModel }
                            : candidate
                        )));
                      }}
                      style={{
                        background: "var(--bg-elevated)",
                        border: "1px solid var(--border-default)",
                        borderRadius: "8px",
                        padding: "10px 12px",
                        color: "var(--text-primary)",
                        fontFamily: "'Commit Mono', monospace",
                        fontSize: "11px",
                        outline: "none",
                      }}
                    >
                      {options.map((option) => (
                        <option key={option.model_id} value={option.model_id}>
                          {option.display_name}
                        </option>
                      ))}
                    </select>
                    <span
                      style={{
                        fontFamily: "'Commit Mono', monospace",
                        fontSize: "9px",
                        color: "var(--text-muted)",
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <ProviderLogo provider={providerGlyphName(item.provider)} size={12} />
                      {resolvedOption?.display_name ?? item.model}
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={{
            padding: "14px 16px",
            background: validation.canSubmit
              ? "rgba(34,211,138,0.05)"
              : "rgba(248,113,113,0.06)",
            border: `1px solid ${validation.canSubmit
              ? "rgba(34,211,138,0.2)"
              : "rgba(248,113,113,0.25)"}`,
            borderRadius: "12px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontFamily: "'Commit Mono', monospace",
              fontSize: "10px",
              color: validation.canSubmit ? "var(--accent-emerald)" : "var(--accent-rose)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              fontWeight: 700,
            }}
          >
            {!validation.canSubmit && <AlertTriangle size={12} />}
            {validation.canSubmit
              ? "Benchmark BYOK ready"
              : "Benchmark BYOK needs attention"}
          </div>
          <div
            style={{
              fontFamily: "'Commit Mono', monospace",
              fontSize: "10px",
              color: "var(--text-secondary)",
              display: "flex",
              flexWrap: "wrap",
              gap: "10px",
            }}
          >
            <span>
              Provider families: {validation.selectedProviderFamilies.length}
            </span>
            <span>Roster size: {value.roster.length}</span>
            <span>Agent count: {value.agentCount}</span>
          </div>
          {validation.issues.length > 0 && (
            <ul
              style={{
                margin: 0,
                paddingLeft: "18px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                fontFamily: "'Commit Mono', monospace",
                fontSize: "10px",
                color: "var(--text-secondary)",
              }}
            >
              {validation.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
