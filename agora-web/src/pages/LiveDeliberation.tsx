import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Zap } from "lucide-react";

import { ConvergenceMeter } from "../components/ConvergenceMeter";
import { TypewriterText } from "../components/TypewriterText";
import {
  getTask,
  runTask,
  streamDeliberation,
  type TaskEvent,
  type TaskStatusResponse,
} from "../lib/api";
import { useAuth } from "../lib/auth";

interface RenderEvent {
  agentId: string;
  faction: string;
  text: string;
  role: string;
}

export function LiveDeliberation() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { getAccessToken } = useAuth();

  const [task, setTask] = useState<TaskStatusResponse | null>(null);
  const [events, setEvents] = useState<RenderEvent[]>([]);
  const [switchBanner, setSwitchBanner] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [convergence, setConvergence] = useState({
    entropy: 1.0,
    prevEntropy: 1.0,
    infoGain: 0.0,
    lockedClaims: [] as Array<Record<string, unknown>>,
  });
  const [finalAnswer, setFinalAnswer] = useState<{
    text: string;
    confidence: number;
    mechanism: string;
  } | null>(null);

  useEffect(() => {
    if (!taskId) return;
    const resolvedTaskId = taskId;

    let streamHandle: { close: () => void } | null = null;
    let cancelled = false;

    async function bootstrap() {
      const token = await getAccessToken();
      const status = await getTask(resolvedTaskId, token, true);
      if (cancelled) return;
      setTask(status);
      if (status.result) {
        setFinalAnswer({
          text: status.result.final_answer,
          confidence: status.result.confidence,
          mechanism: status.result.mechanism,
        });
      }
      setConvergenceFromEvents(status.events);

      streamHandle = await streamDeliberation(resolvedTaskId, token, (event) => {
        handleStreamEvent(event);
      });

      if (status.status === "pending") {
        void (async () => {
          const runToken = await getAccessToken();
          await runTask(resolvedTaskId, runToken);
        })().catch((error: unknown) => {
          setErrorMessage(error instanceof Error ? error.message : "Run failed");
        });
      }
    }

    void bootstrap().catch((error: unknown) => {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load task");
    });

    return () => {
      cancelled = true;
      streamHandle?.close();
    };
  }, [taskId, getAccessToken]);

  function handleStreamEvent(event: TaskEvent) {
    const data = event.data as Record<string, unknown>;

    if (event.event === "agent_output") {
      setEvents((current) => [
        ...current,
        {
          agentId: String(data.agent_id ?? "agent"),
          faction: String(data.faction ?? data.role ?? "agent"),
          text: String(data.content ?? ""),
          role: String(data.role ?? "agent"),
        },
      ]);
      return;
    }

    if (event.event === "cross_examination") {
      const analyses = (data.payload as { analyses?: Array<Record<string, unknown>> } | undefined)
        ?.analyses;
      const text =
        analyses?.map((item) => `${item.faction}: ${item.question}`).join(" | ") ??
        JSON.stringify(data.payload ?? {});
      setEvents((current) => [
        ...current,
        {
          agentId: String(data.agent_id ?? "devils-advocate"),
          faction: "devil_advocate",
          text,
          role: "devil_advocate",
        },
      ]);
      return;
    }

    if (event.event === "convergence_update") {
      setConvergence((current) => ({
        prevEntropy: current.entropy,
        entropy: Number(data.disagreement_entropy ?? current.entropy),
        infoGain: Number(data.information_gain_delta ?? 0),
        lockedClaims: Array.isArray(data.locked_claims)
          ? (data.locked_claims as Array<Record<string, unknown>>)
          : [],
      }));
      return;
    }

    if (event.event === "mechanism_switch") {
      setSwitchBanner(
        `SWITCHING: ${String(data.from_mechanism).toUpperCase()} -> ${String(
          data.to_mechanism,
        ).toUpperCase()}`,
      );
      return;
    }

    if (event.event === "quorum_reached") {
      setFinalAnswer({
        text: String(data.final_answer ?? ""),
        confidence: Number(data.confidence ?? 0),
        mechanism: String(data.mechanism ?? task?.mechanism ?? "debate"),
      });
      return;
    }

    if (event.event === "error") {
      setErrorMessage(String(data.message ?? "An error occurred"));
      return;
    }

    if (event.event === "complete" && taskId) {
      const resolvedTaskId = taskId;
      void (async () => {
        const token = await getAccessToken();
        const status = await getTask(resolvedTaskId, token, true);
        setTask(status);
      })().catch(() => undefined);
    }
  }

  function setConvergenceFromEvents(eventList: TaskEvent[]) {
    const latest = [...eventList].reverse().find((event) => event.event === "convergence_update");
    if (!latest) {
      return;
    }

    const data = latest.data as Record<string, unknown>;
    setConvergence({
      prevEntropy: Number(data.disagreement_entropy ?? 1),
      entropy: Number(data.disagreement_entropy ?? 1),
      infoGain: Number(data.information_gain_delta ?? 0),
      lockedClaims: Array.isArray(data.locked_claims)
        ? (data.locked_claims as Array<Record<string, unknown>>)
        : [],
    });
  }

  const proponents = useMemo(
    () => events.filter((event) => event.faction === "proponent"),
    [events],
  );
  const opponents = useMemo(
    () => events.filter((event) => event.faction === "opponent"),
    [events],
  );
  const devilAdvocates = useMemo(
    () => events.filter((event) => event.faction === "devil_advocate"),
    [events],
  );
  const voteOutputs = useMemo(
    () => events.filter((event) => event.faction === "vote"),
    [events],
  );

  return (
    <div className="relative">
      <header className="flex flex-col md:flex-row md:items-center justify-between pb-6 border-b border-border-subtle mb-8 gap-4 md:gap-0">
        <div>
          <div className="mono text-text-muted text-sm mb-2">TASK {taskId}</div>
          <h2 className="text-xl md:text-2xl max-w-[800px]">{task?.task_text ?? "Loading task..."}</h2>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <span className="badge">
            {(task?.mechanism ?? finalAnswer?.mechanism ?? "debate").toUpperCase()} (
            {((task?.selector_confidence ?? 0) * 100).toFixed(0)}%)
          </span>
          <div className="mono flex items-center gap-2 text-text-secondary">
            ROUND {task?.round_count || Math.max(1, convergence.lockedClaims.length)}
          </div>
        </div>
      </header>

      <AnimatePresence>
        {switchBanner && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="p-4 mb-6 border border-warning rounded-lg bg-[rgba(255,184,76,0.08)] text-warning"
          >
            {switchBanner}
          </motion.div>
        )}
      </AnimatePresence>

      {errorMessage && (
        <div className="p-4 mb-6 border border-danger rounded-lg bg-[rgba(255,93,93,0.08)] text-danger">
          {errorMessage}
        </div>
      )}

      <AnimatePresence>
        {finalAnswer && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-6 bg-accent-muted border border-accent rounded-xl mb-8 shadow-[var(--shadow-glow)]"
          >
            <div className="flex items-center gap-3 mb-3 text-accent">
              <CheckCircle2 size={24} />
              <h3 className="text-accent text-lg">QUORUM REACHED</h3>
            </div>
            <p className="text-lg text-text-primary mb-4">{finalAnswer.text}</p>
            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 sm:gap-0">
              <div className="mono text-accent">
                Confidence: {(finalAnswer.confidence * 100).toFixed(1)}%
              </div>
              <button
                className="btn-primary flex items-center justify-center gap-2"
                onClick={() => navigate(`/task/${taskId}/receipt`)}
              >
                View On-Chain Receipt &rarr;
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConvergenceMeter
        entropy={convergence.entropy}
        prevEntropy={convergence.prevEntropy}
        infoGain={convergence.infoGain}
        lockedClaims={convergence.lockedClaims.length}
      />

      {voteOutputs.length > 0 ? (
        <div className="border-l-2 border-accent pl-6 mb-10">
          <h3 className="mono text-accent text-sm mb-6 tracking-widest">VOTES</h3>
          {voteOutputs.map((event, index) => (
            <motion.div
              key={`${event.agentId}-${index}`}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-6"
            >
              <div className="mono text-text-muted text-xs mb-2">{event.agentId}</div>
              <div className="card p-4 bg-void">
                <TypewriterText text={event.text} speed={10} />
              </div>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <div className="border-l-2 border-proponent pl-6">
            <h3 className="mono text-proponent text-sm mb-6 tracking-widest">PROPONENTS</h3>
            {proponents.map((event, index) => (
              <motion.div
                key={`${event.agentId}-${index}`}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="mb-6"
              >
                <div className="mono text-text-muted text-xs mb-2">{event.agentId}</div>
                <div className="card p-4 bg-void">
                  <TypewriterText text={event.text} speed={10} />
                </div>
              </motion.div>
            ))}
          </div>

          <div className="border-l-2 border-opponent pl-6">
            <h3 className="mono text-opponent text-sm mb-6 tracking-widest">OPPONENTS</h3>
            {opponents.map((event, index) => (
              <motion.div
                key={`${event.agentId}-${index}`}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                className="mb-6"
              >
                <div className="mono text-text-muted text-xs mb-2">{event.agentId}</div>
                <div className="card p-4 bg-void">
                  <TypewriterText text={event.text} speed={10} />
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {devilAdvocates.length > 0 && (
        <div className="border-l-2 border-devil-advocate pl-6 mb-10">
          <h3 className="mono text-devil-advocate text-sm mb-6 tracking-widest flex items-center gap-2">
            <Zap size={14} /> DEVIL&apos;S ADVOCATE
          </h3>
          <div className="grid grid-cols-1 gap-6">
            {devilAdvocates.map((event, index) => (
              <motion.div
                key={`${event.agentId}-${index}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div className="mono text-text-muted text-xs mb-2">{event.agentId}</div>
                <div className="card p-4 bg-void">
                  <TypewriterText text={event.text} speed={15} />
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {convergence.lockedClaims.length > 0 && (
        <div className="p-6 border border-border-subtle rounded-xl bg-surface">
          <h3 className="mono text-sm mb-4 text-accent">VERIFIED CLAIMS</h3>
          {convergence.lockedClaims.map((claim, index) => (
            <motion.div
              key={`${String(claim.claim_hash ?? index)}`}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex gap-3 items-start mb-4"
            >
              <CheckCircle2 className="text-accent flex-shrink-0 mt-0.5" size={18} />
              <div>
                <p className="text-text-primary mb-1">&quot;{String(claim.claim_text ?? "")}&quot;</p>
                <p className="mono text-xs text-text-muted">
                  Verified by: {String(claim.verified_by ?? "Agora")}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
