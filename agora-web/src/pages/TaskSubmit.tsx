import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { Settings2, ArrowRight, Loader2, Link, Plus, Globe, FileText, File, Database, Image as ImageIcon, TerminalSquare } from "lucide-react";

import { Flyout } from "../components/Flyout";
import { ConfigModal } from "../components/task/ConfigModal";
import { DecisionPopup } from "../components/task/DecisionPopup";
import { RecentDeliberationsCarousel } from "../components/task/RecentDeliberationsCarousel";
import {
  completeSourceUpload,
  initSourceUpload,
  startTaskRun,
  uploadSourceBytes,
  type MechanismName,
  type TaskRunRequestPayload,
  type TaskStatusResponse,
} from "../lib/api";
import {
  buildTierModelOverridesPayload,
  buildProviderSummary,
  DEFAULT_REASONING_PRESETS,
  resolveDefaultReasoningPresets,
  type ReasoningPresetState,
  type TierModelOverrideState,
} from "../lib/deliberationConfig";
import {
  removeDeletedTaskFromCaches,
  setTaskDetailCache,
  taskQueryKeys,
  useDeleteTaskMutation,
  useStopTaskMutation,
  useSubmitTaskMutation,
  useTaskListQuery,
} from "../lib/taskQueries";
import {
  buildTaskByokRunRequest,
  createDefaultTaskByokConfig,
  ensureTaskByokRosterLength,
  getTaskByokValidation,
  type TaskByokConfig,
} from "../lib/taskByok";
import { TASK_STOPPED_REASON } from "../lib/taskState";
import { useDeliberationRuntimeConfigQuery } from "../lib/runtimeConfigQueries";
import {
  MAX_ATTACHMENTS,
  resolveAttachmentSelection,
  SUPPORTED_FILE_ACCEPT,
  SUPPORTED_FILE_TOOLTIP,
  type PendingAttachmentFile,
} from "../lib/taskAttachments";
import { useAuth } from "../lib/useAuth";

// ── Rotating suggested prompts ────────────────────────────────────────────────
interface PromptOption { label: string; fullPrompt: string; }

const PROMPT_SETS: PromptOption[][] = [
  // Set A
  [
    {
      label: "Microservices vs monolith for a growing startup?",
      fullPrompt: "A B2C SaaS company serving 80,000 monthly active users has a 2-year-old monolithic Rails application. The engineering team is growing from 4 to 12 developers over the next year, deployment pipelines take 45 minutes end-to-end, and a major enterprise customer is signing next quarter with a 99.5% uptime SLA. Infrastructure costs $12k/month. Given operational complexity, team coordination overhead, and current scaling projections, should they migrate to microservices or invest in improving their monolith?",
    },
    {
      label: "Should AI-generated content require disclosure labels?",
      fullPrompt: "Over 40% of Gen-Z users cannot reliably distinguish AI-generated content from human-created content. Deepfakes and synthetic media cause an estimated $5 billion per year in reputational and financial harm globally. Yet mandatory disclosure would affect millions of legitimate creative tools and require cross-jurisdictional enforcement across 200+ countries with no agreed standard. Given the measurable harms of synthetic media and the creative freedoms at stake, should AI-generated content be required to carry prominent disclosure labels across social platforms?",
    },
    {
      label: "Is a 4-day workweek a net productivity win?",
      fullPrompt: "A 6-month trial across 61 UK companies that adopted a 4-day, 32-hour workweek showed 22% average productivity gains, zero revenue decline, and a 57% reduction in employee sick days. However, manufacturing and healthcare sectors saw mixed results, and some teams reported higher stress within the compressed schedule. Factoring in sector-specific constraints, managerial overhead, childcare equity implications, and competitive dynamics in global labour markets, is a universal shift to a 4-day workweek a net positive for productivity and worker wellbeing?",
    },
  ],
  // Set B
  [
    {
      label: "Should central banks issue a digital currency?",
      fullPrompt: "China's digital yuan has reached 261 million users in 2 years and the EU is in active consultation on a digital Euro. CBDCs could eliminate cross-border friction, reduce money-laundering by up to 40%, and extend financial access to the unbanked. However, they also create mass financial surveillance infrastructure, risk draining 20-30% of commercial bank deposits, and give governments unprecedented monetary control during crises. Should major central banks roll out a retail CBDC, and what legal and technical guardrails are necessary to prevent abuse?",
    },
    {
      label: "Is open-sourcing frontier AI models too dangerous?",
      fullPrompt: "Several openly released 70B+ parameter language models have demonstrated the ability to generate CBRN (chemical, biological, radiological, nuclear) weapon synthesis pathways and accelerate bioweapons research timelines. A coalition of AI safety researchers is calling for a moratorium on releasing frontier model weights publicly. Open-source advocates argue that restricted access concentrates AI power in just 5 corporations and blocks independent safety research. Given the demonstrated dual-use risks on one hand and the democratisation benefits on the other, should frontier AI model weights continue to be released to the public?",
    },
    {
      label: "Nuclear vs. renewables: fastest path to net zero?",
      fullPrompt: "The IEA projects global electricity demand to double by 2050. New nuclear plants cost $10-20 billion each and take 15-20 years to license and construct, while utility-scale solar and battery storage has dropped 90% in cost over the past decade but faces grid stability challenges above 80% penetration and requires 3-10 times more land per megawatt than nuclear. With a hard 2050 net-zero target and energy security increasingly geopolitical, should governments prioritise building new nuclear capacity or accelerating renewable buildout as the primary decarbonisation strategy for the electricity grid?",
    },
  ],
  // Set C
  [
    {
      label: "Should germline gene editing of embryos be allowed?",
      fullPrompt: "CRISPR-Cas9 technology can now edit germline human DNA with 97%+ precision, potentially eliminating heritable diseases such as cystic fibrosis and Huntington's from entire family lineages. Off-target mutations still occur in approximately 3% of edits. The WHO advisory committee conditionally endorses somatic editing but not germline modification. Critics cite a slippery slope toward designer babies and severe access inequality between wealthy and low-income nations. Given that 8 million children are born annually with serious genetic disorders, should regulated germline gene editing of human embryos for disease prevention be permitted under binding international oversight?",
    },
    {
      label: "Does social media harm democratic institutions?",
      fullPrompt: "Analysis of 40 democratic elections from 2016 to 2024 found that countries with greater than 70% social media penetration averaged 18% higher political polarisation and a 2x faster misinformation propagation rate, but also a 40% increase in youth voter registration. The EU's Digital Services Act mandates algorithmic transparency, while the US retains broad platform immunity under Section 230. Platforms remove approximately 300 million pieces of harmful content monthly but face bipartisan accusations of ideological bias. Net-weighing deliberation quality, misinformation effects, and civic participation, does social media do more harm than good for democratic institutions?",
    },
    {
      label: "Is universal basic income economically sustainable?",
      fullPrompt: "Finland's 2-year UBI pilot at €560 per month for 2,000 unemployed citizens showed improved mental wellbeing and marginal employment gains. The US Stockton SEED experiment found full-time employment among recipients rose 28%. Scaling to $1,000 per month for all US adults would cost approximately $2.5 trillion per year, requiring either a 30% income tax increase or sustained deficit spending. With automation projected to displace up to 47% of current jobs by 2035, is universal basic income economically sustainable and socially desirable when implemented at national scale?",
    },
  ],
];

