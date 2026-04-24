import { useState } from 'react';
import { X, HelpCircle, ChevronDown } from 'lucide-react';
import {
  REASONING_CONTROL_DEFINITIONS,
  type ReasoningPresetState,
} from '../../lib/deliberationConfig';

// ─── Provider logo mapping ────────────────────────────────────────────────────
const PROVIDER_LOGO: Record<string, string> = {
  gemini: '/models/gemini.png',
  openrouter: '/models/qwen.png',
  kimi:   '/models/kimi.png',
  gemma: '/models/gemma.png',
  glm: '/models/glm.png',
  gpt: '/models/gpt.png',
  qwen: '/models/qwen.png',
  claude: '/models/claude.png',
};

function ProviderLogo({ provider, size = 20 }: { provider: string; size?: number }) {
  const src = PROVIDER_LOGO[provider];
  if (!src) {
    return (
      <div style={{
        width: size, height: size, borderRadius: '50%',
        background: 'var(--border-strong)',
        flexShrink: 0,
      }} />
    );
  }
  return (
    <img
      src={src}
      alt={provider}
      style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }}
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
    />
  );
}

// ─── Stakes tooltip ───────────────────────────────────────────────────────────
function StakesTooltip() {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label="Stakes help"
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '2px', color: 'var(--text-tertiary)',
          display: 'flex', alignItems: 'center',
        }}
      >
        <HelpCircle size={13} />
      </button>
      {open && (
        // Tooltip appears BELOW the label — safe inside a scroll container
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 8px)',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '240px',
          padding: '11px 13px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: '8px',
          fontSize: '11px',
          fontFamily: "'Commit Mono', monospace",
          color: 'var(--text-secondary)',
          lineHeight: '1.6',
          zIndex: 200,
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          whiteSpace: 'normal',
        }}>
          {/* Arrow pointing UP */}
          <div style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 0, height: 0,
            borderLeft: '6px solid transparent',
            borderRight: '6px solid transparent',
            borderBottom: '6px solid var(--border-strong)',
          }} />
          <span style={{ color: 'var(--accent-emerald)', fontWeight: 600 }}>Higher stakes = more effort.</span>{' '}
          Agents are allocated more compute, longer reasoning chains, and stricter quorum thresholds when the stakes are high.
        </div>
      )}
    </span>
  );
}

// ─── Tab system ───────────────────────────────────────────────────────────────
const TABS = ['Effort & Stakes', 'Swarm Config'] as const;
type TabId = typeof TABS[number];

// ─── Swarm layer diagram ─────────────────────────────────────────────────────
const AGENT_COUNT_OPTIONS = [4, 8, 12] as const;

