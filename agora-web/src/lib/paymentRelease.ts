export interface ReceiptPaymentTask {
  status?: string | null;
  payment_status?: string | null;
  payment_amount?: number | null;
  quorum_reached?: boolean | null;
  quorum_threshold?: number | null;
  result?: {
    confidence?: number | null;
    quorum_reached?: boolean | null;
  } | null;
}

export interface ReceiptPaymentState {
  paymentConfigured: boolean;
  taskSettled: boolean;
  paymentReleased: boolean;
  paymentLockedDisplay: boolean;
  quorumReached: boolean;
  showReleaseButton: boolean;
  releaseEnabled: boolean;
  showNoStakeMessage: boolean;
  showLockedWarning: boolean;
}

function normalizeThreshold(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0.6;
  }
  return Math.min(Math.max(value, 0), 1);
}

function deriveQuorumReached(task: ReceiptPaymentTask | null): boolean {
  if (!task) {
    return false;
  }

  const persistedQuorum = task.result?.quorum_reached ?? task.quorum_reached;
  const confidence = task.result?.confidence;
  const computedQuorum = typeof confidence === "number" && Number.isFinite(confidence)
    ? confidence >= normalizeThreshold(task.quorum_threshold)
    : null;

  if (persistedQuorum === true) {
    return true;
  }
  if (computedQuorum !== null) {
    return computedQuorum;
  }
  return persistedQuorum ?? false;
}

export function deriveReceiptPaymentState(task: ReceiptPaymentTask | null): ReceiptPaymentState {
  const paymentAmount = task?.payment_amount ?? 0;
  const paymentConfigured = Number.isFinite(paymentAmount) && paymentAmount > 0;
  const taskSettled = task?.status === "completed" || task?.status === "paid";
  const paymentReleased = task?.payment_status === "released" || task?.status === "paid";
  const paymentLockedDisplay = paymentConfigured && taskSettled && !paymentReleased;
  const quorumReached = deriveQuorumReached(task);
  const showReleaseButton = paymentConfigured && taskSettled && !paymentReleased;
  const releaseEnabled = showReleaseButton && quorumReached;

  return {
    paymentConfigured,
    taskSettled,
    paymentReleased,
    paymentLockedDisplay,
    quorumReached,
    showReleaseButton,
    releaseEnabled,
    showNoStakeMessage: !paymentConfigured,
    showLockedWarning: showReleaseButton && !quorumReached,
  };
}
