import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Settings2, ArrowRight, Loader2 } from "lucide-react";

import { ConfigModal } from "../components/task/ConfigModal";
import { DecisionPopup } from "../components/task/DecisionPopup";
import { RecentDeliberationsCarousel } from "../components/task/RecentDeliberationsCarousel";
import { type TaskStatusResponse } from "../lib/api";
import {
  buildTierModelOverridesPayload,
  buildProviderSummary,
  DEFAULT_REASONING_PRESETS,
  resolveDefaultReasoningPresets,
  type ReasoningPresetState,
  type TierModelOverrideState,
} from "../lib/deliberationConfig";
import {
  taskQueryKeys,
  useSubmitTaskMutation,
  useTaskListQuery,
} from "../lib/taskQueries";
import { useDeliberationRuntimeConfigQuery } from "../lib/runtimeConfigQueries";

// ── Example tasks (unchanged) ─────────────────────────────────────────────────
const EXAMPLE_TASKS = [
  "Should a startup with 3 engineers use microservices or a monolith?",
  "What is the optimal interest rate policy given current inflation?",
  "Should we implement a graph database for our social routing?",
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
    completed_at: null,
    failure_reason: null,
    latest_error_event: null,
    result: null,
    events: [],
  };
}

const EXAMPLE_TASK_OBJECTS = EXAMPLE_TASKS.map(makeExampleTask);

