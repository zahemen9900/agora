import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";

import { removeDeletedTaskFromCaches, taskQueryKeys } from "./taskQueries";

test("removeDeletedTaskFromCaches drops task detail and list entries", () => {
  const queryClient = new QueryClient();

  queryClient.setQueryData(taskQueryKeys.detail("task-123"), { task_id: "task-123" });
  queryClient.setQueryData(taskQueryKeys.list(), [
    { task_id: "task-123", task_text: "remove me" },
    { task_id: "task-keep", task_text: "keep me" },
  ]);

  removeDeletedTaskFromCaches(queryClient, {
    task_id: "task-123",
    deleted_at: "2026-05-04T20:00:00Z",
    stopped_before_delete: true,
  });

  assert.equal(queryClient.getQueryData(taskQueryKeys.detail("task-123")), undefined);
  assert.deepEqual(
    queryClient.getQueryData<Array<{ task_id: string }>>(taskQueryKeys.list())?.map((entry) => entry.task_id),
    ["task-keep"],
  );
});
