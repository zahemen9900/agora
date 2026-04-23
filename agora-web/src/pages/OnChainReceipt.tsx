import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  ShieldCheck,
  Copy,
  Check,
  AlertCircle,
} from "lucide-react";

import { MerkleTree } from "../components/MerkleTree";
import {
  verifyMerkleRoot,
  ApiRequestError,
} from "../lib/api";
import {
  taskQueryKeys,
  useReleaseTaskPaymentMutation,
  useTaskDetailQuery,
} from "../lib/taskQueries";
import { deriveReceiptPaymentState } from "../lib/paymentRelease";

const FONT = "'Commit Mono', 'SF Mono', monospace";
const SKELETON_STYLE_ID = "receipt-skeleton-kf";

function injectSkeletonKeyframes() {
  if (document.getElementById(SKELETON_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = SKELETON_STYLE_ID;
  s.textContent = `
    @keyframes rcpt-shimmer {
      0%   { background-position: -200% center; }
      100% { background-position:  200% center; }
    }
  `;
  document.head.appendChild(s);
}

function SkeletonBlock({
  w = "100%",
  h = "14px",
  radius = "6px",
  delay = 0,
}: {
  w?: string;
  h?: string;
  radius?: string;
  delay?: number;
}) {
  return (
    <div style={{
      width: w,
      height: h,
      borderRadius: radius,
      background: 'linear-gradient(90deg, var(--bg-base) 25%, var(--border-default) 50%, var(--bg-base) 75%)',
      backgroundSize: '200% 100%',
      animation: `rcpt-shimmer 1.5s ease-in-out ${delay}s infinite`,
    }} />
  );
}

function SkeletonStatCard({ delay = 0 }: { delay?: number }) {
  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-default)',
      borderTop: '3px solid var(--border-strong)',
      borderRadius: '12px',
      padding: '18px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    }}>
      <SkeletonBlock w="55%" h="9px" delay={delay} />
      <SkeletonBlock w="40%" h="18px" delay={delay} />
    </div>
  );
}

function SkeletonVerifCard() {
  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-default)',
      borderRadius: '16px',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '18px 24px',
        borderBottom: '1px solid var(--border-default)',
        background: 'linear-gradient(135deg, rgba(34,211,138,0.05) 0%, transparent 60%)',
      }}>
        <SkeletonBlock w="180px" h="10px" />
      </div>
      {[0, 0.05, 0.1, 0.15, 0.2, 0.25].map((d, i, arr) => (
        <div key={i} style={{
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
          padding: '14px 24px',
          borderBottom: i < arr.length - 1 ? '1px solid var(--border-default)' : 'none',
        }}>
          <SkeletonBlock w="160px" h="10px" delay={d} />
          <SkeletonBlock w="220px" h="12px" delay={d + 0.03} />
        </div>
      ))}
    </div>
  );
}

function CopyHash({ hash }: { hash: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  const val = hash ?? "Unavailable";
  const display = val !== "Unavailable" ? `${val.slice(0, 14)}…${val.slice(-6)}` : "Unavailable";

  const copy = () => {
    if (val === "Unavailable") return;
    void navigator.clipboard.writeText(val).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{
        fontFamily: FONT,
        fontSize: '12px',
        color: 'var(--text-primary)',
        wordBreak: 'break-all',
      }}>{display}</span>
      {val !== "Unavailable" && (
        <button
          type="button"
          onClick={copy}
          title="Copy"
          style={{
            flexShrink: 0,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: copied ? 'var(--accent-emerald)' : 'var(--text-tertiary)',
            padding: '2px',
            display: 'flex',
            alignItems: 'center',
            transition: 'color 0.15s ease',
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      )}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  accent?: boolean;
}

function StatCard({ label, value, accent }: StatCardProps) {
  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-default)',
      borderTop: `3px solid ${accent ? 'var(--accent-emerald)' : 'var(--border-strong)'}`,
      borderRadius: '12px',
      padding: '18px 20px',
    }}>
      <div style={{
        fontFamily: FONT,
        fontSize: '9px',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
        marginBottom: '10px',
        fontWeight: 600,
      }}>{label}</div>
      <div style={{
        fontFamily: FONT,
        fontSize: '15px',
        fontWeight: 700,
        color: accent ? 'var(--accent-emerald)' : 'var(--text-primary)',
        lineHeight: 1.3,
      }}>{value}</div>
    </div>
  );
}

