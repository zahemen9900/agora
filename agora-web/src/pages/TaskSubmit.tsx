import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Loader2, Play } from "lucide-react";

import { EnsemblePlan } from "../components/EnsemblePlan";
import { ReasoningPresetControls } from "../components/ReasoningPresetControls";
import { listTasks, submitTask, type TaskStatusResponse } from "../lib/api";
import { useAuth } from "../lib/useAuth";
import {
  buildDebateRoster,
  buildProviderCountBadges,
  buildVoteRoster,
  DEFAULT_REASONING_PRESETS,
  getBalancedEnsembleLabel,
  getDebateSpecialistSummary,
  type ReasoningPresetState,
} from "../lib/deliberationConfig";

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
    status: "pending",
    selector_reasoning: "Example prompt for demo purposes.",
    selector_reasoning_hash: "",
    selector_confidence: 0,
    merkle_root: null,
    decision_hash: null,
    quorum_reached: null,
    agent_count: 4,
    reasoning_presets: DEFAULT_REASONING_PRESETS,
    round_count: 0,
    mechanism_switches: 0,
    transcript_hashes: [],
    solana_tx_hash: null,
    explorer_url: null,
    payment_amount: 0,
    payment_status: "none",
    chain_operations: {},
    created_at: now,
    completed_at: null,
    result: null,
    events: [],
  };
}

