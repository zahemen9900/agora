"""GCS-backed persistence abstraction for user tasks and events."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import structlog
from google.api_core import exceptions as gcs_exceptions
from google.cloud import storage

from api.security import validate_storage_id
from api.store_errors import TaskStoreNotFound, TaskStorePayloadError, TaskStoreUnavailable
from api.store_local import LocalTaskStore

logger = structlog.get_logger(__name__)


class TaskStore:
    _APPEND_EVENT_MAX_RETRIES = 3
    _AGORA_NAMESPACE_PREFIX = "agora"

    def __init__(self, bucket_name: str) -> None:
        self.client = storage.Client()
        self.bucket = self.client.bucket(bucket_name)

    @staticmethod
    def _serialize_json(data: dict[str, Any]) -> str:
        return json.dumps(data, default=str)

    def _decode_json_payload(
        self,
        payload: str,
        *,
        blob_name: str,
        operation: str,
    ) -> dict[str, Any]:
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise TaskStorePayloadError(
                f"Invalid JSON payload while {operation}: blob={blob_name}"
            ) from exc
        if not isinstance(parsed, dict):
            raise TaskStorePayloadError(
                f"Expected JSON object while {operation}: blob={blob_name}"
            )
        return parsed

    def _download_blob_json(
        self,
        blob: storage.Blob,
        *,
        allow_missing: bool,
        operation: str,
    ) -> dict[str, Any] | None:
        try:
            payload = blob.download_as_text()
        except gcs_exceptions.NotFound as exc:
            if allow_missing:
                return None
            raise TaskStoreNotFound(
                f"Missing blob while {operation}: blob={blob.name}"
            ) from exc
        except Exception as exc:
            raise TaskStoreUnavailable(
                f"Failed to read blob while {operation}: blob={blob.name}"
            ) from exc

        return self._decode_json_payload(payload, blob_name=blob.name, operation=operation)

    def _upload_blob_json(
        self,
        blob: storage.Blob,
        data: dict[str, Any],
        *,
        operation: str,
        if_generation_match: int | None = None,
    ) -> None:
        upload_kwargs: dict[str, Any] = {}
        if if_generation_match is not None:
            upload_kwargs["if_generation_match"] = if_generation_match

        try:
            blob.upload_from_string(
                self._serialize_json(data),
                content_type="application/json",
                **upload_kwargs,
            )
        except gcs_exceptions.PreconditionFailed:
            raise
        except Exception as exc:
            raise TaskStoreUnavailable(
                f"Failed to write blob while {operation}: blob={blob.name}"
            ) from exc

    def _list_blobs(self, *, prefix: str, operation: str) -> list[storage.Blob]:
        try:
            return list(self.bucket.list_blobs(prefix=prefix))
        except Exception as exc:
            raise TaskStoreUnavailable(
                f"Failed to list blobs while {operation}: prefix={prefix}"
            ) from exc

    @staticmethod
    def _user_prefix(user_id: str) -> str:
        safe_user_id = validate_storage_id(user_id, field_name="user_id")
        return f"users/{safe_user_id}"

    @staticmethod
    def _workspace_prefix(workspace_id: str) -> str:
        safe_workspace_id = validate_storage_id(workspace_id, field_name="workspace_id")
        return f"workspaces/{safe_workspace_id}"

    @classmethod
    def _task_blob_name(cls, workspace_id: str, task_id: str) -> str:
        safe_task_id = validate_storage_id(task_id, field_name="task_id")
        return (
            f"{cls._AGORA_NAMESPACE_PREFIX}/{cls._user_prefix(workspace_id)}"
            f"/tasks/{safe_task_id}.json"
        )

    @classmethod
    def _legacy_task_blob_name(cls, workspace_id: str, task_id: str) -> str:
        safe_task_id = validate_storage_id(task_id, field_name="task_id")
        return f"{cls._user_prefix(workspace_id)}/tasks/{safe_task_id}.json"

    @classmethod
    def _workspace_blob_name(cls, workspace_id: str) -> str:
        return f"{cls._workspace_prefix(workspace_id)}/profile.json"

    @classmethod
    def _api_key_blob_name(cls, workspace_id: str, key_id: str) -> str:
        safe_key_id = validate_storage_id(key_id, field_name="key_id")
        return f"{cls._workspace_prefix(workspace_id)}/api_keys/{safe_key_id}.json"

    @staticmethod
    def _api_key_index_blob_name(public_id: str) -> str:
        safe_public_id = validate_storage_id(public_id, field_name="public_id")
        return f"api_keys/by_public_id/{safe_public_id}.json"

    @staticmethod
    def _personal_workspace_id(user_id: str) -> str:
        safe_user_id = validate_storage_id(user_id, field_name="user_id")
        return safe_user_id

    @classmethod
    def _global_benchmark_blob_name(cls, artifact_id: str) -> str:
        safe_artifact_id = validate_storage_id(artifact_id, field_name="artifact_id")
        return f"{cls._AGORA_NAMESPACE_PREFIX}/benchmarks/{safe_artifact_id}.json"

    @classmethod
    def _user_benchmark_blob_name(cls, user_id: str, artifact_id: str) -> str:
        safe_artifact_id = validate_storage_id(artifact_id, field_name="artifact_id")
        return (
            f"{cls._AGORA_NAMESPACE_PREFIX}/{cls._user_prefix(user_id)}"
            f"/benchmarks/{safe_artifact_id}.json"
        )

    @classmethod
    def _user_test_blob_name(cls, user_id: str, run_id: str) -> str:
        safe_run_id = validate_storage_id(run_id, field_name="run_id")
        return f"{cls._AGORA_NAMESPACE_PREFIX}/{cls._user_prefix(user_id)}/tests/{safe_run_id}.json"

    @classmethod
    def _runtime_state_blob_name(cls, key: str) -> str:
        safe_key = validate_storage_id(key, field_name="runtime_state_key")
        return f"{cls._AGORA_NAMESPACE_PREFIX}/runtime/{safe_key}.json"

    async def upsert_user(
        self,
        user_id: str,
        email: str,
        name: str | None = None,
    ) -> dict[str, Any]:
        blob = self.bucket.blob(f"{self._user_prefix(user_id)}/profile.json")

        existing = self._download_blob_json(
            blob,
            allow_missing=True,
            operation="upsert_user.read_profile",
        )
        if existing is not None:
            existing["last_seen_at"] = datetime.now(UTC).isoformat()
            existing["email"] = email
            if name:
                existing["display_name"] = name
        else:
            existing = {
                "id": user_id,
                "email": email,
                "display_name": name or "",
                "created_at": datetime.now(UTC).isoformat(),
                "last_seen_at": datetime.now(UTC).isoformat(),
            }

        self._upload_blob_json(blob, existing, operation="upsert_user.write_profile")
        return existing

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        blob = self.bucket.blob(f"{self._user_prefix(user_id)}/profile.json")
        return self._download_blob_json(blob, allow_missing=True, operation="get_user")

    async def ensure_personal_workspace(
        self,
        user_id: str,
        email: str,
        name: str | None = None,
    ) -> dict[str, Any]:
        user = await self.upsert_user(user_id, email, name)
        workspace_id = str(user.get("workspace_id") or self._personal_workspace_id(user_id))
        workspace_blob = self.bucket.blob(self._workspace_blob_name(workspace_id))
        workspace = self._download_blob_json(
            workspace_blob,
            allow_missing=True,
            operation="ensure_personal_workspace.read_workspace",
        )
        display_name = (name or email or user_id).strip() or user_id
        desired_display_name = f"{display_name}'s Workspace"
        if workspace is None:
            workspace = {
                "id": workspace_id,
                "display_name": desired_display_name,
                "kind": "personal",
                "owner_user_id": user_id,
                "created_at": datetime.now(UTC).isoformat(),
            }
            self._upload_blob_json(
                workspace_blob,
                workspace,
                operation="ensure_personal_workspace.write_workspace",
            )
        elif name and str(workspace.get("display_name") or "") != desired_display_name:
            workspace["display_name"] = desired_display_name
            self._upload_blob_json(
                workspace_blob,
                workspace,
                operation="ensure_personal_workspace.refresh_workspace",
            )

        if user.get("workspace_id") != workspace_id:
            user["workspace_id"] = workspace_id
            user_blob = self.bucket.blob(f"{self._user_prefix(user_id)}/profile.json")
            self._upload_blob_json(
                user_blob,
                user,
                operation="ensure_personal_workspace.write_user_profile",
            )
        return workspace

    async def get_workspace(self, workspace_id: str) -> dict[str, Any] | None:
        blob = self.bucket.blob(self._workspace_blob_name(workspace_id))
        return self._download_blob_json(blob, allow_missing=True, operation="get_workspace")

    async def save_task(self, workspace_id: str, task_id: str, data: dict[str, Any]) -> None:
        blob = self.bucket.blob(self._task_blob_name(workspace_id, task_id))
        self._upload_blob_json(blob, data, operation="save_task")

    async def get_task(self, workspace_id: str, task_id: str) -> dict[str, Any] | None:
        blob = self.bucket.blob(self._task_blob_name(workspace_id, task_id))
        task = self._download_blob_json(blob, allow_missing=True, operation="get_task")
        if task is None:
            legacy_blob = self.bucket.blob(self._legacy_task_blob_name(workspace_id, task_id))
            task = self._download_blob_json(
                legacy_blob,
                allow_missing=True,
                operation="get_task.read_legacy",
            )
        if task is None:
            logger.debug(
                "task_not_found_or_unreadable",
                workspace_id=workspace_id,
                task_id=task_id,
            )
        return task

    async def list_user_tasks(self, workspace_id: str, limit: int = 20) -> list[dict[str, Any]]:
        prefixes = (
            f"{self._AGORA_NAMESPACE_PREFIX}/{self._user_prefix(workspace_id)}/tasks/",
            f"{self._user_prefix(workspace_id)}/tasks/",
        )
        blobs: list[storage.Blob] = []
        for prefix in prefixes:
            blobs.extend(self._list_blobs(prefix=prefix, operation="list_user_tasks"))
        blobs.sort(
            key=lambda blob: blob.updated or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )

        tasks: list[dict[str, Any]] = []
        seen_task_ids: set[str] = set()
        for blob in blobs:
            task = self._download_blob_json(
                blob,
                allow_missing=True,
                operation="list_user_tasks.read_task",
            )
            if task is None:
                continue
            dedupe_key = str(task.get("task_id") or blob.name)
            if dedupe_key in seen_task_ids:
                continue
            seen_task_ids.add(dedupe_key)
            tasks.append(task)
            if len(tasks) >= limit:
                break
        return tasks

    async def append_event(self, workspace_id: str, task_id: str, event: dict[str, Any]) -> None:
        blob = self.bucket.blob(self._task_blob_name(workspace_id, task_id))

        for attempt in range(1, self._APPEND_EVENT_MAX_RETRIES + 1):
            task = self._download_blob_json(
                blob,
                allow_missing=True,
                operation="append_event.read_task",
            )
            if task is None and attempt == 1:
                legacy_blob = self.bucket.blob(self._legacy_task_blob_name(workspace_id, task_id))
                legacy_task = self._download_blob_json(
                    legacy_blob,
                    allow_missing=True,
                    operation="append_event.read_legacy_task",
                )
                if legacy_task is not None:
                    blob = legacy_blob
                    task = legacy_task
            if task is None:
                raise TaskStoreNotFound(
                    "Cannot append event: "
                    f"task not found workspace_id={workspace_id} task_id={task_id}"
                )

            timestamp = event.get("timestamp") or datetime.now(UTC).isoformat()
            task.setdefault("events", []).append(
                {
                    **event,
                    "timestamp": timestamp,
                }
            )

            generation = blob.generation
            if generation is None:
                try:
                    blob.reload()
                except gcs_exceptions.NotFound as exc:
                    raise TaskStoreNotFound(
                        "Cannot append event: "
                        f"task disappeared workspace_id={workspace_id} task_id={task_id}"
                    ) from exc
                except Exception as exc:
                    raise TaskStoreUnavailable(
                        "Failed to refresh blob metadata during append_event"
                    ) from exc
                generation = blob.generation

            if generation is None:
                raise TaskStoreUnavailable(
                    "Missing blob generation metadata during append_event"
                )

            try:
                self._upload_blob_json(
                    blob,
                    task,
                    operation="append_event.write_task",
                    if_generation_match=int(generation),
                )
                return
            except gcs_exceptions.PreconditionFailed as exc:
                logger.warning(
                    "task_event_append_generation_conflict",
                    workspace_id=workspace_id,
                    task_id=task_id,
                    attempt=attempt,
                )
                if attempt >= self._APPEND_EVENT_MAX_RETRIES:
                    raise TaskStoreUnavailable(
                        "Failed to append event after repeated generation conflicts"
                    ) from exc

    async def get_events(self, workspace_id: str, task_id: str) -> list[dict[str, Any]]:
        task = await self.get_task(workspace_id, task_id)
        if task is None:
            return []
        return task.get("events", [])

    async def get_all_completed_tasks(self, workspace_id: str) -> list[dict[str, Any]]:
        tasks = await self.list_user_tasks(workspace_id, limit=500)
        return [task for task in tasks if task.get("status") == "completed"]

    async def get_completed_tasks_for_benchmarks(self, limit: int = 500) -> list[dict[str, Any]]:
        """Return completed tasks across all users for benchmark aggregation."""

        blobs: list[storage.Blob] = []
        for prefix in (f"{self._AGORA_NAMESPACE_PREFIX}/users/", "users/"):
            blobs.extend(
                self._list_blobs(prefix=prefix, operation="get_completed_tasks_for_benchmarks")
            )
        blobs.sort(
            key=lambda blob: blob.updated or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )

        tasks: list[dict[str, Any]] = []
        seen_task_ids: set[str] = set()
        for blob in blobs:
            if not blob.name.endswith(".json") or "/tasks/" not in blob.name:
                continue
            task = self._download_blob_json(
                blob,
                allow_missing=True,
                operation="get_completed_tasks_for_benchmarks.read_task",
            )
            if task is None:
                continue
            dedupe_key = str(task.get("task_id") or blob.name)
            if dedupe_key in seen_task_ids:
                continue
            seen_task_ids.add(dedupe_key)
            if task.get("status") in {"completed", "paid"}:
                tasks.append(task)
            if len(tasks) >= limit:
                break
        return tasks

    async def save_benchmark_summary(self, summary: dict[str, Any]) -> None:
        blob = self.bucket.blob("benchmarks/summary.json")
        self._upload_blob_json(blob, summary, operation="save_benchmark_summary")

    async def get_benchmark_summary(self) -> dict[str, Any] | None:
        blob = self.bucket.blob("benchmarks/summary.json")
        summary = self._download_blob_json(
            blob,
            allow_missing=True,
            operation="get_benchmark_summary",
        )
        if summary is None:
            logger.debug("benchmark_summary_not_found")
        return summary

    async def save_runtime_state(self, key: str, payload: dict[str, Any]) -> None:
        blob = self.bucket.blob(self._runtime_state_blob_name(key))
        self._upload_blob_json(blob, payload, operation="save_runtime_state")

    async def get_runtime_state(self, key: str) -> dict[str, Any] | None:
        blob = self.bucket.blob(self._runtime_state_blob_name(key))
        return self._download_blob_json(
            blob,
            allow_missing=True,
            operation="get_runtime_state",
        )

    async def save_global_benchmark_artifact(
        self,
        artifact_id: str,
        artifact: dict[str, Any],
    ) -> None:
        blob = self.bucket.blob(self._global_benchmark_blob_name(artifact_id))
        self._upload_blob_json(
            blob,
            artifact,
            operation="save_global_benchmark_artifact",
        )

    async def list_global_benchmark_artifacts(self, limit: int = 50) -> list[dict[str, Any]]:
        prefix = f"{self._AGORA_NAMESPACE_PREFIX}/benchmarks/"
        blobs = self._list_blobs(prefix=prefix, operation="list_global_benchmark_artifacts")
        blobs.sort(
            key=lambda blob: blob.updated or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )

        artifacts: list[dict[str, Any]] = []
        for blob in blobs[:limit]:
            artifact = self._download_blob_json(
                blob,
                allow_missing=True,
                operation="list_global_benchmark_artifacts.read_artifact",
            )
            if artifact is None:
                continue
            artifacts.append(artifact)
        return artifacts

    async def get_global_benchmark_artifact(self, artifact_id: str) -> dict[str, Any] | None:
        blob = self.bucket.blob(self._global_benchmark_blob_name(artifact_id))
        return self._download_blob_json(
            blob,
            allow_missing=True,
            operation="get_global_benchmark_artifact",
        )

    async def save_user_benchmark_artifact(
        self,
        user_id: str,
        artifact_id: str,
        artifact: dict[str, Any],
    ) -> None:
        blob = self.bucket.blob(self._user_benchmark_blob_name(user_id, artifact_id))
        self._upload_blob_json(
            blob,
            artifact,
            operation="save_user_benchmark_artifact",
        )

    async def list_user_benchmark_artifacts(
        self,
        user_id: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        prefix = f"{self._AGORA_NAMESPACE_PREFIX}/{self._user_prefix(user_id)}/benchmarks/"
        blobs = self._list_blobs(prefix=prefix, operation="list_user_benchmark_artifacts")
        blobs.sort(
            key=lambda blob: blob.updated or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )

        artifacts: list[dict[str, Any]] = []
        for blob in blobs[:limit]:
            artifact = self._download_blob_json(
                blob,
                allow_missing=True,
                operation="list_user_benchmark_artifacts.read_artifact",
            )
            if artifact is None:
                continue
            artifacts.append(artifact)
        return artifacts

    async def get_user_benchmark_artifact(
        self,
        user_id: str,
        artifact_id: str,
    ) -> dict[str, Any] | None:
        blob = self.bucket.blob(self._user_benchmark_blob_name(user_id, artifact_id))
        return self._download_blob_json(
            blob,
            allow_missing=True,
            operation="get_user_benchmark_artifact",
        )

    async def save_user_test_result(
        self,
        user_id: str,
        run_id: str,
        result: dict[str, Any],
    ) -> None:
        blob = self.bucket.blob(self._user_test_blob_name(user_id, run_id))
        self._upload_blob_json(blob, result, operation="save_user_test_result")

    async def get_user_test_result(self, user_id: str, run_id: str) -> dict[str, Any] | None:
        blob = self.bucket.blob(self._user_test_blob_name(user_id, run_id))
        return self._download_blob_json(
            blob,
            allow_missing=True,
            operation="get_user_test_result",
        )

    async def append_user_test_event(
        self,
        user_id: str,
        run_id: str,
        event: dict[str, Any],
    ) -> None:
        blob = self.bucket.blob(self._user_test_blob_name(user_id, run_id))

        for attempt in range(1, self._APPEND_EVENT_MAX_RETRIES + 1):
            record = self._download_blob_json(
                blob,
                allow_missing=True,
                operation="append_user_test_event.read_test",
            )
            if record is None:
                raise TaskStoreNotFound(
                    "Cannot append benchmark event: "
                    f"run not found user_id={user_id} run_id={run_id}"
                )

            timestamp = event.get("timestamp") or datetime.now(UTC).isoformat()
            record.setdefault("events", []).append(
                {
                    **event,
                    "timestamp": timestamp,
                }
            )

            generation = blob.generation
            if generation is None:
                try:
                    blob.reload()
                except gcs_exceptions.NotFound as exc:
                    raise TaskStoreNotFound(
                        "Cannot append benchmark event: "
                        f"run disappeared user_id={user_id} run_id={run_id}"
                    ) from exc
                except Exception as exc:
                    raise TaskStoreUnavailable(
                        "Failed to refresh benchmark run blob metadata during append"
                    ) from exc
                generation = blob.generation

            if generation is None:
                raise TaskStoreUnavailable(
                    "Missing benchmark run blob generation metadata during append"
                )

            try:
                self._upload_blob_json(
                    blob,
                    record,
                    operation="append_user_test_event.write_test",
                    if_generation_match=int(generation),
                )
                return
            except gcs_exceptions.PreconditionFailed as exc:
                logger.warning(
                    "benchmark_event_append_generation_conflict",
                    user_id=user_id,
                    run_id=run_id,
                    attempt=attempt,
                )
                if attempt >= self._APPEND_EVENT_MAX_RETRIES:
                    raise TaskStoreUnavailable(
                        "Failed to append benchmark event after repeated generation conflicts"
                    ) from exc

    async def get_user_test_events(self, user_id: str, run_id: str) -> list[dict[str, Any]]:
        record = await self.get_user_test_result(user_id, run_id)
        if record is None:
            return []
        return record.get("events", [])

    async def list_user_test_results(
        self,
        user_id: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        prefix = f"{self._AGORA_NAMESPACE_PREFIX}/{self._user_prefix(user_id)}/tests/"
        blobs = self._list_blobs(prefix=prefix, operation="list_user_test_results")
        blobs.sort(
            key=lambda blob: blob.updated or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )

        records: list[dict[str, Any]] = []
        for blob in blobs[:limit]:
            record = self._download_blob_json(
                blob,
                allow_missing=True,
                operation="list_user_test_results.read_test",
            )
            if record is None:
                continue
            records.append(record)
        return records

    async def save_api_key(self, workspace_id: str, key_id: str, data: dict[str, Any]) -> None:
        key_blob = self.bucket.blob(self._api_key_blob_name(workspace_id, key_id))
        self._upload_blob_json(key_blob, data, operation="save_api_key.write_key")
        index_blob = self.bucket.blob(self._api_key_index_blob_name(str(data["public_id"])))
        self._upload_blob_json(
            index_blob,
            {"workspace_id": workspace_id, "key_id": key_id},
            operation="save_api_key.write_index",
        )

    async def get_api_key(self, workspace_id: str, key_id: str) -> dict[str, Any] | None:
        blob = self.bucket.blob(self._api_key_blob_name(workspace_id, key_id))
        return self._download_blob_json(blob, allow_missing=True, operation="get_api_key")

    async def list_api_keys(self, workspace_id: str) -> list[dict[str, Any]]:
        prefix = f"{self._workspace_prefix(workspace_id)}/api_keys/"
        blobs = self._list_blobs(prefix=prefix, operation="list_api_keys")
        blobs.sort(
            key=lambda blob: blob.updated or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )
        keys: list[dict[str, Any]] = []
        for blob in blobs:
            key = self._download_blob_json(
                blob,
                allow_missing=True,
                operation="list_api_keys.read_key",
            )
            if key is None:
                continue
            keys.append(key)
        return keys

    async def get_api_key_by_public_id(self, public_id: str) -> dict[str, Any] | None:
        index_blob = self.bucket.blob(self._api_key_index_blob_name(public_id))
        index = self._download_blob_json(
            index_blob,
            allow_missing=True,
            operation="get_api_key_by_public_id.read_index",
        )
        if index is None:
            return None

        try:
            workspace_id = str(index["workspace_id"])
            key_id = str(index["key_id"])
        except KeyError as exc:
            raise TaskStorePayloadError(
                "API key public index payload missing required fields"
            ) from exc
        return await self.get_api_key(workspace_id, key_id)

    async def update_api_key(
        self,
        workspace_id: str,
        key_id: str,
        updates: dict[str, Any],
    ) -> dict[str, Any] | None:
        current = await self.get_api_key(workspace_id, key_id)
        if current is None:
            return None
        current.update(updates)
        await self.save_api_key(workspace_id, key_id, current)
        return current


def get_store(
    bucket_name: str | None,
    *,
    local_data_dir: str | None = None,
) -> TaskStore | LocalTaskStore:
    if bucket_name:
        return TaskStore(bucket_name)
    return LocalTaskStore(data_dir=local_data_dir or "api/data")
