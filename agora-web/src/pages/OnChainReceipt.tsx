import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CheckCircle2, ExternalLink, ShieldCheck } from "lucide-react";

import { HashDisplay } from "../components/HashDisplay";
import { MerkleTree } from "../components/MerkleTree";
import {
  getTask,
  releaseTaskPayment,
  verifyMerkleRoot,
  ApiRequestError,
  type TaskStatusResponse,
} from "../lib/api";
import { useAuth } from "../lib/useAuth";

export function OnChainReceipt() {
  const { taskId } = useParams();
  const { getAccessToken } = useAuth();
  const [task, setTask] = useState<TaskStatusResponse | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isVerified, setIsVerified] = useState<boolean | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) return;
    void (async () => {
      const token = await getAccessToken();
      const status = await getTask(taskId, token, true);
      setTask(status);
    })().catch((error) => console.error(error));
  }, [taskId, getAccessToken]);

  const handleVerify = async () => {
    if (!task?.result) return;
    setIsVerifying(true);
    const verified = await verifyMerkleRoot(
      task.result.transcript_hashes,
      task.result.merkle_root,
    );
    setIsVerified(verified);
    setIsVerifying(false);
  };

  const handleReleasePayment = async () => {
    if (!taskId) return;
    setIsPaying(true);
    setPaymentError(null);
    try {
      const token = await getAccessToken();
      await releaseTaskPayment(taskId, token);
      const refreshed = await getTask(taskId, token, true);
      setTask(refreshed);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        setPaymentError(error.message);
      } else {
        setPaymentError("Payment release failed.");
      }
    } finally {
      setIsPaying(false);
    }
  };

  const result = task?.result;
  const paymentReleased = task?.payment_status === "released";
  const paymentLocked = task?.payment_status === "locked";
  const quorumReached = result?.quorum_reached ?? task?.quorum_reached ?? false;
  const canReleasePayment = paymentLocked && task?.status === "completed" && quorumReached;

  return (
    <div className="max-w-[1000px] mx-auto w-full">
      <header className="mb-10 flex flex-col md:flex-row justify-between items-start gap-6">
        <div>
          <h1 className="text-3xl md:text-4xl mb-4">Proof of Deliberation</h1>
          <p className="text-text-secondary text-lg max-w-[600px]">
            Cryptographic verification of the governance process for task{" "}
            <span className="mono text-text-primary">{taskId}</span>.
          </p>
        </div>
        <div className="px-6 py-3 bg-accent-muted border border-accent rounded-lg flex items-center gap-3 self-start">
          <ShieldCheck size={24} className="text-accent" />
          <div>
            <div className="mono text-xs text-accent">AGORA VERIFIED</div>
            <div className="text-sm font-medium">On-Chain Record</div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-10 w-full">
        <div className="card p-6">
          <div className="mono text-text-muted text-xs mb-2">MECHANISM USED</div>
          <div className="text-lg font-semibold">{task?.mechanism.toUpperCase() ?? "..."}</div>
        </div>
        <div className="card p-6">
          <div className="mono text-text-muted text-xs mb-2">CONSENSUS CONFIDENCE</div>
          <div className="mono text-lg font-semibold text-accent">
            {result ? `${(result.confidence * 100).toFixed(1)}%` : "..."}
          </div>
        </div>
        <div className="card p-6">
          <div className="mono text-text-muted text-xs mb-2">QUORUM</div>
          <div className="text-lg font-semibold text-accent flex items-center gap-2">
            <CheckCircle2 size={18} /> {quorumReached ? "Reached" : "Not Reached"}
          </div>
        </div>
        <div className="card p-6">
          <div className="mono text-text-muted text-xs mb-2">FINAL ANSWER</div>
          <div className="text-sm line-clamp-3">{result?.final_answer ?? task?.task_text ?? "..."}</div>
        </div>
        <div className="card p-6">
          <div className="mono text-text-muted text-xs mb-2">ROUNDS</div>
          <div className="text-lg font-semibold">
            {result?.round_count ?? 0}
            {task && task.mechanism_switches > 0 && (
              <span className="text-sm text-text-muted font-normal">
                {" "}
                · {task.mechanism_switches} switch
              </span>
            )}
          </div>
        </div>
        <div className="card p-6">
          <div className="mono text-text-muted text-xs mb-2">TOKEN COST</div>
          <div className="mono text-lg font-semibold">
            {result?.total_tokens_used ?? 0}
            <span className="text-sm text-text-muted font-normal"> tokens</span>
          </div>
        </div>
      </div>

      <h2 className="text-2xl mb-6">On-Chain Verification</h2>

      <div className="card p-6 mb-10 overflow-x-auto w-full">
        <table className="w-full min-w-[600px] border-collapse">
          <tbody>
            <tr className="border-b border-border-subtle">
              <td className="py-4 text-text-secondary w-[250px]">Merkle Root</td>
              <td className="py-4">
                <HashDisplay hash={result?.merkle_root ?? "Unavailable"} />
              </td>
              <td className="py-4 text-right"></td>
            </tr>
            <tr className="border-b border-border-subtle">
              <td className="py-4 text-text-secondary">Receipt Transaction</td>
              <td className="py-4">
                <HashDisplay hash={task?.solana_tx_hash ?? "Unavailable"} />
              </td>
              <td className="py-4 text-right">
                {task?.explorer_url ? (
                  <a
                    href={task.explorer_url}
                    className="text-accent flex items-center justify-end gap-1 text-sm"
                    target="_blank"
                    rel="noreferrer"
                  >
                    View Explorer <ExternalLink size={14} />
                  </a>
                ) : null}
              </td>
            </tr>
            <tr className="border-b border-border-subtle">
              <td className="py-4 text-text-secondary">Selector Reasoning Hash</td>
              <td className="py-4">
                <HashDisplay hash={task?.selector_reasoning_hash ?? "Unavailable"} />
              </td>
              <td className="py-4 text-right"></td>
            </tr>
            <tr className="border-b border-border-subtle">
              <td className="py-4 text-text-secondary">Configured Stake</td>
              <td colSpan={2} className="py-4">
                <div className="mono text-sm text-text-primary">
                  {task ? `${formatSolAmount(task.payment_amount)} SOL` : "n/a"}
                </div>
              </td>
            </tr>
            <tr className="border-b border-border-subtle">
              <td className="py-4 text-text-secondary">Locked Payment</td>
              <td colSpan={2} className="py-4">
                <div className="mono text-sm text-text-primary">
                  {task?.payment_status === "locked" ? `${formatSolAmount(task.payment_amount)} SOL` : "n/a"}
                </div>
              </td>
            </tr>
            <tr>
              <td className="py-4 text-text-secondary">Released Payment</td>
              <td colSpan={2} className="py-4">
                <div className="mono inline-flex items-center gap-2 bg-accent-muted text-accent px-3 py-1 rounded text-sm">
                  {paymentReleased ? `${formatSolAmount(task?.payment_amount ?? 0)} SOL` : "n/a"}
                  {paymentReleased ? <CheckCircle2 size={14} /> : null}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <MerkleTree rootHash={result?.merkle_root ?? null} leaves={result?.transcript_hashes ?? []} />

      <div className="mt-10 flex flex-col items-center gap-4">
        <button
          className="btn-primary w-[250px] justify-center"
          onClick={handleVerify}
          disabled={isVerifying || isVerified === true || !result}
        >
          {isVerifying
            ? "Recomputing Root..."
            : isVerified
              ? (
                  <>
                    <CheckCircle2 size={18} /> Receipt Valid
                  </>
                )
              : "Verify Locally"}
        </button>
        {task && canReleasePayment && (
          <button
            className="btn-secondary w-[250px] justify-center"
            onClick={handleReleasePayment}
            disabled={isPaying}
          >
            {isPaying ? "Releasing Payment..." : "Release Payment"}
          </button>
        )}
        {task && paymentLocked && task.status === "completed" && !quorumReached && (
          <p className="mono text-sm text-text-secondary max-w-[420px] text-center">
            Payment stays locked because this task completed without reaching quorum.
            {result ? ` Consensus confidence was ${(result.confidence * 100).toFixed(1)}%.` : ""}
          </p>
        )}
        {paymentError && (
          <p className="mono text-sm text-red-300 max-w-[420px] text-center">{paymentError}</p>
        )}
        {isVerified && (
          <p className="mono text-accent mt-2 text-sm">
            Recomputed Merkle root matches the receipt payload.
          </p>
        )}
      </div>
    </div>
  );
}

function formatSolAmount(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  const trimmed = value.toFixed(6).replace(/\.?0+$/, "");
  return trimmed.length > 0 ? trimmed : "0";
}
