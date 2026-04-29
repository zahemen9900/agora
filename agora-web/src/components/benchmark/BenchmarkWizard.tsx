import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  HelpCircle,
  RefreshCcw,
  X,
} from "lucide-react";
import { EnsemblePlan } from "../EnsemblePlan";
import { ReasoningPresetControls } from "../ReasoningPresetControls";
import { TierModelSelectorGrid } from "../TierModelSelectorGrid";
import type { BenchmarkDomainName, BenchmarkPromptTemplatesPayload } from "../../lib/api";
import type {
  DeliberationRuntimeConfigLike,
  EnsembleRosterItem,
  ProviderTier,
  ReasoningPresetState,
  TierModelOverrideState,
} from "../../lib/deliberationConfig";
import type { ProviderName } from "../../lib/modelProviders";
import { usePostHog } from "@posthog/react";

const FONT = "'Commit Mono', 'SF Mono', monospace";
const WIZARD_KF_ID = "bm-wizard-kf";

function injectWizardKeyframes() {
  if (document.getElementById(WIZARD_KF_ID)) return;
  const s = document.createElement("style");
  s.id = WIZARD_KF_ID;
  s.textContent = `
    @keyframes bm-wizard-in {
      from { opacity: 0; transform: translateY(18px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes bm-step-fade {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(s);
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DomainPromptSelection {
  templateId: string | null;
  templateTitle: string | null;
  question: string;
  useCustomPrompt: boolean;
  customQuestion: string;
}

export interface BenchmarkWizardProps {
  open: boolean;
  onClose: () => void;
  // Step 0 — config
  agentCount: number;
  onAgentCountChange: (n: number) => void;
  trainingPerCategory: number;
  onTrainingChange: (n: number) => void;
  holdoutPerCategory: number;
  onHoldoutChange: (n: number) => void;
  reasoningPresets: ReasoningPresetState;
  onPresetsChange: (v: ReasoningPresetState) => void;
  runtimeConfig?: DeliberationRuntimeConfigLike | null;
  tierModelOverrides: TierModelOverrideState;
  onTierModelOverridesChange: (next: TierModelOverrideState) => void;
  voteRoster: EnsembleRosterItem[];
  debateRoster: EnsembleRosterItem[];
  countBadges: Array<{ key: ProviderTier; provider: ProviderName; label: string; count: number }>;
  ensembleLabel: string;
  debateFooter: string;
  // Step 1 — domains
  activeDomain: BenchmarkDomainName;
  onDomainChange: (d: BenchmarkDomainName) => void;
  templates: BenchmarkPromptTemplatesPayload;
  domainPromptSelection: Partial<Record<BenchmarkDomainName, DomainPromptSelection>>;
  onDomainUpdate: (domain: BenchmarkDomainName, updater: (cur: DomainPromptSelection) => DomainPromptSelection) => void;
  domainStatus: Record<BenchmarkDomainName, { complete: boolean; label: string }>;
  allDomainsConfigured: boolean;
  // Step 2 — submit
  isSubmitting: boolean;
  onSubmit: () => void;
  submitError: string | null;
}

const BENCHMARK_DOMAINS: BenchmarkDomainName[] = ["math", "factual", "reasoning", "code", "creative", "demo"];

function normalizeText(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

function titleCase(v: string): string {
  return v.split(/[_\s-]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

// ── Step Progress Indicator ────────────────────────────────────────────────────

const STEP_LABELS = ["Configure", "Questions", "Review"];

function StepIndicator({ step }: { step: number }) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      padding: "24px 32px 20px", gap: 0,
    }}>
      {STEP_LABELS.map((label, i) => (
        <div key={label} style={{ display: "flex", alignItems: "flex-start", flex: i < STEP_LABELS.length - 1 ? 1 : 0 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "7px", flexShrink: 0 }}>
            <div style={{
              width: "28px", height: "28px", borderRadius: "50%",
              background: i <= step ? "var(--accent-emerald)" : "transparent",
              border: `2px solid ${i <= step ? "var(--accent-emerald)" : "var(--border-strong)"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: FONT, fontSize: "11px", fontWeight: 700,
              color: i <= step ? "#000" : "var(--text-tertiary)",
              transition: "all 0.3s ease",
              flexShrink: 0,
            }}>
              {i < step ? <Check size={13} strokeWidth={2.5} /> : String(i + 1)}
            </div>
            <span style={{
              fontFamily: FONT, fontSize: "9px", letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: i === step ? "var(--text-primary)" : "var(--text-tertiary)",
              whiteSpace: "nowrap",
            }}>{label}</span>
          </div>
          {i < STEP_LABELS.length - 1 && (
            <div style={{
              height: "2px", flex: 1, margin: "13px 6px 0",
              background: i < step ? "var(--accent-emerald)" : "var(--border-default)",
              transition: "background 0.3s ease",
            }} />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Tooltip Label (with ? button) ─────────────────────────────────────────────

function TooltipLabel({ label, tip }: { label: string; tip: string }) {
    const posthog = usePostHog();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "5px", position: "relative" }}>
      <span style={{ fontFamily: FONT, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-tertiary)", fontWeight: 600 }}>
        {label}
      </span>
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label={`Help: ${label}`}
        style={{ background: "transparent", border: "none", cursor: "pointer", color: open ? "var(--accent-emerald)" : "var(--text-muted)", padding: "0", display: "flex", alignItems: "center", transition: "color 0.15s ease" }} onClick={() => posthog?.capture('benchmarkwizard_action_clicked')}
      >
        <HelpCircle size={12} />
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 8px)", left: 0,
          width: "240px", padding: "10px 13px",
          background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
          borderRadius: "8px", zIndex: 400, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          fontFamily: FONT, fontSize: "11px", color: "var(--text-secondary)", lineHeight: 1.65,
          pointerEvents: "none",
        }}>
          {tip}
        </div>
      )}
    </div>
  );
}