function SwarmDiagram({ agentCount }: { agentCount: number }) {
  const voters = agentCount;
  const debaters = Math.max(3, agentCount);
  const specialist = 2; // devil's advocate + synthesis always fixed

  const layers = [
    { label: 'Selector', count: 1, color: 'var(--text-tertiary)', desc: 'LLM reasoning agent chooses mechanism' },
    { label: 'Deliberation', count: debaters, color: 'var(--accent-emerald)', desc: `${debaters} debaters / ${voters} voters` },
    { label: 'Specialists', count: specialist, color: 'var(--border-strong)', desc: "Devil's advocate + synthesis" },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '8px' }}>
      {layers.map((layer) => (
        <div key={layer.label} style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          {/* Dots */}
          <div style={{ display: 'flex', gap: '4px', flexShrink: 0, width: '72px', flexWrap: 'wrap' }}>
            {Array.from({ length: Math.min(layer.count, 12) }).map((_, i) => (
              <div key={i} style={{
                width: '8px', height: '8px', borderRadius: '50%',
                background: layer.color,
                opacity: 0.85,
              }} />
            ))}
            {layer.count > 12 && (
              <span style={{ fontSize: '9px', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace" }}>
                +{layer.count - 12}
              </span>
            )}
          </div>
          {/* Label */}
          <div>
            <div style={{ fontSize: '12px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-primary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {layer.label}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace" }}>
              {layer.desc}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main export ─────────────────────────────────────────────────────────────
interface ConfigModalProps {
  open: boolean;
  onClose: () => void;
  reasoningPresets: ReasoningPresetState;
  onPresetsChange: (next: ReasoningPresetState) => void;
  agentCount: number;
  onAgentCountChange: (n: number) => void;
  stakes: string;
  onStakesChange: (v: string) => void;
}

export function ConfigModal({
  open,
  onClose,
  reasoningPresets,
  onPresetsChange,
  agentCount,
  onAgentCountChange,
  stakes,
  onStakesChange,
}: ConfigModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>('Effort & Stakes');

  // Stakes validation
  const stakesNum = parseFloat(stakes);
  const stakesOverLimit = !isNaN(stakesNum) && stakesNum > 0.1;

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(6px)',
          zIndex: 1000,
        }}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Deliberation configuration"
        style={{
          position: 'fixed',
          top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(600px, calc(100vw - 32px))',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: '16px',
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
          zIndex: 1001,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '18px 24px 0',
          flexShrink: 0,
        }}>
          <div style={{ fontSize: '15px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-primary)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Configure
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: '4px', display: 'flex', alignItems: 'center' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex',
          gap: 0,
          padding: '14px 24px 0',
          borderBottom: '1px solid var(--border-default)',
          flexShrink: 0,
        }}>
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '6px 16px 12px',
                fontSize: '12px',
                fontFamily: "'Commit Mono', monospace",
                fontWeight: 600,
                letterSpacing: '0.04em',
                color: activeTab === tab ? 'var(--accent-emerald)' : 'var(--text-tertiary)',
                borderBottom: activeTab === tab ? '2px solid var(--accent-emerald)' : '2px solid transparent',
                marginBottom: '-1px',
                transition: 'color 0.15s ease, border-color 0.15s ease',
                textTransform: 'uppercase',
              }}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Body — scrollable */}
        <div style={{ overflowY: 'auto', padding: '24px', flex: 1 }}>

          {/* ── Tab 1: Effort & Stakes ── */}
          {activeTab === 'Effort & Stakes' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

              {/* Stakes */}
              <div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  fontSize: '11px', fontFamily: "'Commit Mono', monospace",
                  color: 'var(--text-tertiary)', textTransform: 'uppercase',
                  letterSpacing: '0.08em', marginBottom: '10px',
                }}>
                  Stakes (SOL) <StakesTooltip />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {['0.001', '0.01', '0.05', '0.1'].map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => onStakesChange(val)}
                      style={{
                        padding: '6px 14px',
                        borderRadius: '100px',
                        border: `1px solid ${stakes === val ? 'var(--accent-emerald)' : 'var(--border-default)'}`,
                        background: stakes === val ? 'rgba(34,211,138,0.08)' : 'transparent',
                        color: stakes === val ? 'var(--accent-emerald)' : 'var(--text-secondary)',
                        fontSize: '12px',
                        fontFamily: "'Commit Mono', monospace",
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {val}
                    </button>
                  ))}
                  <input
                    type="text"
                    inputMode="decimal"
                    value={stakes}
                    onChange={(e) => {
                      const v = e.target.value;
                      // Allow any decimal input — validation shown inline
                      if (v === '' || /^\d*\.?\d*$/.test(v)) onStakesChange(v);
                    }}
                    style={{
                      background: 'var(--bg-base)',
                      border: `1px solid ${stakesOverLimit ? '#f87171' : 'var(--border-default)'}`,
                      borderRadius: '8px',
                      padding: '6px 10px',
                      color: stakesOverLimit ? '#f87171' : 'var(--text-primary)',
                      fontFamily: "'Commit Mono', monospace",
                      fontSize: '12px',
                      width: '80px',
                      outline: 'none',
                      transition: 'border-color 0.15s ease, color 0.15s ease',
                    }}
                    placeholder="custom"
                    aria-label="Custom stakes value (max 0.1 SOL)"
                  />
                </div>

                {/* Inline validation message */}
                {stakesOverLimit && (
                  <div style={{
                    marginTop: '8px',
                    fontSize: '11px',
                    fontFamily: "'Commit Mono', monospace",
                    color: '#f87171',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <circle cx="6" cy="6" r="5.5" stroke="#f87171" />
                      <path d="M6 3.5v3M6 8h.01" stroke="#f87171" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                    Stake must be 0.1 SOL or less
                  </div>
                )}
              </div>

              {/* Model presets */}
              <div>
                <div style={{
                  fontSize: '11px', fontFamily: "'Commit Mono', monospace",
                  color: 'var(--text-tertiary)', textTransform: 'uppercase',
                  letterSpacing: '0.08em', marginBottom: '12px',
                }}>
                  Reasoning Presets
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' }}>
                  {REASONING_CONTROL_DEFINITIONS.map((def) => (
                    <div
                      key={def.id}
                      style={{
                        padding: '14px 16px',
                        background: 'var(--bg-base)',
                        border: '1px solid var(--border-default)',
                        borderRadius: '12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                      }}
                    >
                      {/* Model header */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <ProviderLogo provider={def.provider} size={22} />
                        <div>
                          <div style={{ fontSize: '12px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-primary)', fontWeight: 600 }}>
                            {def.label}
                          </div>
                          <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace" }}>
                            {def.help}
                          </div>
                        </div>
                      </div>

                      {/* Option pills */}
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {def.options.map((opt) => {
                          const active = reasoningPresets[def.id] === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => onPresetsChange({ ...reasoningPresets, [def.id]: opt.value } as ReasoningPresetState)}
                              style={{
                                flex: 1,
                                padding: '5px 0',
                                borderRadius: '6px',
                                border: `1px solid ${active ? 'var(--accent-emerald)' : 'var(--border-default)'}`,
                                background: active ? 'rgba(34,211,138,0.08)' : 'transparent',
                                color: active ? 'var(--accent-emerald)' : 'var(--text-tertiary)',
                                fontSize: '11px',
                                fontFamily: "'Commit Mono', monospace",
                                cursor: 'pointer',
                                fontWeight: active ? 700 : 400,
                                transition: 'all 0.12s ease',
                              }}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>

                      {/* Custom select for when there are many options */}
                      {def.options.length > 3 && (
                        <div style={{ position: 'relative' }}>
                          <select
                            value={reasoningPresets[def.id]}
                            onChange={(e) => onPresetsChange({ ...reasoningPresets, [def.id]: e.target.value } as ReasoningPresetState)}
                            style={{
                              width: '100%',
                              appearance: 'none',
                              background: 'var(--bg-base)',
                              border: '1px solid var(--border-default)',
                              borderRadius: '8px',
                              padding: '6px 32px 6px 10px',
                              color: 'var(--text-primary)',
                              fontFamily: "'Commit Mono', monospace",
                              fontSize: '11px',
                              outline: 'none',
                              cursor: 'pointer',
                            }}
                            aria-label={`${def.label} reasoning level`}
                          >
                            {def.options.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                          <ChevronDown size={12} style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', pointerEvents: 'none' }} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Tab 2: Swarm Config ── */}
          {activeTab === 'Swarm Config' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

              {/* Agent count */}
              <div>
                <div style={{
                  fontSize: '11px', fontFamily: "'Commit Mono', monospace",
                  color: 'var(--text-tertiary)', textTransform: 'uppercase',
                  letterSpacing: '0.08em', marginBottom: '12px',
                }}>
                  Agent Count
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {AGENT_COUNT_OPTIONS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => onAgentCountChange(n)}
                      style={{
                        flex: 1,
                        padding: '12px 0',
                        borderRadius: '10px',
                        border: `1px solid ${agentCount === n ? 'var(--accent-emerald)' : 'var(--border-default)'}`,
                        background: agentCount === n ? 'rgba(34,211,138,0.08)' : 'var(--bg-base)',
                        color: agentCount === n ? 'var(--accent-emerald)' : 'var(--text-secondary)',
                        fontSize: '22px',
                        fontFamily: "'Commit Mono', monospace",
                        fontWeight: 700,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: '4px',
                      }}
                    >
                      {n}
                      <span style={{ fontSize: '9px', fontWeight: 400, color: 'var(--text-tertiary)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                        agents
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Layer diagram */}
              <div>
                <div style={{
                  fontSize: '11px', fontFamily: "'Commit Mono', monospace",
                  color: 'var(--text-tertiary)', textTransform: 'uppercase',
                  letterSpacing: '0.08em', marginBottom: '4px',
                }}>
                  Deliberation Layers
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace", marginBottom: '12px' }}>
                  How {agentCount} agents are distributed across the pipeline
                </div>
                <div style={{
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-default)',
                  borderRadius: '12px',
                  padding: '18px 20px',
                }}>
                  <SwarmDiagram agentCount={agentCount} />
                </div>
              </div>

              {/* Provider breakdown */}
              <div>
                <div style={{
                  fontSize: '11px', fontFamily: "'Commit Mono', monospace",
                  color: 'var(--text-tertiary)', textTransform: 'uppercase',
                  letterSpacing: '0.08em', marginBottom: '12px',
                }}>
                  Model Mix
                </div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  {[
                    { provider: 'gemini', label: 'Gemini Pro', count: Math.ceil(agentCount / 4), sublabel: 'gemini-3-flash-preview' },
                    { provider: 'gemini', label: 'Gemini Flash', count: Math.ceil(agentCount / 4), sublabel: 'gemini-3.1-flash-lite-preview' },
                    { provider: 'openrouter', label: 'OpenRouter', count: Math.ceil(agentCount / 4), sublabel: 'qwen/qwen3.5-flash-02-23' },
                    { provider: 'claude', label: 'Claude', count: Math.floor(agentCount / 4), sublabel: 'claude-sonnet-4-6' },
                  ].map((m) => (
                    <div key={m.label} style={{
                      display: 'flex', alignItems: 'center', gap: '8px',
                      padding: '8px 12px',
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border-default)',
                      borderRadius: '8px',
                      flex: '1 1 180px',
                    }}>
                      <ProviderLogo provider={m.provider} size={18} />
                      <div>
                        <div style={{ fontSize: '11px', fontFamily: "'Commit Mono', monospace", color: 'var(--text-primary)', fontWeight: 600 }}>{m.label}</div>
                        <div style={{ fontSize: '9px', color: 'var(--text-tertiary)', fontFamily: "'Commit Mono', monospace" }}>{m.sublabel}</div>
                      </div>
                      <div style={{ marginLeft: 'auto', fontSize: '16px', fontFamily: "'Commit Mono', monospace", color: 'var(--accent-emerald)', fontWeight: 700 }}>
                        ×{m.count}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid var(--border-default)',
          display: 'flex',
          justifyContent: 'flex-end',
          flexShrink: 0,
          gap: '12px',
          alignItems: 'center',
        }}>
          {stakesOverLimit && (
            <span style={{
              fontSize: '11px',
              fontFamily: "'Commit Mono', monospace",
              color: '#f87171',
              marginRight: 'auto',
            }}>
              Fix stake amount to continue
            </span>
          )}
          <button
            type="button"
            onClick={stakesOverLimit ? undefined : onClose}
            disabled={stakesOverLimit}
            style={{
              padding: '9px 22px',
              borderRadius: '8px',
              background: stakesOverLimit ? 'var(--border-default)' : 'var(--accent-emerald)',
              color: stakesOverLimit ? 'var(--text-tertiary)' : '#000',
              border: 'none',
              cursor: stakesOverLimit ? 'not-allowed' : 'pointer',
              fontSize: '12px',
              fontFamily: "'Commit Mono', monospace",
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              opacity: stakesOverLimit ? 0.45 : 1,
              transition: 'opacity 0.2s ease, background 0.2s ease, color 0.2s ease',
              filter: stakesOverLimit ? 'blur(0.5px)' : 'none',
            }}
          >
            Done
          </button>
        </div>
      </div>
    </>
  );
}
