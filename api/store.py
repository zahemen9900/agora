"""GCS-backed persistence abstraction for user tasks and events."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import structlog
from google.cloud import storage

from api.security import validate_storage_id
from api.store_local import LocalTaskStore

logger = structlog.get_logger(__name__)


class TaskStore:
    def __init__(self, bucket_name: str) -> None:
        self.client = storage.Client()
        self.bucket = self.client.bucket(bucket_name)

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
        # Keep the users/ task layout for v1 compatibility while
        # tenancy semantics shift to workspaces.
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

    async def upsert_user(
        self,
        user_id: str,
        email: str,
        name: str | None = None,
    ) -> dict[str, Any]:
        blob = self.bucket.blob(f"{self._user_prefix(user_id)}/profile.json")

        try:
            existing = json.loads(blob.download_as_text())
            existing["last_seen_at"] = datetime.now(UTC).isoformat()
            existing["email"] = email
            if name:
                existing["display_name"] = name
        except Exception:
            existing = {
                "id": user_id,
                "email": email,
                "display_name": name or "",
                "created_at": datetime.now(UTC).isoformat(),
                "last_seen_at": datetime.now(UTC).isoformat(),
            }

        blob.upload_from_string(json.dumps(existing), content_type="application/json")
        return existing

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        blob = self.bucket.blob(f"{self._user_prefix(user_id)}/profile.json")
        try:
            return json.loads(blob.download_as_text())
        except Exception:
            return None

    async def ensure_personal_workspace(
        self,
        user_id: str,
        email: str,
        name: str | None = None,
    ) -> dict[str, Any]:
        user = await self.upsert_user(user_id, email, name)
        workspace_id = str(user.get("workspace_id") or self._personal_workspace_id(user_id))
        workspace_blob = self.bucket.blob(self._workspace_blob_name(workspace_id))
        try:
            workspace = json.loads(workspace_blob.download_as_text())
        except Exception:
            display_name = (name or email or user_id).strip() or user_id
            workspace = {
                "id": workspace_id,
                "display_name": f"{display_name}'s Workspace",
                "kind": "personal",
                "owner_user_id": user_id,
                "created_at": datetime.now(UTC).isoformat(),
            }
            workspace_blob.upload_from_string(
                json.dumps(workspace),
                content_type="application/json",
            )

        if user.get("workspace_id") != workspace_id:
            user["workspace_id"] = workspace_id
            user_blob = self.bucket.blob(f"{self._user_prefix(user_id)}/profile.json")
            user_blob.upload_from_string(json.dumps(user), content_type="application/json")
        return workspace

    async def get_workspace(self, workspace_id: str) -> dict[str, Any] | None:
        blob = self.bucket.blob(self._workspace_blob_name(workspace_id))
        try:
            return json.loads(blob.download_as_text())
        except Exception:
            return None

    async def save_task(self, workspace_id: str, task_id: str, data: dict[str, Any]) -> None:
        blob = self.bucket.blob(self._task_blob_name(workspace_id, task_id))
        blob.upload_from_string(json.dumps(data, default=str), content_type="application/json")

    async def get_task(self, workspace_id: str, task_id: str) -> dict[str, Any] | None:
        blob = self.bucket.blob(self._task_blob_name(workspace_id, task_id))
        try:
            return json.loads(blob.download_as_text())
        except Exception:
            logger.debug(
                "task_not_found_or_unreadable",
                workspace_id=workspace_id,
                task_id=task_id,
            )
            return None

    async def list_user_tasks(self, workspace_id: str, limit: int = 20) -> list[dict[str, Any]]:
        prefix = f"{self._user_prefix(workspace_id)}/tasks/"
        blobs = list(self.bucket.list_blobs(prefix=prefix))
        blobs.sort(
            key=lambda blob: blob.updated or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )

        tasks: list[dict[str, Any]] = []
        for blob in blobs[:limit]:
            try:
                tasks.append(json.loads(blob.download_as_text()))
            except Exception:
                continue
        return tasks

    async def append_event(self, workspace_id: str, task_id: str, event: dict[str, Any]) -> None:
        task = await self.get_task(workspace_id, task_id)
        if task is None:
            return

        timestamp = event.get("timestamp") or datetime.now(UTC).isoformat()
        task.setdefault("events", []).append(
            {
                **event,
                "timestamp": timestamp,
            }
        )
        await self.save_task(workspace_id, task_id, task)

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

        blobs = list(self.bucket.list_blobs(prefix="users/"))
        blobs.sort(
            key=lambda blob: blob.updated or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )

        tasks: list[dict[str, Any]] = []
        for blob in blobs:
            if not blob.name.endswith(".json") or "/tasks/" not in blob.name:
                continue
            try:
                task = json.loads(blob.download_as_text())
            except Exception:
                continue
            if task.get("status") in {"completed", "paid"}:
                tasks.append(task)
            if len(tasks) >= limit:
                break
        return tasks

    async def save_benchmark_summary(self, summary: dict[str, Any]) -> None:
        blob = self.bucket.blob("benchmarks/summary.json")
        blob.upload_from_string(json.dumps(summary, default=str), content_type="application/json")

    async def get_benchmark_summary(self) -> dict[str, Any] | None:
        blob = self.bucket.blob("benchmarks/summary.json")
        try:
            return json.loads(blob.download_as_text())
        except Exception:
            logger.debug("benchmark_summary_not_found")
            return None

    async def save_api_key(self, workspace_id: str, key_id: str, data: dict[str, Any]) -> None:
        key_blob = self.bucket.blob(self._api_key_blob_name(workspace_id, key_id))
        key_blob.upload_from_string(json.dumps(data, default=str), content_type="application/json")
        index_blob = self.bucket.blob(self._api_key_index_blob_name(str(data["public_id"])))
        index_blob.upload_from_string(
            json.dumps({"workspace_id": workspace_id, "key_id": key_id}),
            content_type="application/json",
        )

    async def get_api_key(self, workspace_id: str, key_id: str) -> dict[str, Any] | None:
        blob = self.bucket.blob(self._api_key_blob_name(workspace_id, key_id))
        try:
            return json.loads(blob.download_as_text())
        except Exception:
            return None

    async def list_api_keys(self, workspace_id: str) -> list[dict[str, Any]]:
        prefix = f"{self._workspace_prefix(workspace_id)}/api_keys/"
        blobs = list(self.bucket.list_blobs(prefix=prefix))
        blobs.sort(
            key=lambda blob: blob.updated or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )
        keys: list[dict[str, Any]] = []
        for blob in blobs:
            try:
                keys.append(json.loads(blob.download_as_text()))
            except Exception:
                continue
        return keys

    async def get_api_key_by_public_id(self, public_id: str) -> dict[str, Any] | None:
        index_blob = self.bucket.blob(self._api_key_index_blob_name(public_id))
        try:
            index = json.loads(index_blob.download_as_text())
        except Exception:
            return None
        return await self.get_api_key(str(index["workspace_id"]), str(index["key_id"]))

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


def get_store(bucket_name: str | None) -> TaskStore | LocalTaskStore:
    if bucket_name:
        return TaskStore(bucket_name)
    return LocalTaskStore()
