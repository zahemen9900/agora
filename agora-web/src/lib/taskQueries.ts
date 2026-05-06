import {
  useMutation,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";

import {
  deleteTask,
  getTask,
  listTasks,
  releaseTaskPayment,
  stopTask,
  submitTask,
  type TaskDeletePayload,
  type MechanismName,
  type TaskCreateResponse,
  type TaskEvent,
  type TaskStatusResponse,
} from "./api";
import type {
  ReasoningPresetState,
  RuntimeTierModelOverridesPayload,
} from "./deliberationConfig";
import { useAuth } from "./useAuth";

export const taskQueryKeys = {
  all: ["tasks"] as const,
  list: () => [...taskQueryKeys.all, "list"] as const,
  detail: (taskId: string) => [...taskQueryKeys.all, "detail", taskId, "detailed"] as const,
};

export interface SubmitTaskInput {
  taskText: string;
  agentCount: number;
  stakes: number;
  mechanismOverride?: MechanismName | null;
  reasoningPresets: Partial<ReasoningPresetState>;
  tierModelOverrides?: RuntimeTierModelOverridesPayload;
}

function toTaskListSnapshot(task: TaskStatusResponse): TaskStatusResponse {
  return {
    ...task,
    events: [],
    chain_operations: {},
  };
}

function taskListTimestamp(task: TaskStatusResponse): number {
  const timestamp = Date.parse(task.completed_at ?? task.created_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortTaskListSnapshots(tasks: TaskStatusResponse[]): TaskStatusResponse[] {
  return [...tasks].sort((a, b) => taskListTimestamp(b) - taskListTimestamp(a));
}

function taskEventTimestamp(event: TaskEvent): number {
  const timestamp = Date.parse(event.timestamp ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortTaskEvents(events: TaskEvent[]): TaskEvent[] {
  return [...events].sort((a, b) => {
    const timestampDelta = taskEventTimestamp(a) - taskEventTimestamp(b);
    if (timestampDelta !== 0) {
      return timestampDelta;
    }
    return eventSignature(a).localeCompare(eventSignature(b));
  });
}

function eventSignature(event: TaskEvent): string {
  return `${event.event}:${event.timestamp ?? ""}:${JSON.stringify(event.data)}`;
}

export function setTaskDetailCache(
  queryClient: QueryClient,
  task: TaskStatusResponse,
): void {
  queryClient.setQueryData(taskQueryKeys.detail(task.task_id), task);
  syncTaskListCache(queryClient, task);
}

export function patchTaskDetailCache(
  queryClient: QueryClient,
  taskId: string,
  updater: (current: TaskStatusResponse | undefined) => TaskStatusResponse | undefined,
): void {
  let nextValue: TaskStatusResponse | undefined;
  queryClient.setQueryData<TaskStatusResponse | undefined>(
    taskQueryKeys.detail(taskId),
    (current) => {
      nextValue = updater(current);
      return nextValue;
    },
  );
  if (nextValue) {
    syncTaskListCache(queryClient, nextValue);
  }
}

export function appendTaskDetailEventCache(
  queryClient: QueryClient,
  taskId: string,
  event: TaskEvent,
): void {
  patchTaskDetailCache(queryClient, taskId, (current) => {
    if (!current) {
      return current;
    }

    const nextSignature = eventSignature(event);
    const alreadyPresent = current.events.some((entry) => eventSignature(entry) === nextSignature);
    if (alreadyPresent) {
      return current;
    }

    return {
      ...current,
      events: sortTaskEvents([...current.events, event]),
    };
  });
}

export function syncTaskListCache(
  queryClient: QueryClient,
  task: TaskStatusResponse,
): void {
  const summaryTask = toTaskListSnapshot(task);
  queryClient.setQueryData<TaskStatusResponse[] | undefined>(
    taskQueryKeys.list(),
    (current) => {
      if (!current) {
        return current;
      }

      let found = false;
      const next = current.map((entry) => {
        if (entry.task_id !== summaryTask.task_id) {
          return entry;
        }

        found = true;
        return {
          ...entry,
          ...summaryTask,
          events: entry.events,
          chain_operations: entry.chain_operations,
        };
      });

      if (found) {
        return next;
      }

      return sortTaskListSnapshots([summaryTask, ...current]);
    },
  );
}

export function removeDeletedTaskFromCaches(
  queryClient: QueryClient,
  deleted: TaskDeletePayload,
): void {
  queryClient.removeQueries({ queryKey: taskQueryKeys.detail(deleted.task_id), exact: true });
  queryClient.setQueryData<TaskStatusResponse[] | undefined>(
    taskQueryKeys.list(),
    (current) => current?.filter((entry) => entry.task_id !== deleted.task_id),
  );
}

export function useTaskListQuery() {
  const { authStatus, getAccessToken } = useAuth();

  return useQuery({
    queryKey: taskQueryKeys.list(),
    enabled: authStatus === "authenticated",
    queryFn: async () => {
      const token = await getAccessToken();
      return listTasks(token);
    },
  });
}

export function useTaskDetailQuery(taskId: string | undefined) {
  const { authStatus, getAccessToken } = useAuth();

  return useQuery({
    queryKey: taskId ? taskQueryKeys.detail(taskId) : [...taskQueryKeys.all, "detail", "missing", "detailed"],
    enabled: authStatus === "authenticated" && Boolean(taskId),
    queryFn: async () => {
      if (!taskId) {
        throw new Error("Task id is required");
      }
      const token = await getAccessToken();
      return getTask(taskId, token, true);
    },
  });
}

export function useSubmitTaskMutation() {
  const { getAccessToken } = useAuth();

  return useMutation<TaskCreateResponse, Error, SubmitTaskInput>({
    mutationFn: async ({
      taskText,
      agentCount,
      stakes,
      mechanismOverride,
      reasoningPresets,
      tierModelOverrides,
    }) => {
      const token = await getAccessToken();
      return submitTask(
        taskText,
        agentCount,
        stakes,
        mechanismOverride ?? null,
        reasoningPresets,
        tierModelOverrides,
        token,
      );
    },
  });
}

export function useReleaseTaskPaymentMutation(taskId: string | undefined) {
  const { getAccessToken } = useAuth();

  return useMutation({
    mutationFn: async () => {
      if (!taskId) {
        throw new Error("Task id is required");
      }
      const token = await getAccessToken();
      return releaseTaskPayment(taskId, token);
    },
  });
}

export function useStopTaskMutation() {
  const { getAccessToken } = useAuth();

  return useMutation<TaskStatusResponse, Error, string>({
    mutationFn: async (taskId) => {
      const token = await getAccessToken();
      return stopTask(taskId, token);
    },
  });
}

export function useDeleteTaskMutation() {
  const { getAccessToken } = useAuth();

  return useMutation<TaskDeletePayload, Error, string>({
    mutationFn: async (taskId) => {
      const token = await getAccessToken();
      return deleteTask(taskId, token);
    },
  });
}