// ── Main component ────────────────────────────────────────────────────────────
export function TaskSubmit() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recentTasksQuery = useTaskListQuery();
  const submitTaskMutation = useSubmitTaskMutation();
  const runtimeConfigQuery = useDeliberationRuntimeConfigQuery();
  const runtimeConfig = runtimeConfigQuery.data;

  // ── All original state is preserved exactly ──
  const [taskText, setTaskText] = useState("");
  const [agentCount, setAgentCount] = useState(4);
  const [stakes, setStakes] = useState("0.001");
  const [reasoningPresets, setReasoningPresets] = useState<ReasoningPresetState>(
    DEFAULT_REASONING_PRESETS,
  );
  const [tierModelOverrides, setTierModelOverrides] = useState<TierModelOverrideState>({});
  const [runtimeDefaultsHydrated, setRuntimeDefaultsHydrated] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [mechanismReveal, setMechanismReveal] = useState<{
    mechanism: string;
    confidence: number;
    reasoning: string;
    taskId: string;
  } | null>(null);

  // ── New UI state ──
  const [configOpen, setConfigOpen] = useState(false);
  const recentTasks = recentTasksQuery.data ?? [];
  const tasksLoading = recentTasksQuery.isPending;
  const recentTasksError = recentTasksQuery.error instanceof Error
    ? recentTasksQuery.error.message
    : null;

  useEffect(() => {
    if (recentTasksQuery.error) {
      console.error(recentTasksQuery.error);
    }
  }, [recentTasksQuery.error]);

  useEffect(() => {
    if (!runtimeConfig || runtimeDefaultsHydrated) {
      return;
    }
    setReasoningPresets(resolveDefaultReasoningPresets(runtimeConfig));
    setRuntimeDefaultsHydrated(true);
  }, [runtimeConfig, runtimeDefaultsHydrated]);

  const providerSummary = buildProviderSummary(agentCount, runtimeConfig, tierModelOverrides);

  // ── Submit handler (original logic, adds taskId to reveal state) ──
  const handleSubmit = async () => {
    if (!taskText.trim()) return;
    setIsSubmitting(true);
    setSubmitError(null);
    setMechanismReveal(null);
    try {
      const parsedStake = Number.parseFloat(stakes);
      const normalizedStake = Number.isFinite(parsedStake) && parsedStake >= 0 ? parsedStake : 0.001;
      const response = await submitTaskMutation.mutateAsync({
        taskText,
        agentCount,
        stakes: normalizedStake,
        reasoningPresets,
        tierModelOverrides: buildTierModelOverridesPayload(tierModelOverrides, runtimeConfig),
      });
      setMechanismReveal({
        mechanism: response.mechanism.toUpperCase(),
        confidence: response.confidence,
        reasoning: response.reasoning,
        taskId: response.task_id,
      });
      await queryClient.invalidateQueries({ queryKey: taskQueryKeys.list() });
      // Navigation now happens from the popup's onNavigate callback
    } catch (error) {
      console.error(error);
      setSubmitError(error instanceof Error ? error.message : "Task submission failed.");
      setIsSubmitting(false);
    }
  };

  // ── Textarea auto-grow ──
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setTaskText(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${e.target.scrollHeight}px`;
  };

  const FONT = "'Commit Mono', 'SF Mono', monospace";

  return (
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
          Agora analyzes the task, chooses debate or vote, and records a verifiable receipt.
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
        <textarea
          ref={textareaRef}
          id="task-input"
          aria-label="Task description"
          placeholder="Enter a question, decision, or problem for multi-agent deliberation..."
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
            // Ctrl+Enter or Cmd+Enter submits
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void handleSubmit();
            }
          }}
        />

        {/* ── Divider ── */}
        <div style={{ height: '1px', background: 'var(--border-default)', margin: '0 16px' }} />

        {/* ── Bottom toolbar ── */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          gap: '12px',
        }}>
          {/* Left: Config button */}
          <button
            type="button"
            onClick={() => setConfigOpen(true)}
            aria-label="Open configuration"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '7px 14px',
              borderRadius: '8px',
              border: '1px solid var(--border-default)',
              background: 'transparent',
              cursor: 'pointer',
              fontFamily: FONT,
              fontSize: '12px',
              color: 'var(--text-secondary)',
              transition: 'border-color 0.15s ease, color 0.15s ease',
            }}
            onMouseEnter={(e) => {
              const b = e.currentTarget as HTMLButtonElement;
              b.style.borderColor = 'var(--border-strong)';
              b.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              const b = e.currentTarget as HTMLButtonElement;
              b.style.borderColor = 'var(--border-default)';
              b.style.color = 'var(--text-secondary)';
            }}
          >
            <Settings2 size={14} />
            Configure
            {/* Badges showing current settings */}
            <span style={{
              marginLeft: '4px',
              padding: '1px 6px',
              borderRadius: '100px',
              background: 'var(--border-default)',
              fontSize: '10px',
              color: 'var(--text-tertiary)',
            }}>
              {agentCount} agents · {stakes} SOL
            </span>
          </button>

          {/* Right: Submit */}
          <button
            type="button"
            id="submit-task"
            onClick={handleSubmit}
            disabled={isSubmitting || !taskText.trim()}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '9px 20px',
              borderRadius: '10px',
              border: 'none',
              background: taskText.trim() && !isSubmitting ? 'var(--accent-emerald)' : 'var(--border-strong)',
              color: taskText.trim() && !isSubmitting ? '#000' : 'var(--text-tertiary)',
              cursor: taskText.trim() && !isSubmitting ? 'pointer' : 'not-allowed',
              fontFamily: FONT,
              fontSize: '13px',
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              transition: 'background 0.15s ease, color 0.15s ease',
              flexShrink: 0,
            }}
          >
            {isSubmitting && !mechanismReveal ? (
              <>
                <Loader2 size={14} style={{ animation: 'agora-spinner 1s linear infinite' }} />
                Analyzing…
              </>
            ) : (
              <>
                Submit to Agora
                <ArrowRight size={14} />
              </>
            )}
          </button>
        </div>
      </div>

      {(submitError || recentTasksError) && (
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
        }}>
          {submitError ?? recentTasksError}
        </div>
      )}

      {/* ── Config modal ─────────────────────────────────────────── */}
      <ConfigModal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
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
            {EXAMPLE_TASKS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => {
                  setTaskText(prompt);
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
                }}
                onMouseLeave={(e) => {
                  const b = e.currentTarget as HTMLButtonElement;
                  b.style.borderColor = 'var(--border-default)';
                  b.style.color = 'var(--text-tertiary)';
                }}
              >
                {prompt}
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
        onExampleSelect={(text) => {
          setTaskText(text);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
            textareaRef.current.focus();
          }
        }}
      />

    </div>
  );
}