// ── Agent Count Cards ──────────────────────────────────────────────────────────

const AGENT_OPTIONS = [
  { count: 4, label: "Balanced", sub: "Fastest, cost-effective" },
  { count: 8, label: "Thorough", sub: "Higher diversity" },
  { count: 12, label: "Exhaustive", sub: "Maximum coverage" },
];

function AgentCard({ option, selected, onClick }: { option: typeof AGENT_OPTIONS[number]; selected: boolean; onClick: () => void }) {
    const posthog = usePostHog();
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button" onClick={(e: any) => { posthog?.capture('benchmarkwizard_action_clicked'); const handler = onClick; if (typeof handler === 'function') (handler as any)(e); }}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        flex: 1, padding: "14px 14px 12px", borderRadius: "10px", textAlign: "left",
        border: `1.5px solid ${selected ? "var(--accent-emerald)" : hovered ? "var(--border-strong)" : "var(--border-default)"}`,
        background: selected ? "var(--accent-emerald-soft)" : hovered ? "var(--bg-subtle)" : "var(--bg-base)",
        cursor: "pointer",
        transition: "all 0.15s ease",
        transform: hovered && !selected ? "translateY(-1px)" : "translateY(0)",
      }}
    >
      {/* Dot grid — fixed 4-column grid so 8 and 12 wrap cleanly */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 8px)", gap: "3px", marginBottom: "10px", width: "fit-content" }}>
        {Array.from({ length: option.count }).map((_, i) => (
          <div key={i} style={{
            width: "8px", height: "8px", borderRadius: "50%",
            background: selected ? "var(--accent-emerald)" : hovered ? "var(--border-strong)" : "var(--border-default)",
            transition: "background 0.15s ease",
          }} />
        ))}
      </div>
      <div style={{ fontFamily: FONT, fontSize: "12px", fontWeight: 700, color: selected ? "var(--accent-emerald)" : "var(--text-primary)", marginBottom: "3px" }}>
        {option.count} AGENTS
      </div>
      <div style={{ fontFamily: FONT, fontSize: "9px", color: selected ? "var(--accent-emerald)" : "var(--text-tertiary)" }}>
        {option.label}
      </div>
      <div style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>
        {option.sub}
      </div>
    </button>
  );
}

// ── Domain Sidebar ─────────────────────────────────────────────────────────────