export function OnChainReceipt() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const taskQuery = useTaskDetailQuery(taskId);
  const releasePaymentMutation = useReleaseTaskPaymentMutation(taskId);

  const [isVerifying, setIsVerifying] = useState(false);
  const [isVerified, setIsVerified] = useState<boolean | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [treeAnimKey, setTreeAnimKey] = useState(0);
  const task = taskQuery.data ?? null;
  const taskQueryError = taskQuery.error instanceof Error ? taskQuery.error.message : null;

  useEffect(() => {
    injectSkeletonKeyframes();
  }, []);

  useEffect(() => {
    if (taskQuery.error) {
      console.error(taskQuery.error);
    }
  }, [taskQuery.error]);

  const handleVerify = async () => {
    if (!task?.result) return;
    setIsVerifying(true);
    setIsVerified(null);
    // Enforce a minimum visual delay so computation feels real
    const [verified] = await Promise.all([
      verifyMerkleRoot(task.result.transcript_hashes, task.result.merkle_root),
      new Promise<void>((res) => setTimeout(res, 600)),
    ]);
    setIsVerified(verified);
    setIsVerifying(false);
    // Re-trigger tree animation by remounting with a new key
    setTreeAnimKey((k) => k + 1);
  };

  const handleReleasePayment = async () => {
    if (!taskId) return;
    setPaymentError(null);
    try {
      await releasePaymentMutation.mutateAsync();
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(taskId) }),
        queryClient.invalidateQueries({ queryKey: taskQueryKeys.list() }),
      ]).catch((error: unknown) => {
        console.error("Receipt cache refresh failed after payment release.", error);
      });
    } catch (error) {
      if (error instanceof ApiRequestError) {
        setPaymentError(error.message);
      } else if (error instanceof Error) {
        setPaymentError(error.message);
      } else {
        setPaymentError("Payment release failed.");
      }
    }
  };

  const result = task?.result;
  const paymentState = deriveReceiptPaymentState(task);
  const {
    paymentReleased,
    paymentLockedDisplay,
    quorumReached,
    showReleaseButton,
    releaseEnabled,
    showNoStakeMessage,
    showLockedWarning,
  } = paymentState;
  const loading = taskQuery.isPending && task === null;
  const isPaying = releasePaymentMutation.isPending;

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '0 0 80px', position: 'relative' }}>

      {/* Ambient glow */}
      <div style={{
        position: 'absolute',
        top: '-240px',
        right: '-60px',
        width: '520px',
        height: '520px',
        background: 'radial-gradient(circle at 50% 50%, rgba(34,211,138,0.12) 0%, transparent 62%)',
        pointerEvents: 'none',
        zIndex: 0,
      }} />

      {/* Back button */}
      <div style={{ position: 'relative', zIndex: 1, marginBottom: '32px' }}>
        <button
          type="button"
          onClick={() => navigate(`/task/${taskId ?? ''}`)}
          style={{
            display: 'inline-flex',
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
            const b = e.currentTarget;
            b.style.borderColor = 'var(--border-strong)';
            b.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            const b = e.currentTarget;
            b.style.borderColor = 'var(--border-default)';
            b.style.color = 'var(--text-secondary)';
          }}
        >
          <ArrowLeft size={14} />
          Back to task
        </button>
      </div>

      {taskQueryError && (
        <div style={{
          position: 'relative',
          zIndex: 1,
          marginBottom: '24px',
          padding: '12px 14px',
          borderRadius: '12px',
          border: '1px solid rgba(248,113,113,0.35)',
          background: 'rgba(248,113,113,0.08)',
          color: '#fca5a5',
          fontFamily: FONT,
          fontSize: '12px',
          lineHeight: 1.6,
        }}>
          {taskQueryError}
        </div>
      )}

      {/* Header */}
      <header style={{ position: 'relative', zIndex: 1, marginBottom: '40px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '24px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
              <span style={{
                display: 'inline-block',
                width: '5px', height: '5px',
                borderRadius: '50%',
                background: 'var(--accent-emerald)',
                flexShrink: 0,
              }} />
              <span style={{
                fontFamily: FONT,
                fontSize: '10px',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--text-tertiary)',
                fontWeight: 600,
              }}>On-Chain Receipt</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '14px' }}>
              <div style={{
                width: '44px', height: '44px',
                borderRadius: '10px',
                background: 'var(--accent-emerald-soft)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <ShieldCheck size={22} color="var(--accent-emerald)" />
              </div>
              <h1 style={{
                fontFamily: FONT,
                fontSize: 'clamp(24px, 4vw, 36px)',
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--text-primary)',
                margin: 0,
              }}>Proof of Deliberation</h1>
            </div>
            <p style={{
              fontFamily: "'Hanken Grotesk', sans-serif",
              fontSize: '14px',
              color: 'var(--text-secondary)',
              margin: 0,
              maxWidth: '540px',
              lineHeight: 1.6,
            }}>
              Cryptographic verification of the governance process for task{' '}
              <span style={{ fontFamily: FONT, color: 'var(--text-primary)', fontSize: '12px' }}>{taskId}</span>.
            </p>
          </div>

          {/* AGORA VERIFIED badge */}
          <div style={{
            padding: '12px 18px',
            background: 'var(--accent-emerald-soft)',
            border: '1px solid var(--accent-emerald)',
            borderRadius: '12px',
            display: 'flex', alignItems: 'center', gap: '10px',
            flexShrink: 0,
            alignSelf: 'flex-start',
          }}>
            <ShieldCheck size={20} color="var(--accent-emerald)" />
            <div>
              <div style={{
                fontFamily: FONT,
                fontSize: '9px',
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--accent-emerald)',
                fontWeight: 700,
              }}>Agora Verified</div>
              <div style={{
                fontFamily: FONT,
                fontSize: '11px',
                color: 'var(--text-secondary)',
                marginTop: '2px',
              }}>On-Chain Record</div>
            </div>
          </div>
        </div>
      </header>

      {/* ── Stat cards ─────────────────────────────────────────────── */}
      <div style={{
        position: 'relative', zIndex: 1,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        gap: '12px',
        marginBottom: '32px',
      }}>
        {loading ? (
          [0, 0.06, 0.12, 0.18, 0.24].map((d) => (
            <SkeletonStatCard key={d} delay={d} />
          ))
        ) : (
          <>
            <StatCard label="Mechanism Used" value={task?.mechanism.toUpperCase() ?? "…"} />
            <StatCard
              label="Consensus Confidence"
              value={result ? `${(result.confidence * 100).toFixed(1)}%` : "…"}
              accent
            />
            <StatCard
              label="Quorum"
              value={
                result ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <CheckCircle2 size={15} />
                    {quorumReached ? "Reached" : "Not Reached"}
                  </span>
                ) : "…"
              }
              accent={quorumReached}
            />
            <StatCard
              label="Rounds"
              value={
                <>
                  {result?.round_count ?? 0}
                  {task && task.mechanism_switches > 0 && (
                    <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: '4px' }}>
                      · {task.mechanism_switches} switch
                    </span>
                  )}
                </>
              }
            />
            <StatCard
              label="Token Cost"
              value={
                <>
                  {result?.total_tokens_used ?? 0}
                  <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: '4px' }}>tokens</span>
                </>
              }
            />
          </>
        )}
      </div>

      {/* ── Final answer card ───────────────────────────────────────── */}
      {loading ? (
        <div style={{
          position: 'relative', zIndex: 1,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          borderTop: '3px solid var(--border-strong)',
          borderRadius: '12px',
          padding: '20px 24px',
          marginBottom: '32px',
          display: 'flex', flexDirection: 'column', gap: '10px',
        }}>
          <SkeletonBlock w="100px" h="9px" />
          <SkeletonBlock w="100%" h="13px" delay={0.05} />
          <SkeletonBlock w="85%" h="13px" delay={0.08} />
          <SkeletonBlock w="60%" h="13px" delay={0.11} />
        </div>
      ) : (result?.final_answer || task?.task_text) ? (
        <div style={{
          position: 'relative', zIndex: 1,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          borderTop: '3px solid var(--accent-emerald)',
          borderRadius: '12px',
          padding: '20px 24px',
          marginBottom: '32px',
        }}>
          <div style={{
            fontFamily: FONT,
            fontSize: '9px',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
            marginBottom: '10px',
            fontWeight: 600,
          }}>Final Answer</div>
          <p style={{
            fontFamily: "'Hanken Grotesk', sans-serif",
            fontSize: '14px',
            color: 'var(--text-primary)',
            margin: 0,
            lineHeight: 1.7,
          }}>
            {result?.final_answer ?? task?.task_text}
          </p>
        </div>
      ) : null}

      {/* ── On-chain verification card ──────────────────────────────── */}
      {loading ? (
        <div style={{ position: 'relative', zIndex: 1, marginBottom: '32px' }}>
          <SkeletonVerifCard />
        </div>
      ) : (
        <div style={{
          position: 'relative', zIndex: 1,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          borderRadius: '16px',
          overflow: 'hidden',
          marginBottom: '32px',
        }}>
          <div style={{
            padding: '18px 24px',
            borderBottom: '1px solid var(--border-default)',
            background: 'linear-gradient(135deg, rgba(34,211,138,0.05) 0%, transparent 60%)',
          }}>
            <span style={{
              fontFamily: FONT,
              fontSize: '10px',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
              fontWeight: 600,
            }}>On-Chain Verification</span>
          </div>

          {[
            { label: 'Merkle Root', value: <CopyHash hash={result?.merkle_root} />, extra: null },
            {
              label: 'Receipt Transaction',
              value: <CopyHash hash={task?.solana_tx_hash} />,
              extra: task?.explorer_url ? (
                <a
                  href={task.explorer_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontFamily: FONT,
                    fontSize: '11px',
                    color: 'var(--accent-emerald)',
                    textDecoration: 'none',
                    flexShrink: 0,
                  }}
                >
                  Explorer <ExternalLink size={12} />
                </a>
              ) : null,
            },
            { label: 'Selector Reasoning Hash', value: <CopyHash hash={task?.selector_reasoning_hash} />, extra: null },
            {
              label: 'Configured Stake',
              value: (
                <span style={{ fontFamily: FONT, fontSize: '12px', color: 'var(--text-primary)' }}>
                  {task ? `${formatSolAmount(task.payment_amount)} SOL` : "n/a"}
                </span>
              ),
              extra: null,
            },
            {
              label: 'Locked Payment',
              value: (
                <span style={{ fontFamily: FONT, fontSize: '12px', color: 'var(--text-primary)' }}>
                  {task && paymentLockedDisplay ? `${formatSolAmount(task.payment_amount)} SOL` : "n/a"}
                </span>
              ),
              extra: null,
            },
            {
              label: 'Released Payment',
              value: (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontFamily: FONT,
                  fontSize: '12px',
                  padding: '3px 10px',
                  borderRadius: '6px',
                  background: paymentReleased ? 'var(--accent-emerald-soft)' : 'transparent',
                  color: paymentReleased ? 'var(--accent-emerald)' : 'var(--text-tertiary)',
                }}>
                  {paymentReleased ? `${formatSolAmount(task?.payment_amount ?? 0)} SOL` : "n/a"}
                  {paymentReleased && <CheckCircle2 size={12} />}
                </span>
              ),
              extra: null,
            },
          ].map(({ label, value, extra }, i, arr) => (
            <div
              key={label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '16px',
                padding: '14px 24px',
                borderBottom: i < arr.length - 1 ? '1px solid var(--border-default)' : 'none',
              }}
            >
              <span style={{
                fontFamily: FONT,
                fontSize: '11px',
                color: 'var(--text-tertiary)',
                flexShrink: 0,
                width: '220px',
              }}>{label}</span>
              <div style={{ flex: 1, minWidth: 0 }}>{value}</div>
              {extra && <div style={{ flexShrink: 0 }}>{extra}</div>}
            </div>
          ))}
        </div>
      )}

      {/* ── Merkle tree ─────────────────────────────────────────────── */}
      <div style={{ position: 'relative', zIndex: 1, marginBottom: '32px' }}>
        {loading ? (
          <div style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
            borderRadius: '16px',
            overflow: 'hidden',
          }}>
            <div style={{
              padding: '18px 24px',
              borderBottom: '1px solid var(--border-default)',
              background: 'linear-gradient(135deg, rgba(34,211,138,0.05) 0%, transparent 60%)',
            }}>
              <SkeletonBlock w="200px" h="10px" />
            </div>
            <div style={{ padding: '32px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
              <SkeletonBlock w="480px" h="120px" radius="10px" />
              <SkeletonBlock w="320px" h="44px" radius="8px" delay={0.1} />
              <SkeletonBlock w="180px" h="44px" radius="8px" delay={0.2} />
            </div>
          </div>
        ) : (
          <MerkleTree
            key={treeAnimKey}
            rootHash={result?.merkle_root ?? null}
            leaves={result?.transcript_hashes ?? []}
          />
        )}
      </div>

      {/* ── Actions ─────────────────────────────────────────────────── */}
      <div style={{
        position: 'relative', zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '12px',
        marginTop: '8px',
      }}>
        <button
          type="button"
          onClick={handleVerify}
          disabled={isVerifying || isVerified === true || !result}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            width: '260px',
            padding: '11px 24px',
            borderRadius: '10px',
            border: 'none',
            background: isVerified ? 'var(--accent-emerald-soft)' : 'var(--accent-emerald)',
            color: isVerified ? 'var(--accent-emerald)' : '#000',
            fontFamily: FONT,
            fontSize: '12px',
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            cursor: isVerifying || isVerified === true || !result ? 'not-allowed' : 'pointer',
            transition: 'background 0.15s ease, color 0.15s ease',
            opacity: !result ? 0.5 : 1,
          }}
        >
          {isVerifying ? (
            "Recomputing Root…"
          ) : isVerified ? (
            <><CheckCircle2 size={15} /> Receipt Valid</>
          ) : (
            "Verify Locally"
          )}
        </button>
        {task && showReleaseButton && (
          <button
            type="button"
            onClick={handleReleasePayment}
            disabled={isPaying || !releaseEnabled}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              width: '260px',
              padding: '11px 24px',
              borderRadius: '10px',
              border: `1px solid ${releaseEnabled ? 'var(--border-strong)' : 'var(--border-default)'}`,
              background: 'transparent',
              color: releaseEnabled ? 'var(--text-secondary)' : 'var(--text-tertiary)',
              fontFamily: FONT,
              fontSize: '12px',
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              cursor: isPaying ? 'not-allowed' : releaseEnabled ? 'pointer' : 'not-allowed',
              transition: 'border-color 0.15s ease, color 0.15s ease',
              opacity: isPaying ? 0.7 : 1,
            }}
            onMouseEnter={(e) => {
              if (!isPaying && releaseEnabled) {
                e.currentTarget.style.borderColor = 'var(--accent-emerald)';
                e.currentTarget.style.color = 'var(--accent-emerald)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = releaseEnabled ? 'var(--border-strong)' : 'var(--border-default)';
              e.currentTarget.style.color = releaseEnabled ? 'var(--text-secondary)' : 'var(--text-tertiary)';
            }}
          >
            {isPaying ? "Releasing Payment…" : "Release Payment"}
          </button>
        )}
        {task && paymentReleased && (
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            width: '260px',
            padding: '11px 24px',
            borderRadius: '10px',
            border: '1px solid var(--accent-emerald)',
            background: 'var(--accent-emerald-soft)',
            color: 'var(--accent-emerald)',
            fontFamily: FONT,
            fontSize: '12px',
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            justifyContent: 'center',
          }}>
            <CheckCircle2 size={15} />
            Payment Released
          </div>
        )}
        {task && showNoStakeMessage && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 16px',
            borderRadius: '10px',
            border: '1px solid var(--border-default)',
            background: 'var(--bg-elevated)',
            fontFamily: FONT,
            fontSize: '11px',
            color: 'var(--text-tertiary)',
            maxWidth: '420px',
            textAlign: 'center',
            justifyContent: 'center',
          }}>
            No payment stake was configured for this task.
          </div>
        )}
        {task && showLockedWarning && (
          <div style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            padding: '10px 16px',
            borderRadius: '10px',
            border: '1px solid var(--border-default)',
            background: 'var(--bg-elevated)',
            fontFamily: FONT,
            fontSize: '11px',
            color: 'var(--text-secondary)',
            maxWidth: '420px',
            textAlign: 'left',
          }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>
              Payment stays locked because this task completed without reaching quorum.
              {result ? ` Consensus confidence was ${(result.confidence * 100).toFixed(1)}%.` : ""}
            </span>
          </div>
        )}
        {paymentError && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 16px',
            borderRadius: '10px',
            border: '1px solid var(--accent-rose)',
            background: 'var(--accent-rose-soft)',
            fontFamily: FONT,
            fontSize: '12px',
            color: 'var(--accent-rose)',
            maxWidth: '340px',
            textAlign: 'center',
          }}>
            <AlertCircle size={14} style={{ flexShrink: 0 }} />
            {paymentError}
          </div>
        )}
        {isVerified && (
          <p style={{
            fontFamily: FONT,
            fontSize: '11px',
            color: 'var(--accent-emerald)',
            margin: '4px 0 0',
            textAlign: 'center',
          }}>
            Recomputed Merkle root matches the receipt payload.
          </p>
        )}
      </div>
    </div>
  );
}

function formatSolAmount(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const trimmed = value.toFixed(6).replace(/\.?0+$/, "");
  return trimmed.length > 0 ? trimmed : "0";
}
