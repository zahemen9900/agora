import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_STOPPED_REASON,
  canStopTask,
  isTaskStopped,
  isTaskStopping,
  taskStatusLabel,
} from "./taskState";

test("task stop helpers distinguish stopping from stopped", () => {
  assert.equal(isTaskStopping({ status: "in_progress", stop_requested_at: "2026-05-04T20:00:00Z" }), true);
  assert.equal(canStopTask({ status: "in_progress", stop_requested_at: null }), true);
  assert.equal(canStopTask({ status: "in_progress", stop_requested_at: "2026-05-04T20:00:00Z" }), false);
  assert.equal(
    isTaskStopped({
      status: "failed",
      failure_reason: TASK_STOPPED_REASON,
      latest_error_event: null,
    }),
    true,
  );
  assert.equal(
    isTaskStopped({
      status: "failed",
      failure_reason: "Task execution failed",
      latest_error_event: { event: "task_stopped", data: {}, timestamp: null },
    }),
    true,
  );
  assert.equal(
    taskStatusLabel({
      status: "failed",
      stop_requested_at: null,
      failure_reason: TASK_STOPPED_REASON,
      latest_error_event: null,
    }),
    "stopped",
  );
  assert.equal(
    taskStatusLabel({
      status: "in_progress",
      stop_requested_at: "2026-05-04T20:00:00Z",
      failure_reason: null,
      latest_error_event: null,
    }),
    "stopping",
  );
});