function DomainSidebar({
  activeDomain, onDomainChange, domainStatus,
}: {
  activeDomain: BenchmarkDomainName;
  onDomainChange: (d: BenchmarkDomainName) => void;
  domainStatus: Record<BenchmarkDomainName, { complete: boolean; label: string }>;
}) {
    const posthog = usePostHog();
  const configured = BENCHMARK_DOMAINS.filter((d) => domainStatus[d].complete).length;
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      background: "var(--bg-base)", borderRadius: "10px",
      border: "1px solid var(--border-default)", overflow: "hidden",
    }}>
      <div style={{ padding: "12px 14px 8px", borderBottom: "1px solid var(--border-default)" }}>
        <div style={{ fontFamily: FONT, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-tertiary)", fontWeight: 600, marginBottom: "2px" }}>
          Domain Coverage
        </div>
        <div style={{ fontFamily: FONT, fontSize: "10px", color: configured === 6 ? "var(--accent-emerald)" : "var(--text-muted)" }}>
          {configured} / 6 configured
        </div>
      </div>
      {BENCHMARK_DOMAINS.map((domain) => {
        const isActive = activeDomain === domain;
        const isDone = domainStatus[domain].complete;
        return (
          <button
            key={domain}
            type="button"
            onClick={(e: any) => { posthog?.capture('benchmarkwizard_action_clicked'); const handler = () => onDomainChange(domain); if (typeof handler === 'function') (handler as any)(e); }}
            style={{
              display: "flex", alignItems: "center", gap: "8px",
              padding: "9px 14px", textAlign: "left",
              borderLeft: `2px solid ${isActive ? "var(--accent-emerald)" : "transparent"}`,
              background: isActive ? "var(--accent-emerald-soft)" : "transparent",
              cursor: "pointer", border: "none", width: "100%",
              borderBottom: "1px solid var(--border-default)",
              transition: "background 0.12s ease",
            }}
            onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-subtle)"; }}
            onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
          >
            <div style={{ flexShrink: 0, width: "14px", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {isDone
                ? <CheckCircle2 size={13} color="var(--accent-emerald)" />
                : <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: isActive ? "var(--accent-emerald)" : "var(--border-strong)", display: "inline-block" }} />
              }
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: FONT, fontSize: "11px", fontWeight: 600, color: isActive ? "var(--accent-emerald)" : "var(--text-primary)", marginBottom: "1px" }}>
                {titleCase(domain)}
              </div>
              <div style={{ fontFamily: FONT, fontSize: "9px", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {domainStatus[domain].label}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Template Cards ─────────────────────────────────────────────────────────────

function TemplateCard({
  template, selected, onClick,
}: {
  template: { id: string; title: string; question: string };
  selected: boolean;
  onClick: () => void;
}) {
    const posthog = usePostHog();
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button" onClick={(e: any) => { posthog?.capture('benchmarkwizard_action_clicked'); const handler = onClick; if (typeof handler === 'function') (handler as any)(e); }}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        textAlign: "left", padding: "12px 14px", borderRadius: "8px",
        border: `1px solid ${selected ? "var(--accent-emerald)" : hovered ? "var(--border-strong)" : "var(--border-default)"}`,
        background: selected ? "var(--accent-emerald-soft)" : hovered ? "var(--bg-subtle)" : "var(--bg-base)",
        cursor: "pointer",
        transition: "all 0.15s ease",
        transform: hovered && !selected ? "translateY(-1px)" : "translateY(0)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "7px" }}>
        <span style={{ fontFamily: FONT, fontSize: "10px", color: selected ? "var(--accent-emerald)" : "var(--text-secondary)", fontWeight: 600 }}>
          {template.title}
        </span>
        {selected && (
          <span style={{ fontFamily: FONT, fontSize: "8px", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--accent-emerald)", padding: "1px 5px", borderRadius: "3px", background: "rgba(34,211,138,0.15)", border: "1px solid rgba(34,211,138,0.3)", flexShrink: 0 }}>
            SELECTED
          </span>
        )}
      </div>
      <p style={{
        fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "11px",
        color: "var(--text-tertiary)", lineHeight: 1.55, margin: 0,
        display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const,
        overflow: "hidden",
      }}>
        {template.question}
      </p>
    </button>
  );
}

// ── Step 0: Configuration ─────────────────────────────────────────────────────

function Step0({
  agentCount, onAgentCountChange,
  trainingPerCategory, onTrainingChange,
  holdoutPerCategory, onHoldoutChange,
  reasoningPresets, onPresetsChange,
  runtimeConfig, tierModelOverrides, onTierModelOverridesChange,
  voteRoster, debateRoster, countBadges, ensembleLabel, debateFooter,
}: Pick<BenchmarkWizardProps,
  "agentCount" | "onAgentCountChange" | "trainingPerCategory" | "onTrainingChange" |
  "holdoutPerCategory" | "onHoldoutChange" | "reasoningPresets" | "onPresetsChange" |
  "runtimeConfig" | "tierModelOverrides" | "onTierModelOverridesChange" |
  "voteRoster" | "debateRoster" | "countBadges" | "ensembleLabel" | "debateFooter"
>) {
  return (
    <div style={{ animation: "bm-step-fade 0.22s ease-out both" }}>
      {/* Agent count */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{ fontFamily: FONT, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-tertiary)", fontWeight: 600, marginBottom: "12px" }}>
          Agent Count
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          {AGENT_OPTIONS.map((opt) => (
            <AgentCard key={opt.count} option={opt} selected={agentCount === opt.count} onClick={() => onAgentCountChange(opt.count)} />
          ))}
        </div>
      </div>

      {/* Training / Holdout */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "24px" }}>
        <div>
          <TooltipLabel
            label="Training / Domain"
            tip="Number of questions used to train the selector before evaluation. Higher values improve adaptation but increase cost and run time."
          />
          <input
            type="number" min={1} max={20} value={trainingPerCategory}
            onChange={(e) => onTrainingChange(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            style={{
              display: "block", marginTop: "8px", width: "100%",
              padding: "8px 12px", borderRadius: "8px",
              border: "1px solid var(--border-default)", background: "var(--bg-base)",
              fontFamily: FONT, fontSize: "13px", color: "var(--text-primary)",
              outline: "none", transition: "border-color 0.15s ease",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent-emerald)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; }}
          />
        </div>
        <div>
          <TooltipLabel
            label="Holdout / Domain"
            tip="Questions held back for evaluation only — never seen during training. Higher values give more reliable accuracy estimates at the cost of longer runs."
          />
          <input
            type="number" min={1} max={10} value={holdoutPerCategory}
            onChange={(e) => onHoldoutChange(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            style={{
              display: "block", marginTop: "8px", width: "100%",
              padding: "8px 12px", borderRadius: "8px",
              border: "1px solid var(--border-default)", background: "var(--bg-base)",
              fontFamily: FONT, fontSize: "13px", color: "var(--text-primary)",
              outline: "none", transition: "border-color 0.15s ease",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent-emerald)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; }}
          />
        </div>
      </div>

      {/* Reasoning presets */}
      <div style={{
        marginBottom: "24px", padding: "16px 18px",
        background: "var(--bg-base)", borderRadius: "10px",
        border: "1px solid var(--border-default)",
        borderLeft: "3px solid var(--accent-emerald)",
      }}>
        <div style={{ fontFamily: FONT, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-tertiary)", fontWeight: 600, marginBottom: "12px" }}>
          Reasoning Presets
        </div>
        <ReasoningPresetControls
          value={reasoningPresets}
          onChange={onPresetsChange}
          runtimeConfig={runtimeConfig}
          tierModelOverrides={tierModelOverrides}
        />
      </div>

      <div style={{ marginBottom: "24px" }}>
        <div style={{ fontFamily: FONT, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-tertiary)", fontWeight: 600, marginBottom: "12px" }}>
          Tier Models
        </div>
        <TierModelSelectorGrid
          runtimeConfig={runtimeConfig}
          value={tierModelOverrides}
          onChange={onTierModelOverridesChange}
        />
      </div>

      {/* Ensemble plans — collapsible */}
      <EnsemblePlansAccordion
        ensembleLabel={ensembleLabel}
        voteRoster={voteRoster}
        debateRoster={debateRoster}
        countBadges={countBadges}
        debateFooter={debateFooter}
      />
    </div>
  );
}

function EnsemblePlansAccordion({
  ensembleLabel, voteRoster, debateRoster, countBadges, debateFooter,
}: Pick<BenchmarkWizardProps, "voteRoster" | "debateRoster" | "countBadges" | "ensembleLabel" | "debateFooter">) {
    const posthog = usePostHog();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  return (
    <div style={{ borderRadius: "10px", border: "1px solid var(--border-default)", overflow: "hidden" }}>
      <button
        type="button"
        onClick={(e: any) => { posthog?.capture('benchmarkwizard_action_clicked'); const handler = () => setOpen((v) => !v); if (typeof handler === 'function') (handler as any)(e); }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", padding: "12px 16px",
          background: hovered ? "var(--bg-subtle)" : "var(--bg-base)",
          border: "none", cursor: "pointer",
          transition: "background 0.15s ease",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontFamily: FONT, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-tertiary)", fontWeight: 600 }}>
            Model Plans
          </span>
          <span style={{
            fontFamily: FONT, fontSize: "9px", padding: "1px 7px", borderRadius: "4px",
            background: "var(--bg-elevated)", color: "var(--text-muted)",
            border: "1px solid var(--border-default)",
          }}>
            {ensembleLabel}
          </span>
        </div>
        <ChevronDown
          size={14}
          color="var(--text-tertiary)"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s ease", flexShrink: 0 }}
        />
      </button>

      {open && (
        <div style={{ borderTop: "1px solid var(--border-default)", padding: "14px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <div style={{ background: "var(--bg-elevated)", borderRadius: "8px", border: "1px solid var(--border-default)", overflow: "hidden" }}>
            <EnsemblePlan title="VOTE MODEL PLAN" label={ensembleLabel} items={voteRoster} countBadges={countBadges} />
          </div>
          <div style={{ background: "var(--bg-elevated)", borderRadius: "8px", border: "1px solid var(--border-default)", overflow: "hidden" }}>
            <EnsemblePlan title="DEBATE MODEL PLAN" label={ensembleLabel} items={debateRoster} countBadges={countBadges} footer={debateFooter} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step 1: Domain Questions ───────────────────────────────────────────────────

function Step1({
  activeDomain, onDomainChange, templates,
  domainPromptSelection, onDomainUpdate, domainStatus,
}: Pick<BenchmarkWizardProps,
  "activeDomain" | "onDomainChange" | "templates" |
  "domainPromptSelection" | "onDomainUpdate" | "domainStatus"
>) {
    const posthog = usePostHog();
  const currentSelection = domainPromptSelection[activeDomain];
  const domainTemplates = templates.domains[activeDomain] ?? [];
  const selectedTemplate = domainTemplates.find((t) => t.id === currentSelection?.templateId);
  const isCustom = currentSelection?.useCustomPrompt ?? false;

  const domainCount = BENCHMARK_DOMAINS.length;
  const activeDomainIndex = BENCHMARK_DOMAINS.indexOf(activeDomain);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "210px 1fr", gap: "14px", animation: "bm-step-fade 0.22s ease-out both" }}>
      {/* Left: Domain sidebar */}
      <DomainSidebar activeDomain={activeDomain} onDomainChange={onDomainChange} domainStatus={domainStatus} />

      {/* Right: Question panel */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
          <div>
            <div style={{ fontFamily: FONT, fontSize: "11px", fontWeight: 700, color: "var(--text-primary)", marginBottom: "2px" }}>
              {titleCase(activeDomain)} Question
            </div>
            <div style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "11px", color: "var(--text-secondary)" }}>
              Pick a template or write your own question for this domain.
            </div>
          </div>
          {/* Template / Custom toggle */}
          <div style={{ display: "inline-flex", borderRadius: "7px", border: "1px solid var(--border-default)", overflow: "hidden", flexShrink: 0 }}>
            <button
              type="button"
              onClick={(e: any) => { posthog?.capture('benchmarkwizard_template_clicked'); const handler = () => onDomainUpdate(activeDomain, (cur) => ({
                                                                ...cur, useCustomPrompt: false,
                                                                question: selectedTemplate?.question ?? cur.question,
                                                                templateTitle: selectedTemplate?.title ?? cur.templateTitle,
                                                              })); if (typeof handler === 'function') (handler as any)(e); }}
              style={{
                fontFamily: FONT, fontSize: "10px", padding: "5px 12px",
                background: !isCustom ? "var(--accent-emerald-soft)" : "transparent",
                color: !isCustom ? "var(--accent-emerald)" : "var(--text-secondary)",
                border: "none", cursor: "pointer", transition: "all 0.15s ease",
              }}
            >Template</button>
            <button
              type="button"
              onClick={(e: any) => { posthog?.capture('benchmarkwizard_custom_clicked'); const handler = () => onDomainUpdate(activeDomain, (cur) => {
                                                                if (cur.useCustomPrompt) return cur;
                                                                const seeded = normalizeText(cur.customQuestion) || normalizeText(selectedTemplate?.question) || normalizeText(cur.question);
                                                                return { ...cur, useCustomPrompt: true, customQuestion: seeded, question: seeded || cur.question };
                                                              }); if (typeof handler === 'function') (handler as any)(e); }}
              style={{
                fontFamily: FONT, fontSize: "10px", padding: "5px 12px",
                background: isCustom ? "var(--accent-emerald-soft)" : "transparent",
                color: isCustom ? "var(--accent-emerald)" : "var(--text-secondary)",
                border: "none", cursor: "pointer", transition: "all 0.15s ease",
                borderLeft: "1px solid var(--border-default)",
              }}
            >Custom</button>
          </div>
        </div>

        {/* Template grid */}
        {!isCustom && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            {domainTemplates.map((tpl) => (
              <TemplateCard
                key={tpl.id}
                template={tpl}
                selected={currentSelection?.templateId === tpl.id && !isCustom}
                onClick={() => onDomainUpdate(activeDomain, (cur) => ({
                  ...cur, templateId: tpl.id, templateTitle: tpl.title,
                  question: tpl.question, useCustomPrompt: false,
                }))}
              />
            ))}
          </div>
        )}

        {/* Custom mode */}
        {isCustom && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {selectedTemplate && (
              <div style={{ padding: "10px 13px", borderRadius: "8px", background: "var(--bg-base)", border: "1px solid var(--border-default)" }}>
                <div style={{ fontFamily: FONT, fontSize: "9px", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: "5px" }}>
                  STARTING FROM: {selectedTemplate.title.toUpperCase()}
                </div>
                <p style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "11px", color: "var(--text-tertiary)", margin: 0, lineHeight: 1.55 }}>
                  {selectedTemplate.question}
                </p>
              </div>
            )}
            <textarea
              value={currentSelection?.customQuestion ?? ""}
              onChange={(e) => onDomainUpdate(activeDomain, (cur) => ({
                ...cur, customQuestion: e.target.value, question: e.target.value, useCustomPrompt: true,
              }))}
              placeholder={`Write the exact benchmark question for ${titleCase(activeDomain)}…`}
              rows={7}
              style={{
                width: "100%", padding: "10px 13px", borderRadius: "8px",
                border: "1px solid var(--border-default)", background: "var(--bg-base)",
                fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "12px", color: "var(--text-primary)",
                lineHeight: 1.6, resize: "vertical", outline: "none",
                transition: "border-color 0.15s ease", boxSizing: "border-box",
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent-emerald)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; }}
            />
          </div>
        )}

        {/* Selected question preview */}
        {!isCustom && (
          <div style={{ padding: "10px 13px", borderRadius: "8px", background: "var(--bg-base)", border: "1px solid var(--border-default)" }}>
            <div style={{ fontFamily: FONT, fontSize: "9px", color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: "6px" }}>
              SELECTED QUESTION
            </div>
            <p style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "12px", color: "var(--text-secondary)", margin: 0, lineHeight: 1.6 }}>
              {normalizeText(currentSelection?.question) || "Choose a question above or switch to custom mode."}
            </p>
          </div>
        )}

        {/* Domain prev/next nav */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "6px", marginTop: "4px" }}>
          <button
            type="button" disabled={activeDomainIndex === 0}
            onClick={(e: any) => { posthog?.capture('benchmarkwizard_prev_clicked'); const handler = () => onDomainChange(BENCHMARK_DOMAINS[activeDomainIndex - 1]!); if (typeof handler === 'function') (handler as any)(e); }}
            style={{
              display: "inline-flex", alignItems: "center", gap: "4px",
              fontFamily: FONT, fontSize: "10px", padding: "5px 10px", borderRadius: "6px",
              border: "1px solid var(--border-default)", background: "transparent",
              color: activeDomainIndex === 0 ? "var(--text-muted)" : "var(--text-secondary)",
              cursor: activeDomainIndex === 0 ? "not-allowed" : "pointer", opacity: activeDomainIndex === 0 ? 0.4 : 1,
            }}
          ><ChevronLeft size={12} /> Prev</button>
          <button
            type="button" disabled={activeDomainIndex === domainCount - 1}
            onClick={(e: any) => { posthog?.capture('benchmarkwizard_next_clicked'); const handler = () => onDomainChange(BENCHMARK_DOMAINS[activeDomainIndex + 1]!); if (typeof handler === 'function') (handler as any)(e); }}
            style={{
              display: "inline-flex", alignItems: "center", gap: "4px",
              fontFamily: FONT, fontSize: "10px", padding: "5px 10px", borderRadius: "6px",
              border: "1px solid var(--border-default)", background: "transparent",
              color: activeDomainIndex === domainCount - 1 ? "var(--text-muted)" : "var(--text-secondary)",
              cursor: activeDomainIndex === domainCount - 1 ? "not-allowed" : "pointer", opacity: activeDomainIndex === domainCount - 1 ? 0.4 : 1,
            }}
          >Next <ChevronRight size={12} /></button>
        </div>
      </div>
    </div>
  );
}

// ── Step 2: Review ─────────────────────────────────────────────────────────────

function Step2({
  agentCount, trainingPerCategory, holdoutPerCategory, reasoningPresets,
  domainPromptSelection,
}: Pick<BenchmarkWizardProps,
  "agentCount" | "trainingPerCategory" | "holdoutPerCategory" | "reasoningPresets" | "domainPromptSelection"
>) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", animation: "bm-step-fade 0.22s ease-out both" }}>
      {/* Config summary */}
      <div style={{ padding: "14px 16px", borderRadius: "10px", background: "var(--bg-base)", border: "1px solid var(--border-default)" }}>
        <div style={{ fontFamily: FONT, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-tertiary)", fontWeight: 600, marginBottom: "8px" }}>
          Run Configuration
        </div>
        <div style={{ fontFamily: FONT, fontSize: "12px", color: "var(--text-secondary)", marginBottom: "10px" }}>
          {agentCount} agents · training {trainingPerCategory}/domain · holdout {holdoutPerCategory}/domain
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {Object.entries(reasoningPresets).map(([key, value]) => (
            <span key={key} style={{
              fontFamily: FONT, fontSize: "9px", letterSpacing: "0.06em", textTransform: "uppercase",
              padding: "2px 8px", borderRadius: "4px",
              background: "var(--bg-elevated)", color: "var(--text-secondary)",
              border: "1px solid var(--border-default)",
            }}>
              {key.replace("_", " ")} {value}
            </span>
          ))}
        </div>
      </div>

      {/* Domain questions */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {BENCHMARK_DOMAINS.map((domain) => {
          const selection = domainPromptSelection[domain];
          if (!selection) return null;
          return (
            <div key={domain} style={{
              padding: "11px 14px", borderRadius: "8px",
              background: "var(--bg-base)", border: "1px solid var(--border-default)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "5px" }}>
                <span style={{ fontFamily: FONT, fontSize: "11px", fontWeight: 700, color: "var(--text-primary)" }}>
                  {titleCase(domain)}
                </span>
                <span style={{
                  fontFamily: FONT, fontSize: "9px", letterSpacing: "0.05em",
                  color: "var(--text-muted)", padding: "1px 6px", borderRadius: "4px",
                  background: "var(--bg-subtle)", border: "1px solid var(--border-default)",
                }}>
                  {selection.useCustomPrompt ? "custom" : (selection.templateTitle ?? "template")}
                </span>
              </div>
              <p style={{
                fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "11px",
                color: "var(--text-secondary)", margin: 0, lineHeight: 1.55,
                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const,
                overflow: "hidden",
              }}>
                {normalizeText(selection.question) || "No question selected."}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Wizard Component ──────────────────────────────────────────────────────

export function BenchmarkWizard(props: BenchmarkWizardProps) {
    const posthog = usePostHog();
  const {
    open, onClose,
    agentCount, onAgentCountChange, trainingPerCategory, onTrainingChange,
    holdoutPerCategory, onHoldoutChange, reasoningPresets, onPresetsChange,
    runtimeConfig, tierModelOverrides, onTierModelOverridesChange,
    voteRoster, debateRoster, countBadges, ensembleLabel, debateFooter,
    activeDomain, onDomainChange, templates, domainPromptSelection,
    onDomainUpdate, domainStatus, allDomainsConfigured,
    isSubmitting, onSubmit, submitError,
  } = props;

  const [step, setStep] = useState(0);

  useEffect(() => { injectWizardKeyframes(); }, []);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.65)", backdropFilter: "blur(8px)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "24px 16px 40px", overflowY: "auto",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: "min(820px, calc(100vw - 32px))",
        background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
        borderRadius: "20px", boxShadow: "0 32px 80px rgba(0,0,0,0.5)",
        animation: "bm-wizard-in 0.28s cubic-bezier(0.22,1,0.36,1) both",
        overflow: "hidden",
      }}>
        {/* Header bar */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "20px 24px 0",
        }}>
          <div>
            <div style={{ fontFamily: FONT, fontSize: "14px", fontWeight: 700, color: "var(--text-primary)", marginBottom: "3px" }}>
              Benchmark Run Wizard
            </div>
            <div style={{ fontFamily: "'Hanken Grotesk', sans-serif", fontSize: "12px", color: "var(--text-secondary)" }}>
              Configure per-domain questions, then launch a comprehensive run.
            </div>
          </div>
          <button
            type="button" onClick={(e: any) => { posthog?.capture('benchmarkwizard_close_benchmark_wizard_clicked'); const handler = onClose; if (typeof handler === 'function') (handler as any)(e); }}
            aria-label="Close benchmark wizard"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "32px", height: "32px", borderRadius: "8px",
              border: "1px solid var(--border-default)", background: "transparent",
              cursor: "pointer", color: "var(--text-secondary)",
              transition: "border-color 0.15s, color 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--border-strong)"; e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; e.currentTarget.style.color = "var(--text-secondary)"; }}
          >
            <X size={16} />
          </button>
        </div>

        <StepIndicator step={step} />

        {/* Divider */}
        <div style={{ height: "1px", background: "var(--border-default)", margin: "0 24px" }} />

        {/* Step content */}
        <div style={{ padding: "24px", overflowY: "auto", maxHeight: "calc(88vh - 260px)" }}>
          {step === 0 && (
            <Step0
              agentCount={agentCount} onAgentCountChange={onAgentCountChange}
              trainingPerCategory={trainingPerCategory} onTrainingChange={onTrainingChange}
              holdoutPerCategory={holdoutPerCategory} onHoldoutChange={onHoldoutChange}
              reasoningPresets={reasoningPresets} onPresetsChange={onPresetsChange}
              runtimeConfig={runtimeConfig}
              tierModelOverrides={tierModelOverrides}
              onTierModelOverridesChange={onTierModelOverridesChange}
              voteRoster={voteRoster} debateRoster={debateRoster}
              countBadges={countBadges} ensembleLabel={ensembleLabel} debateFooter={debateFooter}
            />
          )}
          {step === 1 && (
            <Step1
              activeDomain={activeDomain} onDomainChange={onDomainChange}
              templates={templates} domainPromptSelection={domainPromptSelection}
              onDomainUpdate={onDomainUpdate} domainStatus={domainStatus}
            />
          )}
          {step === 2 && (
            <Step2
              agentCount={agentCount} trainingPerCategory={trainingPerCategory}
              holdoutPerCategory={holdoutPerCategory} reasoningPresets={reasoningPresets}
              domainPromptSelection={domainPromptSelection}
            />
          )}
        </div>

        {/* Footer: errors + nav buttons */}
        <div style={{ borderTop: "1px solid var(--border-default)", padding: "16px 24px" }}>
          {submitError && (
            <div style={{
              fontFamily: FONT, fontSize: "11px", color: "var(--accent-rose)",
              marginBottom: "12px", padding: "8px 12px", borderRadius: "8px",
              background: "var(--accent-rose-soft)", border: "1px solid rgba(248,113,113,0.3)",
            }}>
              {submitError}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
            <button
              type="button"
              onClick={(e: any) => { posthog?.capture('benchmarkwizard_back_clicked'); const handler = () => setStep((s) => Math.max(0, s - 1) as 0 | 1 | 2); if (typeof handler === 'function') (handler as any)(e); }}
              disabled={step === 0 || isSubmitting}
              style={{
                display: "inline-flex", alignItems: "center", gap: "6px",
                fontFamily: FONT, fontSize: "12px", fontWeight: 600,
                padding: "9px 18px", borderRadius: "9px",
                border: "1px solid var(--border-strong)", background: "transparent",
                color: step === 0 ? "var(--text-muted)" : "var(--text-secondary)",
                cursor: step === 0 || isSubmitting ? "not-allowed" : "pointer",
                opacity: step === 0 ? 0.4 : 1,
              }}
            >
              <ChevronLeft size={14} /> Back
            </button>

            {step < 2 ? (
              <button
                type="button"
                onClick={(e: any) => { posthog?.capture('benchmarkwizard_next_clicked'); const handler = () => setStep((s) => Math.min(2, s + 1) as 0 | 1 | 2); if (typeof handler === 'function') (handler as any)(e); }}
                disabled={step === 1 && !allDomainsConfigured}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "6px",
                  fontFamily: FONT, fontSize: "12px", fontWeight: 700,
                  padding: "9px 20px", borderRadius: "9px",
                  border: "none",
                  background: step === 1 && !allDomainsConfigured ? "var(--border-strong)" : "var(--accent-emerald)",
                  color: step === 1 && !allDomainsConfigured ? "var(--text-muted)" : "#000",
                  cursor: step === 1 && !allDomainsConfigured ? "not-allowed" : "pointer",
                  transition: "opacity 0.15s ease",
                }}
              >
                Next <ChevronRight size={14} />
              </button>
            ) : (
              <button
                type="button"
                onClick={(e: any) => { posthog?.capture('benchmarkwizard_action_clicked'); const handler = onSubmit; if (typeof handler === 'function') (handler as any)(e); }}
                disabled={isSubmitting}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "8px",
                  fontFamily: FONT, fontSize: "12px", fontWeight: 700,
                  padding: "9px 24px", borderRadius: "9px",
                  border: "none", background: "var(--accent-emerald)", color: "#000",
                  cursor: isSubmitting ? "not-allowed" : "pointer",
                  opacity: isSubmitting ? 0.7 : 1,
                  transition: "opacity 0.15s ease",
                }}
              >
                {isSubmitting ? <><RefreshCcw size={14} style={{ animation: "spin 1s linear infinite" }} /> Starting…</> : <><ArrowRight size={14} /> Submit Benchmark</>}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
