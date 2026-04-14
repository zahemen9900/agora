import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Loader2, Play } from "lucide-react";

import { listTasks, submitTask, type TaskStatusResponse } from "../lib/api";
import { useAuth } from "../lib/auth";

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
    mechanism: "debate",
    status: "pending",
    selector_reasoning: "Example prompt for demo purposes.",
    selector_reasoning_hash: "",
    selector_confidence: 0,
    merkle_root: null,
    decision_hash: null,
    quorum_reached: null,
    agent_count: 3,
    round_count: 0,
    mechanism_switches: 0,
    transcript_hashes: [],
    solana_tx_hash: null,
    explorer_url: null,
    payment_amount: 0,
    payment_status: "none",
    created_at: now,
    completed_at: null,
    result: null,
    events: [],
  };
}

export function TaskSubmit() {
  const navigate = useNavigate();
  const { token } = useAuth();
  const [taskText, setTaskText] = useState("");
  const [agentCount, setAgentCount] = useState(3);
  const [stakes, setStakes] = useState("0.00");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [recentTasks, setRecentTasks] = useState<TaskStatusResponse[]>([]);
  const [mechanismReveal, setMechanismReveal] = useState<{
    mechanism: string;
    confidence: number;
    reasoning: string;
  } | null>(null);

  useEffect(() => {
    void loadRecentTasks();
  }, [token]);

  async function loadRecentTasks() {
    try {
      const tasks = await listTasks(token);
      setRecentTasks(tasks);
    } catch (error) {
      console.error(error);
    }
  }

  const handleSubmit = async () => {
    if (!taskText.trim()) return;

    setIsSubmitting(true);
    setMechanismReveal(null);
    try {
      const response = await submitTask(
        taskText,
        agentCount,
        Number.parseFloat(stakes) || 0,
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
    <div className="max-w-[800px] mx-auto mt-10">
      <div className="text-center mb-10">
        <h1 className="mb-4 text-3xl md:text-5xl">What should your agents deliberate on?</h1>
        <p className="text-text-secondary text-lg">
          Agora analyzes the task, chooses debate or vote, and records a verifiable receipt.
        </p>
      </div>

      <div className="card p-8 mb-16">
        <div className="l-corners" />

        <textarea
          className="mono w-full min-h-[120px] bg-void text-text-primary border border-border-subtle rounded-lg p-4 text-base resize-none outline-none mb-6 focus:border-accent transition-colors"
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
                {[3, 5, 7].map((num) => (
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
                type="text"
                value={stakes}
                onChange={(event) => setStakes(event.target.value)}
                className="mono bg-void text-text-primary border border-border-muted py-1.5 px-3 rounded-md w-[100px] outline-none focus:border-accent transition-colors"
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
      </div>

      <div className="mt-16">
        <h2 className="text-xl mb-6">Recent Deliberations</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {(recentTasks.length > 0
            ? recentTasks
            : EXAMPLE_TASKS.map((task, index) => makeExampleTask(task, index)))?.map((task) => (
            <div key={task.task_id} className="card p-5 flex flex-col">
              <div className="l-corners" />
              <p className="text-[0.95rem] mb-4 flex-1 text-text-primary">
                "{task.task_text.length > 60 ? `${task.task_text.substring(0, 60)}...` : task.task_text}"
              </p>

              <div className="flex justify-between items-center mb-4">
                <span className="badge">{task.mechanism.toUpperCase()}</span>
                <span className="text-sm text-text-secondary">{task.status}</span>
              </div>

              <div className="mono text-text-muted text-xs flex justify-between gap-4">
                <span>{task.result ? `${task.result.latency_ms.toFixed(0)} ms` : "pending"}</span>
                <span>{task.merkle_root ? `${task.merkle_root.slice(0, 12)}...` : "no receipt"}</span>
              </div>

              <button
                onClick={() => {
                  if (task.task_id.startsWith("example-")) {
                    setTaskText(task.task_text);
                    return;
                  }
                  navigate(`/task/${task.task_id}`);
                }}
                className="btn-secondary w-full mt-4 p-2 text-sm flex justify-center gap-2"
              >
                <Play size={14} /> {task.task_id.startsWith("example-") ? "Try this task" : "Open task"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
