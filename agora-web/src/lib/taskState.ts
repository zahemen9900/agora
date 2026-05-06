import type { TaskStatusResponse } from "./api";

export const TASK_STOPPED_REASON = "Task stopped by user.";

export function isTaskActiveStatus(status: TaskStatusResponse["status"]): boolean {
  return status === "pending" || status === "in_progress";
}

export function isTaskStopping(task: Pick<TaskStatusResponse, "status" | "stop_requested_at">): boolean {
  return isTaskActiveStatus(task.status) && Boolean(task.stop_requested_at);
}

export function isTaskStopped(
  task: Pick<TaskStatusResponse, "status" | "failure_reason" | "latest_error_event">,
): boolean {
  if (task.status !== "failed") {
    return false;
  }
  if (task.latest_error_event?.event === "task_stopped") {
    return true;
  }
  return task.failure_reason === TASK_STOPPED_REASON;
}

export function taskStatusLabel(task: Pick<TaskStatusResponse, "status" | "stop_requested_at" | "failure_reason" | "latest_error_event">): string {
  if (isTaskStopping(task)) {
    return "stopping";
  }
  if (isTaskStopped(task)) {
    return "stopped";
  }
  if (task.status === "pending") {
    return "queued";
  }
  if (task.status === "in_progress") {
    return "running";
  }
  return task.status;
}

export function canStopTask(task: Pick<TaskStatusResponse, "status" | "stop_requested_at">): boolean {
  return isTaskActiveStatus(task.status) && !task.stop_requested_at;
}

export function canDeleteTask(task: Pick<TaskStatusResponse, "task_id">): boolean {
  return Boolean(task.task_id);
}