function makeExampleTask(task: string, index: number): TaskStatusResponse {
  const now = new Date().toISOString();
  return {
    task_id: `example-${index}`,
    task_text: task,
    workspace_id: "demo-user",
    created_by: "demo-user",
    mechanism: "debate",
    mechanism_override: null,
    allow_mechanism_switch: true,
    allow_offline_fallback: true,
    quorum_threshold: 0.6,
    execution_source: "hosted",
    background_recovery_allowed: false,
    enable_tools: true,
    tool_policy: null,
    source_urls: [],
    source_file_ids: [],
    sources: [],
    selector_source: "llm_reasoning",
    mechanism_override_source: null,
    status: "pending",
    selector_reasoning: "Example prompt for demo purposes.",
    selector_reasoning_hash: "",
    selector_confidence: 0,
    merkle_root: null,
    decision_hash: null,
    quorum_reached: null,
    agent_count: 4,
    reasoning_presets: DEFAULT_REASONING_PRESETS,
    tier_model_overrides: null,
    round_count: 0,
    mechanism_switches: 0,
    transcript_hashes: [],
    selector_fallback_path: [],
    solana_tx_hash: null,
    explorer_url: null,
    payment_amount: 0,
    payment_status: "none",
    chain_operations: {},
    created_at: now,
    updated_at: now,
    completed_at: null,
    stop_requested_at: null,
    failure_reason: null,
    latest_error_event: null,
    result: null,
    events: [],
  };
}

const EXAMPLE_TASK_OBJECTS = PROMPT_SETS[0].map((p, i) => makeExampleTask(p.fullPrompt, i));
type MechanismPreference = MechanismName | "auto";

// ── Dynamic placeholder cycling ───────────────────────────────────────────────
const PLACEHOLDERS = [
  "Which arguments hold up under scrutiny?",
  "Frame your hardest decision for multi-agent debate",
  "Put a complex tradeoff to a council of AI agents",
  "What's the question you can't quite resolve alone?",
  "Pose the dilemma — let the agents deliberate",
  "Surface the tension in a difficult call",
];

// (placeholder cycling is handled inline in the component via phIdx/phVisible state)

// ── URL attachment modal ───────────────────────────────────────────────────────
interface UrlAttachModalProps {
  open: boolean;
  onClose: () => void;
  attachedUrls: string[];
  sourceUrlInput: string;
  onInputChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (url: string) => void;
  sourceError: string | null;
}

const ATTACHMENT_CAPABILITY_GROUPS = [
  {
    label: "Tabular",
    icon: Database,
    accent: "var(--accent-cyan)",
    values: ["CSV", "TSV", "XLSX", "XLS", "XLSB", "PARQUET"],
  },
  {
    label: "Docs",
    icon: FileText,
    accent: "var(--accent-emerald)",
    values: ["PDF", "MD", "TXT", "JSON", "YAML"],
  },
  {
    label: "Images",
    icon: ImageIcon,
    accent: "var(--accent-amber)",
    values: ["PNG", "JPG", "WEBP", "GIF"],
  },
] as const;

const SANDBOX_LIBRARY_GROUPS = [
  "pandas",
  "numpy",
  "polars",
  "duckdb",
  "pyarrow",
  "scipy",
  "openpyxl",
  "xlrd",
  "pyxlsb",
] as const;

function SandboxModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const FONT = "'Commit Mono', 'SF Mono', monospace";
  if (!open) return null;
  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.45)",
          backdropFilter: "blur(6px)",
          zIndex: 9000,
        }}
      />
      {/* Panel */}
      <div
        style={{
          position: "fixed",
          top: "50%", left: "50%",
          transform: "translate(-50%,-50%)",
          width: "min(520px, calc(100vw - 32px))",
          maxHeight: "80vh",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-strong)",
          borderRadius: "20px",
          boxShadow: "0 32px 80px rgba(0,0,0,0.45)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          zIndex: 9001,
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: "12px",
          padding: "16px 20px",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
        }}>
          <div style={{
            width: "28px", height: "28px", borderRadius: "8px",
            border: "1px solid var(--border-default)",
            background: "var(--bg-base)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--accent-emerald)", flexShrink: 0,
          }}>
            <TerminalSquare size={14} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: FONT, fontSize: "11px", letterSpacing: "0.12em", color: "var(--accent-emerald)" }}>
              SANDBOX ENVIRONMENT
            </div>
            <div style={{ fontFamily: FONT, fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>
              What agents can access and run
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              width: "28px", height: "28px", borderRadius: "50%",
              background: "var(--bg-base)", border: "1px solid var(--border-default)",
              cursor: "pointer", color: "var(--text-muted)", fontSize: "16px",
              display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
            }}
          >×</button>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: "auto", padding: "18px 20px", display: "flex", flexDirection: "column", gap: "14px" }}>
          {/* Library pills */}
          <div>
            <div style={{ fontFamily: FONT, fontSize: "10px", letterSpacing: "0.1em", color: "var(--text-muted)", marginBottom: "8px" }}>
              PYTHON STACK
            </div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {SANDBOX_LIBRARY_GROUPS.map((name) => (
                <span
                  key={name}
                  style={{
                    padding: "4px 9px", borderRadius: "999px",
                    border: "1px solid var(--border-default)",
                    background: "var(--bg-base)",
                    fontFamily: FONT, fontSize: "11px",
                    color: "var(--text-secondary)",
                  }}
                >
                  {name}
                </span>
              ))}
            </div>
          </div>

          {/* Format capability groups */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", gap: "10px" }}>
            {ATTACHMENT_CAPABILITY_GROUPS.map((group) => {
              const Icon = group.icon;
              return (
                <div
                  key={group.label}
                  style={{
                    borderRadius: "12px",
                    border: "1px solid var(--border-subtle)",
                    background: "var(--bg-base)",
                    padding: "10px 12px",
                    display: "flex", flexDirection: "column", gap: "8px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Icon size={13} style={{ color: group.accent }} />
                    <span style={{ fontFamily: FONT, fontSize: "10px", letterSpacing: "0.1em", color: "var(--text-secondary)" }}>
                      {group.label}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    {group.values.map((value) => (
                      <span
                        key={value}
                        style={{
                          padding: "3px 6px", borderRadius: "999px",
                          background: "var(--bg-elevated)",
                          border: "1px solid var(--border-subtle)",
                          fontFamily: FONT, fontSize: "9px",
                          color: "var(--text-primary)", letterSpacing: "0.06em",
                        }}
                      >
                        {value}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Usage note */}
          <div style={{
            borderRadius: "12px",
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-base)",
            padding: "12px 14px",
            display: "flex", flexDirection: "column", gap: "8px",
          }}>
            <div style={{ fontFamily: FONT, fontSize: "10px", letterSpacing: "0.1em", color: "var(--accent-emerald)" }}>
              HOW AGENTS USE THE SANDBOX
            </div>
            <div style={{ fontFamily: FONT, fontSize: "11px", lineHeight: 1.65, color: "var(--text-secondary)" }}>
              CSV and TSV can be parsed with the standard library, but binary spreadsheets and parquet should be handled with{" "}
              <span style={{ color: "var(--text-primary)" }}>pandas</span>,{" "}
              <span style={{ color: "var(--text-primary)" }}>polars</span>,{" "}
              <span style={{ color: "var(--text-primary)" }}>duckdb</span>, or{" "}
              <span style={{ color: "var(--text-primary)" }}>pyarrow</span>. PDFs and images are inspected separately. No network or <code style={{ fontFamily: FONT, fontSize: "10px", background: "var(--bg-elevated)", padding: "1px 4px", borderRadius: "4px" }}>pip install</code> is available inside the sandbox.
            </div>
            <div style={{ fontFamily: FONT, fontSize: "10px", lineHeight: 1.55, color: "var(--text-muted)" }}>
              Attachments are capped at 3 total items, 5 MB each. Unsupported: DOCX, ODS, ZIPs, and arbitrary binaries.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function UrlAttachModal({
  open, onClose, attachedUrls, sourceUrlInput, onInputChange, onAdd, onRemove, sourceError,
}: UrlAttachModalProps) {
  const FONT = "'Commit Mono', 'SF Mono', monospace";
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.52)',
        backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '480px', maxHeight: '80vh',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: '16px',
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Globe size={14} style={{ color: 'var(--text-muted)' }} />
            <span style={{ fontFamily: FONT, fontSize: '11px', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
              ATTACH URLS
            </span>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '18px', lineHeight: 1, padding: '2px 6px' }}
          >×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Context hint */}
          <div style={{
            padding: '9px 12px',
            borderRadius: '8px',
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-base)',
            fontFamily: FONT,
            fontSize: '11px',
            lineHeight: 1.6,
            color: 'var(--text-muted)',
          }}>
            Paste URLs you think are relevant to your query — agents will read them as grounding context before deliberating.
          </div>
          {/* Input row */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              value={sourceUrlInput}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAdd(); } }}
              placeholder="https://..."
              autoFocus
              style={{
                flex: 1,
                borderRadius: '8px',
                border: '1px solid var(--border-default)',
                background: 'var(--bg-base)',
                color: 'var(--text-primary)',
                padding: '9px 12px',
                fontFamily: FONT,
                fontSize: '12px',
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={onAdd}
              style={{
                padding: '9px 16px',
                borderRadius: '8px',
                border: '1px solid var(--border-default)',
                background: 'transparent',
                color: 'var(--text-secondary)',
                fontFamily: FONT,
                fontSize: '12px',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >Add</button>
          </div>

          {/* Error */}
          {sourceError && (
            <div style={{ fontFamily: FONT, fontSize: '11px', color: 'var(--signal-danger)' }}>{sourceError}</div>
          )}

          {/* URL list */}
          {attachedUrls.length === 0 ? (
            <div style={{ fontFamily: FONT, fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>
              No URLs attached yet
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {attachedUrls.map((url) => (
                <div key={url} style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '8px 10px',
                  borderRadius: '8px',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-subtle)',
                }}>
                  <Globe size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <span style={{
                    flex: 1, fontFamily: FONT, fontSize: '11px', color: 'var(--text-secondary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{url}</span>
                  <button
                    onClick={() => onRemove(url)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '14px', lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                  >×</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <button
            onClick={onClose}
            style={{
              width: '100%', padding: '10px', borderRadius: '8px', border: 'none',
              background: 'var(--accent-emerald)', color: '#000',
              fontFamily: FONT, fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em',
              textTransform: 'uppercase', cursor: 'pointer',
            }}
          >Done{attachedUrls.length > 0 ? ` · ${attachedUrls.length} URL${attachedUrls.length > 1 ? 's' : ''}` : ''}</button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function TaskSubmit() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { getAccessToken } = useAuth();
  const recentTasksQuery = useTaskListQuery();
  const submitTaskMutation = useSubmitTaskMutation();
  const stopTaskMutation = useStopTaskMutation();
  const deleteTaskMutation = useDeleteTaskMutation();
  const runtimeConfigQuery = useDeliberationRuntimeConfigQuery();
  const runtimeConfig = runtimeConfigQuery.data;

  // ── All original state is preserved exactly ──
  const [taskText, setTaskText] = useState("");
  const [agentCount, setAgentCount] = useState(4);
  const [stakes, setStakes] = useState("0.001");
  const [mechanismOverride, setMechanismOverride] = useState<MechanismPreference>("auto");
  const [reasoningPresets, setReasoningPresets] = useState<ReasoningPresetState>(
    DEFAULT_REASONING_PRESETS,
  );
  const [tierModelOverrides, setTierModelOverrides] = useState<TierModelOverrideState>({});
  const [byokConfig, setByokConfig] = useState<TaskByokConfig>(() => createDefaultTaskByokConfig(4));
  const [runtimeDefaultsHydrated, setRuntimeDefaultsHydrated] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const [sourceUrlInput, setSourceUrlInput] = useState("");
  const [attachedUrls, setAttachedUrls] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingAttachmentFile[]>([]);
  const [isUploadingSource, setIsUploadingSource] = useState(false);
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [deleteFlyout, setDeleteFlyout] = useState<{ title: string; body: string } | null>(null);
  const [pendingByokStart, setPendingByokStart] = useState<{
    taskId: string;
    runRequest: TaskRunRequestPayload;
    reveal: {
      mechanism: string;
      confidence: number;
      reasoning: string;
      taskId: string;
    };
  } | null>(null);
  const [mechanismReveal, setMechanismReveal] = useState<{
    mechanism: string;
    confidence: number;
    reasoning: string;
    taskId: string;
  } | null>(null);

  // ── New UI state ──
  const [configOpen, setConfigOpen] = useState(false);
  const [urlModalOpen, setUrlModalOpen] = useState(false);
  const [toolbarTooltip, setToolbarTooltip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [capabilityHintOpen, setCapabilityHintOpen] = useState(false);
  const objectUrlMapRef = useRef<Map<string, string>>(new Map());
  const recentTasks = recentTasksQuery.data ?? [];
  const tasksLoading = recentTasksQuery.isPending;
  const recentTasksError = recentTasksQuery.error instanceof Error
    ? recentTasksQuery.error.message
    : null;

  // ── Rotating prompt set — deterministic but changing on data refresh ──
  const activeSetIdx = recentTasksQuery.dataUpdatedAt
    ? (recentTasksQuery.dataUpdatedAt % PROMPT_SETS.length)
    : 0;
  const activePrompts = PROMPT_SETS[activeSetIdx];
  const [hoveredPrompt, setHoveredPrompt] = useState<{ text: string; rect: DOMRect } | null>(null);

  useEffect(() => {
    if (recentTasksQuery.error) {
      console.error(recentTasksQuery.error);
    }
  }, [recentTasksQuery.error]);

  useEffect(() => {
    const state = location.state as { deletedTaskFlyout?: { title: string; body: string } } | null;
    if (!state?.deletedTaskFlyout) {
      return;
    }
    setDeleteFlyout(state.deletedTaskFlyout);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);

  if (runtimeConfig && !runtimeDefaultsHydrated) {
    setRuntimeDefaultsHydrated(true);
    setReasoningPresets(resolveDefaultReasoningPresets(runtimeConfig));
    setByokConfig((current) => ({
      ...createDefaultTaskByokConfig(current.agentCount, runtimeConfig, tierModelOverrides),
      enabled: current.enabled,
      providerKeys: current.providerKeys,
      roster: ensureTaskByokRosterLength(current.roster, current.agentCount, runtimeConfig, tierModelOverrides),
    }));
  }

  const providerSummary = buildProviderSummary(agentCount, runtimeConfig, tierModelOverrides);
  const byokValidation = getTaskByokValidation(byokConfig);
  const effectiveAgentCount = byokConfig.enabled ? byokConfig.agentCount : agentCount;

  const handleStopTask = async (task: TaskStatusResponse) => {
    if (stopTaskMutation.isPending) {
      return;
    }
    setTaskActionError(null);
    setStoppingTaskId(task.task_id);
    try {
      const stopped = await stopTaskMutation.mutateAsync(task.task_id);
      setTaskDetailCache(queryClient, stopped);
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.list() });
      if (stopped.failure_reason === TASK_STOPPED_REASON) {
        setDeleteFlyout({
          title: "Task stopped",
          body: "The task was stopped before completion and will stay in your deliberation history unless you delete it.",
        });
      }
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Failed to stop task.");
    } finally {
      setStoppingTaskId(null);
    }
  };

  const handleDeleteTask = async (task: TaskStatusResponse) => {
    if (deleteTaskMutation.isPending) {
      return;
    }
    setTaskActionError(null);
    setDeletingTaskId(task.task_id);
    try {
      const deleted = await deleteTaskMutation.mutateAsync(task.task_id);
      removeDeletedTaskFromCaches(queryClient, deleted);
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.list() });
      setDeleteFlyout({
        title: deleted.stopped_before_delete ? "Task stopped and deleted" : "Task deleted",
        body: deleted.stopped_before_delete
          ? "The live task was stopped and removed from your deliberation history."
          : "The task was removed from your deliberation history and receipt views.",
      });
    } catch (error) {
      setTaskActionError(error instanceof Error ? error.message : "Failed to delete task.");
    } finally {
      setDeletingTaskId(null);
    }
  };

  const handleAddUrl = () => {
    const normalized = sourceUrlInput.trim();
    if (!normalized) {
      return;
    }
    if (attachedUrls.length + pendingFiles.length >= MAX_ATTACHMENTS) {
      setSourceError(`Attach up to ${MAX_ATTACHMENTS} total URLs/files per task.`);
      return;
    }
    try {
      const parsed = new URL(normalized);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("URL must start with http:// or https://");
      }
      setAttachedUrls((current) => Array.from(new Set([...current, parsed.toString()])));
      setSourceUrlInput("");
      setSourceError(null);
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Invalid URL");
    }
  };

  const handleQueueFiles = (files: FileList | null) => {
    if (!files) {
      return;
    }
    const selection = resolveAttachmentSelection({
      existingUrlCount: attachedUrls.length,
      existingFileCount: pendingFiles.length,
      files: Array.from(files),
    });
    setPendingFiles((current) => {
      const existingIds = new Set(current.map((item) => item.id));
      const next = [...current];
      for (const item of selection.acceptedFiles) {
        if (!existingIds.has(item.id)) {
          next.push(item);
        }
      }
      return next;
    });
    if (selection.errors.length > 0) {
      setSourceError(selection.errors[0]);
    } else {
      setSourceError(null);
    }
  };

  const removeAttachedUrl = (url: string) => {
    setAttachedUrls((current) => current.filter((entry) => entry !== url));
  };

  const removePendingFile = (id: string) => {
    setPendingFiles((current) => current.filter((entry) => entry.id !== id));
  };

  async function startByokRun(taskId: string, runRequest: TaskRunRequestPayload) {
    const token = await getAccessToken();
    const nextStatus = await startTaskRun(taskId, token, runRequest);
    setTaskDetailCache(
      queryClient,
      nextStatus.status === "pending"
        ? { ...nextStatus, status: "in_progress" }
        : nextStatus,
    );
    return nextStatus;
  }

  // ── Submit handler (original logic, adds taskId to reveal state) ──
  const handleSubmit = async () => {
    if (!taskText.trim()) return;
    if (byokConfig.enabled && !byokValidation.canSubmit) {
      setSubmitError(byokValidation.issues[0] ?? "BYOK configuration is incomplete.");
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    setPendingByokStart(null);
    setMechanismReveal(null);
    try {
      const parsedStake = Number.parseFloat(stakes);
      const normalizedStake = Number.isFinite(parsedStake) && parsedStake >= 0 ? parsedStake : 0.001;
      const token = await getAccessToken();
      const uploadedSourceIds: string[] = [];
      if (pendingFiles.length > 0) {
        setIsUploadingSource(true);
        for (const pending of pendingFiles) {
          const init = await initSourceUpload(token, {
            filename: pending.file.name,
            mimeType: pending.file.type || "application/octet-stream",
            sizeBytes: pending.file.size,
          });
          await uploadSourceBytes(
            init.upload_url,
            init.upload_method,
            init.upload_headers,
            pending.file,
            token,
          );
          const completed = await completeSourceUpload(token, init.source.source_id, null);
          uploadedSourceIds.push(completed.source_id);
        }
      }
      const response = await submitTaskMutation.mutateAsync({
        taskText,
        agentCount: effectiveAgentCount,
        stakes: normalizedStake,
        mechanismOverride: mechanismOverride === "auto" ? null : mechanismOverride,
        reasoningPresets,
        tierModelOverrides: buildTierModelOverridesPayload(tierModelOverrides, runtimeConfig),
        sourceUrls: attachedUrls,
        sourceFileIds: uploadedSourceIds,
        enableTools: true,
      });
      const reveal = {
        mechanism: response.mechanism.toUpperCase(),
        confidence: response.confidence,
        reasoning: response.reasoning,
        taskId: response.task_id,
      };

      if (byokConfig.enabled) {
        const runRequest = buildTaskByokRunRequest(byokConfig);
        try {
          await startByokRun(response.task_id, runRequest);
        } catch (error) {
          setPendingByokStart({
            taskId: response.task_id,
            runRequest,
            reveal,
          });
          setSubmitError(
            error instanceof Error
              ? `Task created, but the BYOK run did not start: ${error.message}`
              : "Task created, but the BYOK run did not start.",
          );
          setIsSubmitting(false);
          return;
        }
      }

      setMechanismReveal(reveal);
      setAttachedUrls([]);
      setPendingFiles([]);
      setSourceUrlInput("");
      setSourceError(null);
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.list() });
      // Navigation now happens from the popup's onNavigate callback
    } catch (error) {
      console.error(error);
      setSubmitError(error instanceof Error ? error.message : "Task submission failed.");
      setIsSubmitting(false);
    } finally {
      setIsUploadingSource(false);
    }
  };

  const handleRetryByokStart = async () => {
    if (!pendingByokStart) {
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await startByokRun(pendingByokStart.taskId, pendingByokStart.runRequest);
      setMechanismReveal(pendingByokStart.reveal);
      setPendingByokStart(null);
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.list() });
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? `Retry failed: ${error.message}`
          : "Retry failed while starting the BYOK run.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Textarea auto-grow ──
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setTaskText(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${e.target.scrollHeight}px`;
  };

  // Placeholder cycling with cross-fade
  const [phIdx, setPhIdx] = useState(0);
  const [phVisible, setPhVisible] = useState(true);
  useEffect(() => {
    const id = setInterval(() => {
      setPhVisible(false);
      setTimeout(() => {
        setPhIdx((i) => (i + 1) % PLACEHOLDERS.length);
        setPhVisible(true);
      }, 380);
    }, 4000);
    return () => clearInterval(id);
  }, []);

  // Build / revoke objectURLs for image previews
  useEffect(() => {
    const map = objectUrlMapRef.current;
    const currentIds = new Set(pendingFiles.map((f) => f.id));
    for (const [id, url] of map.entries()) {
      if (!currentIds.has(id)) { URL.revokeObjectURL(url); map.delete(id); }
    }
    for (const f of pendingFiles) {
      if (!map.has(f.id) && f.file.type.startsWith('image/')) {
        map.set(f.id, URL.createObjectURL(f.file));
      }
    }
  }, [pendingFiles]);

  const FONT = "'Commit Mono', 'SF Mono', monospace";
  const urlBadge = attachedUrls.length > 0 ? String(attachedUrls.length) : null;
  const fileBadge = pendingFiles.length > 0 ? String(pendingFiles.length) : null;

  return (
    <>
      <title>New Deliberation — Agora</title>
      <meta
        name="description"
        content="Configure and submit a deliberation task. Choose your agents, mechanism, and models, then receive a cryptographic proof of the outcome."
      />
      <style>{`
        @keyframes pill-tip-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @media (max-width: 480px) {
          .task-toolbar { padding: 10px 12px !important; gap: 6px !important; }
          .task-toolbar-left { gap: 4px !important; }
          .task-toolbar-badge { display: none !important; }
        }
      `}</style>

      {/* ── Toolbar button tooltips ── */}
      {toolbarTooltip && (() => {
        const r = toolbarTooltip.rect;
        const tipW = 220;
        const left = Math.max(16, Math.min(r.left + r.width / 2 - tipW / 2, window.innerWidth - tipW - 16));
        const bottom = window.innerHeight - r.top + 8;
        return (
          <div style={{
            position: 'fixed', left, bottom, width: `${tipW}px`,
            background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
            borderRadius: '8px', padding: '7px 11px',
            color: 'var(--text-secondary)', fontFamily: FONT, fontSize: '11px', lineHeight: '1.45',
            zIndex: 9000, boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            pointerEvents: 'none', animation: 'pill-tip-in 0.15s ease-out',
          }}>
            {toolbarTooltip.text}
          </div>
        );
      })()}

      {/* ── Prompt pill hover tooltip (fixed so overflowX container doesn't clip) ── */}
      {hoveredPrompt && (() => {
        const r = hoveredPrompt.rect;
        const tipW = 300;
        const left = Math.max(16, Math.min(r.left + r.width / 2 - tipW / 2, window.innerWidth - tipW - 16));
        const bottom = window.innerHeight - r.top + 10;
        return (
          <div style={{
            position: 'fixed',
            left,
            bottom,
            width: `${tipW}px`,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-strong)',
            borderRadius: '8px',
            padding: '8px 12px',
            color: 'var(--text-primary)',
            fontFamily: FONT,
            fontSize: '11px',
            lineHeight: '1.5',
            zIndex: 9000,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            pointerEvents: 'none',
            animation: 'pill-tip-in 0.15s ease-out',
          }}>
            {hoveredPrompt.text}
          </div>
        );
      })()}

    <div style={{ maxWidth: '760px', margin: '0 auto', padding: '40px 16px 80px' }}>


      {/* ── Page header ─────────────────────────────────────────── */}
      <div style={{ textAlign: 'center', marginBottom: '40px' }}>
        <h1 style={{
          fontFamily: FONT,
          fontSize: 'clamp(22px, 4vw, 36px)',
          fontWeight: 800,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-primary)',
          marginBottom: '10px',
        }}>
          What should your agents deliberate on?
        </h1>
        <p style={{
          fontSize: '14px',
          color: 'var(--text-secondary)',
          fontFamily: FONT,
          margin: 0,
        }}>
          Agora analyzes the task, chooses debate, vote, or Delphi, and records a verifiable receipt.
        </p>
      </div>

      {/* ── Notion-style composer ────────────────────────────────── */}
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        borderRadius: '16px',
        overflow: 'hidden',
        boxShadow: '0 4px 24px rgba(0,0,0,0.15)',
        transition: 'border-color 0.15s ease',
      }}
        onFocusCapture={(e) => {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-strong)';
        }}
        onBlurCapture={(e) => {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-default)';
        }}
      >
        {/* ── Top: textarea ── */}
        <div style={{ position: 'relative' }}>
          <textarea
            ref={textareaRef}
            id="task-input"
            aria-label="Task description"
            value={taskText}
            onChange={handleTextChange}
            style={{
              width: '100%',
              minHeight: '120px',
              maxHeight: '420px',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              padding: '20px 24px',
              fontFamily: FONT,
              fontSize: '15px',
              color: 'var(--text-primary)',
              lineHeight: '1.65',
              boxSizing: 'border-box',
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void handleSubmit();
              }
            }}
          />
          {/* Animated fake placeholder — only when no text typed */}
          {!taskText && (
            <div style={{
              position: 'absolute', top: '20px', left: '24px', right: '24px',
              fontFamily: FONT, fontSize: '15px', lineHeight: '1.65',
              color: 'var(--text-muted)',
              opacity: phVisible ? 1 : 0,
              transition: 'opacity 0.38s ease',
              pointerEvents: 'none', userSelect: 'none',
            }}>
              {PLACEHOLDERS[phIdx]}
            </div>
          )}
          {/* Bottom fade — blurs text into the attachment carousel below */}
          {(attachedUrls.length > 0 || pendingFiles.length > 0) && (
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0, height: '52px',
              background: 'linear-gradient(to bottom, transparent, var(--bg-elevated))',
              pointerEvents: 'none',
            }} />
          )}
        </div>

        {/* ── Attachment carousel (shown when attachments exist) ── */}
        {(attachedUrls.length > 0 || pendingFiles.length > 0) && (
          <div>
            {/* Carousel with edge fades */}
            <div style={{ position: 'relative', overflow: 'hidden' }}>
              {/* Left fade */}
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '48px', background: 'linear-gradient(to right, var(--bg-elevated), transparent)', pointerEvents: 'none', zIndex: 2 }} />
              {/* Right fade */}
              <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '48px', background: 'linear-gradient(to left, var(--bg-elevated), transparent)', pointerEvents: 'none', zIndex: 2 }} />
              {/* Top fade — bleeds into textarea, no hard edge */}
              <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '32px', background: 'linear-gradient(to bottom, var(--bg-elevated), transparent)', pointerEvents: 'none', zIndex: 2 }} />

              {/* Scroll container */}
              <div style={{
                display: 'flex', gap: '10px',
                overflowX: 'auto', padding: '4px 48px 8px',
                scrollbarWidth: 'none',
              } as React.CSSProperties}>
                {/* URL cards */}
                {attachedUrls.map((url) => {
                  let hostname = url;
                  try { hostname = new URL(url).hostname; } catch { /* keep raw */ }
                  return (
                    <div key={url} style={{ flex: '0 0 auto', width: '130px', height: '96px', borderRadius: '10px', border: '1px solid var(--border-default)', background: 'var(--bg-base)', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px', overflow: 'hidden', transition: 'transform 0.15s ease' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.transform = 'scale(1.03)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.transform = 'scale(1)'; }}
                    >
                      <Globe size={22} style={{ color: 'var(--text-muted)' }} />
                      <span style={{ fontFamily: FONT, fontSize: '9px', color: 'var(--text-secondary)', textAlign: 'center', padding: '0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '110px' }}>{hostname}</span>
                      <button onClick={() => removeAttachedUrl(url)} style={{ position: 'absolute', top: '5px', right: '5px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '50%', width: '18px', height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '11px', lineHeight: 1, padding: 0 }}>×</button>
                    </div>
                  );
                })}

                {/* File cards */}
                {pendingFiles.map((pending) => {
                  const isImage = pending.file.type.startsWith('image/');
                  const isPdf = pending.file.type === 'application/pdf';
                  const ext = pending.file.name.split('.').pop()?.toUpperCase() ?? 'FILE';
                  const thumbUrl = objectUrlMapRef.current.get(pending.id);
                  return (
                    <div key={pending.id} style={{ flex: '0 0 auto', width: '130px', height: '96px', borderRadius: '10px', border: '1px solid var(--border-default)', background: 'var(--bg-base)', position: 'relative', overflow: 'hidden', transition: 'transform 0.15s ease' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.transform = 'scale(1.03)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.transform = 'scale(1)'; }}
                    >
                      {isImage && thumbUrl ? (
                        <>
                          <img src={thumbUrl} alt={pending.file.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                          {/* Bottom label bar */}
                          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.55)', padding: '4px 6px' }}>
                            <span style={{ fontFamily: FONT, fontSize: '9px', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{pending.file.name}</span>
                          </div>
                        </>
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '8px' }}>
                          {/* Extension badge top-left */}
                          <div style={{ position: 'absolute', top: '6px', left: '6px', padding: '2px 5px', borderRadius: '4px', background: isPdf ? 'rgba(248,113,113,0.15)' : 'rgba(52,211,153,0.12)', border: `1px solid ${isPdf ? 'rgba(248,113,113,0.3)' : 'rgba(52,211,153,0.25)'}` }}>
                            <span style={{ fontFamily: FONT, fontSize: '8px', color: isPdf ? 'var(--accent-rose)' : 'var(--accent-emerald)', letterSpacing: '0.06em' }}>{ext}</span>
                          </div>
                          {isPdf
                            ? <FileText size={26} style={{ color: 'var(--accent-rose)', marginTop: '8px' }} />
                            : <File size={26} style={{ color: 'var(--accent-emerald)', marginTop: '8px' }} />
                          }
                          <span style={{ fontFamily: FONT, fontSize: '9px', color: 'var(--text-secondary)', textAlign: 'center', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: 1.3, maxWidth: '110px' } as React.CSSProperties}>{pending.file.name}</span>
                        </div>
                      )}
                      <button onClick={() => removePendingFile(pending.id)} style={{ position: 'absolute', top: '5px', right: '5px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '50%', width: '18px', height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '11px', lineHeight: 1, padding: 0 }}>×</button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Source error */}
        {sourceError && (
          <div style={{ padding: '0 20px 10px', fontFamily: FONT, fontSize: '12px', color: 'var(--signal-danger)' }}>
            {sourceError}
          </div>
        )}

        {/* ── Divider ── */}
        <div style={{ height: '1px', background: 'var(--border-default)', margin: '0 16px' }} />

        {/* ── Bottom toolbar ── */}
        <div className="task-toolbar" style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: '8px' }}>
          {/* Left cluster: config + URL + files */}
          <div className="task-toolbar-left" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {/* Config button */}
            <button
              type="button"
              onClick={() => setConfigOpen(true)}
              aria-label="Open configuration"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px', borderRadius: '8px', border: '1px solid var(--border-default)', background: 'transparent', cursor: 'pointer', fontFamily: FONT, fontSize: '12px', color: 'var(--text-secondary)', transition: 'border-color 0.15s ease, color 0.15s ease' }}
              onMouseEnter={(e) => { const b = e.currentTarget; b.style.borderColor = 'var(--border-strong)'; b.style.color = 'var(--text-primary)'; setToolbarTooltip({ text: 'Configure agents, mechanism, reasoning depth, and models', rect: b.getBoundingClientRect() }); }}
              onMouseLeave={(e) => { const b = e.currentTarget; b.style.borderColor = 'var(--border-default)'; b.style.color = 'var(--text-secondary)'; setToolbarTooltip(null); }}
            >
              <Settings2 size={14} />
              <span className="task-toolbar-badge" style={{ marginLeft: '4px', padding: '1px 6px', borderRadius: '100px', background: 'var(--border-default)', fontSize: '10px', color: 'var(--text-tertiary)' }}>
                {effectiveAgentCount} agents · {stakes} SOL{byokConfig.enabled ? ' · BYOK' : ''}
              </span>
            </button>

            {/* URL attach button */}
            <button
              type="button"
              onClick={() => setUrlModalOpen(true)}
              style={{ position: 'relative', width: '34px', height: '34px', borderRadius: '8px', border: '1px solid var(--border-default)', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', transition: 'border-color 0.15s ease, color 0.15s ease' }}
              onMouseEnter={(e) => { const b = e.currentTarget; b.style.borderColor = 'var(--border-strong)'; b.style.color = 'var(--text-primary)'; setToolbarTooltip({ text: 'Attach a public URL for grounded deliberation', rect: b.getBoundingClientRect() }); }}
              onMouseLeave={(e) => { const b = e.currentTarget; b.style.borderColor = 'var(--border-default)'; b.style.color = 'var(--text-secondary)'; setToolbarTooltip(null); }}
            >
              <Link size={14} />
              {urlBadge && (
                <span style={{ position: 'absolute', top: '-5px', right: '-5px', minWidth: '16px', height: '16px', borderRadius: '999px', background: 'var(--accent-emerald)', color: '#000', fontSize: '9px', fontWeight: 700, fontFamily: FONT, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>{urlBadge}</span>
              )}
            </button>

            {/* Files attach button */}
            <label
              style={{ position: 'relative', width: '34px', height: '34px', borderRadius: '8px', border: '1px solid var(--border-default)', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', transition: 'border-color 0.15s ease, color 0.15s ease' }}
              onMouseEnter={(e) => { const b = e.currentTarget; b.style.borderColor = 'var(--border-strong)'; b.style.color = 'var(--text-primary)'; setToolbarTooltip({ text: SUPPORTED_FILE_TOOLTIP, rect: b.getBoundingClientRect() }); }}
              onMouseLeave={(e) => { const b = e.currentTarget; b.style.borderColor = 'var(--border-default)'; b.style.color = 'var(--text-secondary)'; setToolbarTooltip(null); }}
            >
              {isUploadingSource ? <Loader2 size={14} style={{ animation: 'agora-spinner 1s linear infinite' }} /> : <Plus size={14} />}
              {fileBadge && (
                <span style={{ position: 'absolute', top: '-5px', right: '-5px', minWidth: '16px', height: '16px', borderRadius: '999px', background: 'var(--accent-emerald)', color: '#000', fontSize: '9px', fontWeight: 700, fontFamily: FONT, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>{fileBadge}</span>
              )}
              <input type="file" multiple accept={SUPPORTED_FILE_ACCEPT} hidden onChange={(event) => { handleQueueFiles(event.target.files); event.currentTarget.value = ""; }} />
            </label>

            {/* Sandbox info button */}
            <button
              type="button"
              onClick={() => setCapabilityHintOpen(true)}
              style={{ width: '34px', height: '34px', borderRadius: '8px', border: '1px solid var(--border-default)', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', transition: 'border-color 0.15s ease, color 0.15s ease' }}
              onMouseEnter={(e) => { const b = e.currentTarget; b.style.borderColor = 'var(--border-strong)'; b.style.color = 'var(--accent-emerald)'; setToolbarTooltip({ text: 'View sandbox environment — what agents can read and execute', rect: b.getBoundingClientRect() }); }}
              onMouseLeave={(e) => { const b = e.currentTarget; b.style.borderColor = 'var(--border-default)'; b.style.color = 'var(--text-secondary)'; setToolbarTooltip(null); }}
            >
              <TerminalSquare size={14} />
            </button>
          </div>

          {/* Submit — pushed to the right */}
          <button
            type="button"
            id="submit-task"
            onClick={handleSubmit}
            disabled={isSubmitting || !taskText.trim() || (byokConfig.enabled && !byokValidation.canSubmit)}
            style={{
              marginLeft: 'auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '44px', height: '36px',
              borderRadius: '10px', border: 'none',
              background: taskText.trim() && !isSubmitting && (!byokConfig.enabled || byokValidation.canSubmit) ? 'var(--accent-emerald)' : 'var(--border-strong)',
              color: taskText.trim() && !isSubmitting && (!byokConfig.enabled || byokValidation.canSubmit) ? '#000' : 'var(--text-tertiary)',
              cursor: taskText.trim() && !isSubmitting && (!byokConfig.enabled || byokValidation.canSubmit) ? 'pointer' : 'not-allowed',
              transition: 'background 0.15s ease, color 0.15s ease',
              flexShrink: 0,
            }}
          >
            {isSubmitting && !mechanismReveal
              ? <Loader2 size={16} style={{ animation: 'agora-spinner 1s linear infinite' }} />
              : <ArrowRight size={16} />
            }
          </button>
        </div>
      </div>

      {(submitError || recentTasksError || taskActionError) && (
        <div style={{
          marginTop: '16px',
          padding: '12px 14px',
          borderRadius: '12px',
          border: '1px solid rgba(248,113,113,0.35)',
          background: 'rgba(248,113,113,0.08)',
          color: '#fca5a5',
          fontFamily: FONT,
          fontSize: '12px',
          lineHeight: 1.6,
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}>
          <span>{submitError ?? recentTasksError ?? taskActionError}</span>
          {pendingByokStart && (
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => void handleRetryByokStart()}
                style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: '1px solid rgba(248,113,113,0.45)',
                  background: 'rgba(255,255,255,0.04)',
                  color: '#fecaca',
                  fontFamily: FONT,
                  fontSize: '11px',
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Retry BYOK Start
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Sandbox info modal ──────────────────────────────────── */}
      <SandboxModal open={capabilityHintOpen} onClose={() => setCapabilityHintOpen(false)} />

      {/* ── URL attach modal ─────────────────────────────────────── */}
      <UrlAttachModal
        open={urlModalOpen}
        onClose={() => setUrlModalOpen(false)}
        attachedUrls={attachedUrls}
        sourceUrlInput={sourceUrlInput}
        onInputChange={setSourceUrlInput}
        onAdd={handleAddUrl}
        onRemove={removeAttachedUrl}
        sourceError={sourceError}
      />

      {/* ── Config modal ─────────────────────────────────────────── */}
      <ConfigModal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        mechanismOverride={mechanismOverride}
        onMechanismOverrideChange={setMechanismOverride}
        reasoningPresets={reasoningPresets}
        onPresetsChange={setReasoningPresets}
        agentCount={agentCount}
        onAgentCountChange={setAgentCount}
        stakes={stakes}
        onStakesChange={setStakes}
        providerSummary={providerSummary}
        runtimeConfig={runtimeConfig}
        tierModelOverrides={tierModelOverrides}
        onTierModelOverridesChange={setTierModelOverrides}
        byokConfig={byokConfig}
        onByokConfigChange={setByokConfig}
      />

      {/* ── Decision popup (replaces sliding alert) ───────────────── */}
      {mechanismReveal && (
        <DecisionPopup
          mechanism={mechanismReveal.mechanism}
          confidence={mechanismReveal.confidence}
          reasoning={mechanismReveal.reasoning}
          onNavigate={() => navigate(`/task/${mechanismReveal.taskId}`)}
        />
      )}

      {/* Suggested prompts animation keyframe (injected once) */}
      <style>{`
        @keyframes prompt-fade-in {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* ── Suggested prompts (shown when textarea is empty) ────────────── */}
      {!taskText.trim() && (
        <div style={{
          marginTop: '16px',
          animation: 'prompt-fade-in 0.28s cubic-bezier(0.22,1,0.36,1) both',
        }}>
          <div style={{
            fontSize: '10px',
            fontFamily: FONT,
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontWeight: 600,
            marginBottom: '8px',
          }}>
            Suggested prompts
          </div>
          <div style={{
            display: 'flex',
            gap: '8px',
            overflowX: 'auto',
            scrollbarWidth: 'none',
            paddingBottom: '4px',
            maskImage: 'linear-gradient(to right, black 0%, black 85%, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to right, black 0%, black 85%, transparent 100%)',
          }}>
            {activePrompts.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setHoveredPrompt(null);
                  setTaskText(p.fullPrompt);
                  if (textareaRef.current) {
                    textareaRef.current.style.height = 'auto';
                    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
                    textareaRef.current.focus();
                  }
                }}
                style={{
                  flexShrink: 0,
                  padding: '5px 12px',
                  borderRadius: '100px',
                  border: '1px solid var(--border-default)',
                  background: 'transparent',
                  color: 'var(--text-tertiary)',
                  fontFamily: FONT,
                  fontSize: '11px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'border-color 0.15s ease, color 0.15s ease',
                  maxWidth: '280px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                onMouseEnter={(e) => {
                  const b = e.currentTarget as HTMLButtonElement;
                  b.style.borderColor = 'var(--accent-emerald)';
                  b.style.color = 'var(--text-secondary)';
                  setHoveredPrompt({ text: p.label, rect: b.getBoundingClientRect() });
                }}
                onMouseLeave={(e) => {
                  const b = e.currentTarget as HTMLButtonElement;
                  b.style.borderColor = 'var(--border-default)';
                  b.style.color = 'var(--text-tertiary)';
                  setHoveredPrompt(null);
                }}
              >
                {p.label}
              </button>
            ))}
            <div style={{ flexShrink: 0, width: '32px' }} />
          </div>
        </div>
      )}

      {/* ── Recent deliberations carousel ─────────────────────────── */}
      <RecentDeliberationsCarousel
        tasks={recentTasks}
        exampleTasks={EXAMPLE_TASK_OBJECTS}
        isLoading={tasksLoading}
        onStopTask={(task) => void handleStopTask(task)}
        onDeleteTask={(task) => void handleDeleteTask(task)}
        stoppingTaskId={stoppingTaskId}
        deletingTaskId={deletingTaskId}
        onExampleSelect={(text) => {
          setTaskText(text);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
            textareaRef.current.focus();
          }
        }}
        onRefresh={() => void recentTasksQuery.refetch()}
        isRefreshing={recentTasksQuery.isFetching && !recentTasksQuery.isLoading}
      />

      <Flyout
        show={deleteFlyout !== null}
        variant="success"
        title={deleteFlyout?.title ?? ""}
        body={deleteFlyout?.body}
        onDismiss={() => setDeleteFlyout(null)}
      />

    </div>
    </>
  );
}
