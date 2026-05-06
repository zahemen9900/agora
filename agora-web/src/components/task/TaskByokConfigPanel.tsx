import { AlertTriangle, KeyRound, Minus, Plus } from "lucide-react";

import { ProviderGlyph } from "../ProviderGlyph";
import {
  buildTaskByokModelOptions,
  ensureTaskByokRosterLength,
  getTaskByokValidation,
  type TaskByokConfig,
  type TaskByokProviderFamily,
} from "../../lib/taskByok";
import {
  resolveModelOption,
  type DeliberationRuntimeConfigLike,
  type TierModelOverrideState,
} from "../../lib/deliberationConfig";
import type { ProviderName } from "../../lib/modelProviders";

const PROVIDER_LABELS: Record<TaskByokProviderFamily, string> = {
  gemini: "Gemini",
  anthropic: "Claude",
  openrouter: "OpenRouter",
};

const PROVIDER_HELP: Record<TaskByokProviderFamily, string> = {
  gemini: "Gemini API key",
  anthropic: "Anthropic API key",
  openrouter: "OpenRouter API key",
};

const PROVIDER_KEY_FIELDS: Record<TaskByokProviderFamily, keyof TaskByokConfig["providerKeys"]> = {
  gemini: "gemini_api_key",
  anthropic: "anthropic_api_key",
  openrouter: "openrouter_api_key",
};

function ProviderLogo({ provider, size = 18 }: { provider: ProviderName; size?: number }) {
  return (
    <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <ProviderGlyph provider={provider} size={size} />
    </div>
  );
}

function providerGlyphName(provider: TaskByokProviderFamily): ProviderName {
  if (provider === "anthropic") {
    return "claude";
  }
  return provider;
}

function providerOptions(provider: TaskByokProviderFamily, runtimeConfig?: DeliberationRuntimeConfigLike | null) {
  return buildTaskByokModelOptions(provider, runtimeConfig);
}

interface TaskByokConfigPanelProps {
  value: TaskByokConfig;
  onChange: (next: TaskByokConfig) => void;
  runtimeConfig?: DeliberationRuntimeConfigLike | null;
  tierModelOverrides: TierModelOverrideState;
}

