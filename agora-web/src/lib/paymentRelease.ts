export interface ReceiptPaymentTask {
  status?: string | null;
  payment_status?: string | null;
  payment_amount?: number | null;
  quorum_reached?: boolean | null;
  result?: {
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

export function deriveReceiptPaymentState(task: ReceiptPaymentTask | null): ReceiptPaymentState {
  const paymentAmount = task?.payment_amount ?? 0;
  const paymentConfigured = Number.isFinite(paymentAmount) && paymentAmount > 0;
  const taskSettled = task?.status === "completed" || task?.status === "paid";
  const paymentReleased = task?.payment_status === "released" || task?.status === "paid";
  const paymentLockedDisplay = paymentConfigured && taskSettled && !paymentReleased;
  const quorumReached = (task?.result?.quorum_reached ?? task?.quorum_reached) ?? false;
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
