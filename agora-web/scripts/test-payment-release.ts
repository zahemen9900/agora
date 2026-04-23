import assert from "node:assert/strict";

import { deriveReceiptPaymentState } from "../src/lib/paymentRelease";

const paidTask = {
  status: "paid",
  payment_status: "released",
  payment_amount: 0.2,
  quorum_reached: true,
  result: { quorum_reached: true },
} as const;

const completedQuorateTaskWithStalePaymentStatus = {
  status: "completed",
  payment_status: "none",
  payment_amount: 0.2,
  quorum_reached: true,
  result: { quorum_reached: true },
} as const;

const completedNonQuorateTask = {
  status: "completed",
  payment_status: "locked",
  payment_amount: 0.2,
  quorum_reached: false,
  result: { quorum_reached: false },
} as const;

const noStakeTask = {
  status: "completed",
  payment_status: "none",
  payment_amount: 0,
  quorum_reached: true,
  result: { quorum_reached: true },
} as const;

{
  const state = deriveReceiptPaymentState(completedQuorateTaskWithStalePaymentStatus);
  assert.equal(
    state.showReleaseButton,
    true,
    "quorate completed tasks with stake must show a release button even if payment_status is stale",
  );
  assert.equal(state.releaseEnabled, true, "quorate completed tasks must allow release");
  assert.equal(
    state.paymentLockedDisplay,
    true,
    "quorate completed tasks with stake must still render the locked payment summary even if payment_status is stale",
  );
}

{
  const state = deriveReceiptPaymentState(completedNonQuorateTask);
  assert.equal(
    state.showReleaseButton,
    true,
    "non-quorate completed tasks should still surface the release affordance",
  );
  assert.equal(state.releaseEnabled, false, "non-quorate tasks must keep payment release disabled");
  assert.equal(state.showLockedWarning, true, "non-quorate tasks must show the locked warning");
}

{
  const state = deriveReceiptPaymentState(paidTask);
  assert.equal(state.showReleaseButton, false, "already released tasks must not show a release button");
  assert.equal(state.paymentReleased, true, "already paid tasks must read as released");
}

{
  const state = deriveReceiptPaymentState(noStakeTask);
  assert.equal(state.showReleaseButton, false, "tasks without stake must not show a release button");
  assert.equal(
    state.showNoStakeMessage,
    true,
    "tasks without stake should explain that no payment was configured",
  );
}

console.log("payment release visibility checks passed");
