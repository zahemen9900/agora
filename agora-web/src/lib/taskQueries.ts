import {
  useMutation,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";

import {
  getTask,
  listTasks,
  releaseTaskPayment,
  submitTask,
  type TaskCreateResponse,
  type TaskStatusResponse,
} from "./api";
import type { ReasoningPresetState } from "./deliberationConfig";
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
  reasoningPresets: Partial<ReasoningPresetState>;
}

function toTaskListSnapshot(task: TaskStatusResponse): TaskStatusResponse {
  return {
    ...task,
    events: [],
    chain_operations: {},
  };
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

      return found ? next : current;
    },
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
    mutationFn: async ({ taskText, agentCount, stakes, reasoningPresets }) => {
      const token = await getAccessToken();
      return submitTask(taskText, agentCount, stakes, reasoningPresets, token);
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