export function TaskSubmit() {
  const navigate = useNavigate();
  const { getAccessToken } = useAuth();
  const [taskText, setTaskText] = useState("");
  const [agentCount, setAgentCount] = useState(4);
  const [stakes, setStakes] = useState("0.001");
  const [reasoningPresets, setReasoningPresets] = useState<ReasoningPresetState>(
    DEFAULT_REASONING_PRESETS,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [recentTasks, setRecentTasks] = useState<TaskStatusResponse[]>([]);
  const [mechanismReveal, setMechanismReveal] = useState<{
    mechanism: string;
    confidence: number;
    reasoning: string;
  } | null>(null);

  const voteRoster = useMemo(
    () => buildVoteRoster(agentCount, reasoningPresets),
    [agentCount, reasoningPresets],
  );
  const debateRoster = useMemo(
    () => buildDebateRoster(agentCount, reasoningPresets),
    [agentCount, reasoningPresets],
  );
  const providerCountBadges = useMemo(
    () => buildProviderCountBadges(agentCount),
    [agentCount],
  );
  const ensembleLabel = useMemo(() => getBalancedEnsembleLabel(agentCount), [agentCount]);

  const fetchRecentTasks = useCallback(async (): Promise<TaskStatusResponse[]> => {
    const token = await getAccessToken();
    return listTasks(token);
  }, [getAccessToken]);

  const loadRecentTasks = useCallback(async () => {
    try {
      const tasks = await fetchRecentTasks();
      setRecentTasks(tasks);
    } catch (error) {
      console.error(error);
    }
  }, [fetchRecentTasks]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const tasks = await fetchRecentTasks();
        if (!cancelled) {
          setRecentTasks(tasks);
        }
      } catch (error) {
        console.error(error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchRecentTasks]);

  const handleSubmit = async () => {
    if (!taskText.trim()) return;

    setIsSubmitting(true);
    setMechanismReveal(null);
    try {
      const token = await getAccessToken();
      const parsedStake = Number.parseFloat(stakes);
      const normalizedStake = Number.isFinite(parsedStake) && parsedStake >= 0 ? parsedStake : 0.001;
      const response = await submitTask(
        taskText,
        agentCount,
        normalizedStake,
        reasoningPresets,
        token,
      );
      setMechanismReveal({
        mechanism: response.mechanism.toUpperCase(),
        confidence: response.confidence,
        reasoning: response.reasoning,
      });
      await loadRecentTasks();
      window.setTimeout(() => {
        navigate(`/task/${response.task_id}`);
      }, 1500);
    } catch (error) {
      console.error(error);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto mt-10">
      <div className="text-center mb-10">
        <h1 className="mb-4 text-3xl md:text-5xl">What should your agents deliberate on?</h1>
        <p className="text-text-secondary text-lg">
          Agora analyzes the task, chooses debate or vote, and records a verifiable receipt.
        </p>
      </div>

      <div className="card p-8 mb-16">


        <textarea
          className="mono w-full min-h-40 bg-void text-text-primary border border-border-subtle rounded-lg p-5 text-base resize-none outline-none mb-6 focus:border-accent transition-colors"
          placeholder="Enter a question, decision, or problem for multi-agent deliberation..."
          value={taskText}
          onChange={(event) => {
            setTaskText(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${event.target.scrollHeight}px`;
          }}
        />

        <div className="flex flex-col md:flex-row justify-between items-start md:items-end flex-wrap gap-6">
          <div className="flex flex-col sm:flex-row gap-6 w-full md:w-auto">
            <div>
              <div className="mono text-text-muted text-xs mb-2">AGENTS</div>
              <div className="flex gap-2">
                {[4, 8, 12].map((num) => (
                  <button
                    key={num}
                    onClick={() => setAgentCount(num)}
                    className={`mono px-4 py-1.5 rounded-full text-sm border transition-colors ${
                      agentCount === num
                        ? "bg-accent-muted text-accent border-accent"
                        : "bg-void text-text-secondary border-border-muted hover:border-text-muted"
                    }`}
                  >
                    {num}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mono text-text-muted text-xs mb-2">STAKES (SOL)</div>
              <input
                type="number"
                min={0}
                step="0.001"
                value={stakes}
                onChange={(event) => setStakes(event.target.value)}
                className="mono bg-void text-text-primary border border-border-muted py-1.5 px-3 rounded-md w-25 outline-none focus:border-accent transition-colors"
              />
            </div>
          </div>

          <button
            className="btn-primary w-full md:w-auto"
            onClick={handleSubmit}
            disabled={isSubmitting || !taskText.trim()}
          >
            {isSubmitting && !mechanismReveal ? (
              <>
                <Loader2 className="animate-spin" size={18} /> Analyzing task features...
              </>
            ) : mechanismReveal ? (
              <>
                <Loader2 className="animate-spin" size={18} /> Routing to {mechanismReveal.mechanism}
                ...
              </>
            ) : (
              <>
                Submit to Agora <ChevronRight size={18} />
              </>
            )}
          </button>
        </div>

        <div className="mt-6">
          <ReasoningPresetControls
            value={reasoningPresets}
            onChange={setReasoningPresets}
          />
        </div>

        {mechanismReveal && (
          <div className="mt-8 p-4 bg-accent-muted border-l-4 border-accent rounded-r-lg animate-[shimmer_2s_ease-out]">
            <div className="flex items-center gap-2 mb-2">
              <span className="badge">ROUTED</span>
              <span className="font-medium">
                Agora selected {mechanismReveal.mechanism} with{" "}
                {(mechanismReveal.confidence * 100).toFixed(0)}% confidence
              </span>
            </div>
            <p className="text-sm m-0 text-text-secondary">{mechanismReveal.reasoning}</p>
          </div>
        )}

        <div className="mt-8 grid grid-cols-1 xl:grid-cols-2 gap-4">
          <EnsemblePlan
            title="VOTE MODEL PLAN"
            label={ensembleLabel}
            items={voteRoster}
            countBadges={providerCountBadges}
          />

          <EnsemblePlan
            title="DEBATE MODEL PLAN"
            label={ensembleLabel}
            items={debateRoster}
            countBadges={providerCountBadges}
            footer={getDebateSpecialistSummary()}
          />
        </div>
      </div>

      <div className="mt-16">
        <h2 className="text-xl mb-8">Recent Deliberations</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
          {(recentTasks.length > 0
            ? recentTasks
            : EXAMPLE_TASKS.map((task, index) => makeExampleTask(task, index)))?.map((task) => {
            const isExample = task.task_id.startsWith("example-");
            return (
              <div 
                key={task.task_id} 
                className="card p-8 flex flex-col cursor-pointer transition-all hover:border-accent hover:bg-[var(--bg-card-hover)]"
                onClick={() => {
                  if (isExample) {
                    setTaskText(task.task_text);
                  } else {
                    navigate(`/task/${task.task_id}`);
                  }
                }}
              >
                <div className="text-accent mb-6">
                  <Play size={24} strokeWidth={1.5} />
                </div>
                
                <h3 className="text-text-primary text-lg font-medium mb-2 line-clamp-2" style={{ fontFamily: 'var(--font-sans)', textTransform: 'none' }}>
                  {task.task_text}
                </h3>
                
                <p className="text-sm text-text-secondary mb-6 flex-1 line-clamp-2">
                  {isExample ? "Try this example task in the deliberation engine" : `Status: ${task.status} • Hash: ${task.merkle_root ? task.merkle_root.slice(0, 8) : "Pending"}`}
                </p>

                <div className="flex items-center gap-3 mt-auto pt-4 border-t border-border-subtle">
                  <span className="badge">{task.mechanism.toUpperCase()}</span>
                  <span className="mono text-xs text-text-muted">
                    {task.result ? `${task.result.latency_ms.toFixed(0)} ms` : "waiting..."}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