export function TaskByokConfigPanel({
  value,
  onChange,
  runtimeConfig,
  tierModelOverrides,
}: TaskByokConfigPanelProps) {
  const validation = getTaskByokValidation(value);

  const updateRoster = (nextAgentCount: number, updater?: (roster: TaskByokConfig["roster"]) => TaskByokConfig["roster"]) => {
    const resized = ensureTaskByokRosterLength(
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
      <div style={{
        padding: "16px 18px",
        background: "rgba(34,211,138,0.06)",
        border: "1px solid rgba(34,211,138,0.22)",
        borderRadius: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}>
        <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
            style={{ accentColor: "var(--accent-emerald)" }}
          />
          <span style={{
            fontSize: "12px",
            fontFamily: "'Commit Mono', monospace",
            color: "var(--text-primary)",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}>
            Use my own provider keys for this run
          </span>
        </label>
        <div style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "10px",
          fontSize: "11px",
          color: "var(--text-secondary)",
          fontFamily: "'Commit Mono', monospace",
          lineHeight: 1.6,
        }}>
          <KeyRound size={14} style={{ color: "var(--accent-emerald)", flexShrink: 0, marginTop: "2px" }} />
          <span>
            BYOK task runs are ephemeral. Provider keys are used only to start this active run and are never stored in task records, task events, recovery metadata, or benchmark artifacts.
          </span>
        </div>
      </div>

      <div style={{
        opacity: value.enabled ? 1 : 0.58,
        pointerEvents: value.enabled ? "auto" : "none",
        display: "flex",
        flexDirection: "column",
        gap: "24px",
      }}>
        <div>
          <div style={{
            fontSize: "11px",
            fontFamily: "'Commit Mono', monospace",
            color: "var(--text-tertiary)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: "12px",
          }}>
            Provider Keys
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
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
                      <div style={{ fontSize: "12px", fontFamily: "'Commit Mono', monospace", color: "var(--text-primary)", fontWeight: 600 }}>
                        {PROVIDER_LABELS[provider]}
                      </div>
                      <div style={{ fontSize: "10px", color: "var(--text-tertiary)", fontFamily: "'Commit Mono', monospace" }}>
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
          <div style={{
            fontSize: "11px",
            fontFamily: "'Commit Mono', monospace",
            color: "var(--text-tertiary)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: "12px",
          }}>
            Local Agent Count
          </div>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "14px 16px",
            background: "var(--bg-base)",
            border: "1px solid var(--border-default)",
            borderRadius: "12px",
          }}>
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
            <div style={{ marginLeft: "auto", fontSize: "11px", color: "var(--text-tertiary)", fontFamily: "'Commit Mono', monospace" }}>
              2–12 local agents · roster length must match exactly
            </div>
          </div>
        </div>

        <div>
          <div style={{
            fontSize: "11px",
            fontFamily: "'Commit Mono', monospace",
            color: "var(--text-tertiary)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: "12px",
          }}>
            Local Roster
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {value.roster.map((item, index) => {
              const modelOptions = providerOptions(item.provider, runtimeConfig);
              const selectedModel = resolveModelOption(item.model, runtimeConfig);
              return (
                <div
                  key={item.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 160px) minmax(0, 1fr)",
                    gap: "10px",
                    padding: "14px 16px",
                    background: "var(--bg-base)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "12px",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "12px", fontFamily: "'Commit Mono', monospace", color: "var(--text-primary)", fontWeight: 700 }}>
                      Agent {index + 1}
                    </div>
                    <div style={{ fontSize: "10px", color: "var(--text-tertiary)", fontFamily: "'Commit Mono', monospace" }}>
                      BYOK local participant
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 160px) minmax(0, 1fr)", gap: "10px" }}>
                    <select
                      value={item.provider}
                      onChange={(event) => {
                        const nextProvider = event.target.value as TaskByokProviderFamily;
                        const nextOptions = providerOptions(nextProvider, runtimeConfig);
                        const nextModel = nextOptions[0]?.model_id ?? item.model;
                        updateRoster(value.agentCount, (roster) => roster.map((entry) => (
                          entry.id === item.id
                            ? { ...entry, provider: nextProvider, model: nextModel }
                            : entry
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
                      }}
                    >
                      {(["gemini", "anthropic", "openrouter"] as const).map((provider) => {
                        const keyPresent = value.providerKeys[PROVIDER_KEY_FIELDS[provider]].trim().length > 0;
                        return (
                          <option
                            key={provider}
                            value={provider}
                            disabled={!keyPresent && provider !== item.provider}
                          >
                            {PROVIDER_LABELS[provider]}{keyPresent ? "" : " (add key first)"}
                          </option>
                        );
                      })}
                    </select>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      <select
                        value={item.model}
                        onChange={(event) => updateRoster(value.agentCount, (roster) => roster.map((entry) => (
                          entry.id === item.id
                            ? { ...entry, model: event.target.value }
                            : entry
                        )))}
                        style={{
                          background: "var(--bg-elevated)",
                          border: "1px solid var(--border-default)",
                          borderRadius: "8px",
                          padding: "10px 12px",
                          color: "var(--text-primary)",
                          fontFamily: "'Commit Mono', monospace",
                          fontSize: "11px",
                        }}
                      >
                        {modelOptions.map((option) => (
                          <option key={option.model_id} value={option.model_id}>
                            {option.display_name}
                          </option>
                        ))}
                      </select>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <ProviderLogo provider={providerGlyphName(item.provider)} size={16} />
                        <span style={{ fontSize: "10px", color: "var(--text-tertiary)", fontFamily: "'Commit Mono', monospace" }}>
                          {selectedModel?.model_id ?? item.model}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{
          padding: "14px 16px",
          background: "var(--bg-base)",
          border: `1px solid ${validation.canSubmit ? "rgba(34,211,138,0.18)" : "rgba(248,113,113,0.22)"}`,
          borderRadius: "12px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <AlertTriangle size={14} style={{ color: validation.canSubmit ? "var(--accent-emerald)" : "#f87171" }} />
            <span style={{ fontSize: "11px", fontFamily: "'Commit Mono', monospace", color: "var(--text-primary)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              BYOK Validation
            </span>
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", fontFamily: "'Commit Mono', monospace", lineHeight: 1.6 }}>
            Selected providers: {validation.selectedProviderFamilies.length > 0 ? validation.selectedProviderFamilies.join(", ") : "none"} ·
            Keys present: {validation.availableProviderFamilies.length > 0 ? validation.availableProviderFamilies.join(", ") : "none"}
          </div>
          {validation.issues.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: "18px", color: "#fca5a5", fontSize: "11px", fontFamily: "'Commit Mono', monospace", lineHeight: 1.7 }}>
              {validation.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : (
            <div style={{ fontSize: "11px", color: "var(--accent-emerald)", fontFamily: "'Commit Mono', monospace" }}>
              Local roster is ready. Submission will create the task normally, then start the active run with your ephemeral keys.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
