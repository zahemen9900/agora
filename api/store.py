"""GCS-backed persistence abstraction for user tasks and events."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import structlog
from google.cloud import storage

from api.store_local import LocalTaskStore

logger = structlog.get_logger(__name__)


class TaskStore:
    def __init__(self, bucket_name: str) -> None:
        self.client = storage.Client()
        self.bucket = self.client.bucket(bucket_name)

    async def upsert_user(
        self,
        user_id: str,
        email: str,
        name: str | None = None,
    ) -> dict[str, Any]:
        blob = self.bucket.blob(f"users/{user_id}/profile.json")

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

    async def save_task(self, user_id: str, task_id: str, data: dict[str, Any]) -> None:
        blob = self.bucket.blob(f"users/{user_id}/tasks/{task_id}.json")
        blob.upload_from_string(json.dumps(data, default=str), content_type="application/json")

    async def get_task(self, user_id: str, task_id: str) -> dict[str, Any] | None:
        blob = self.bucket.blob(f"users/{user_id}/tasks/{task_id}.json")
        try:
            return json.loads(blob.download_as_text())
        except Exception:
            logger.debug("task_not_found_or_unreadable", user_id=user_id, task_id=task_id)
            return None

    async def list_user_tasks(self, user_id: str, limit: int = 20) -> list[dict[str, Any]]:
        prefix = f"users/{user_id}/tasks/"
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

    async def append_event(self, user_id: str, task_id: str, event: dict[str, Any]) -> None:
        task = await self.get_task(user_id, task_id)
        if task is None:
            return

        timestamp = event.get("timestamp") or datetime.now(UTC).isoformat()
        task.setdefault("events", []).append(
            {
                **event,
                "timestamp": timestamp,
            }
        )
        await self.save_task(user_id, task_id, task)

    async def get_events(self, user_id: str, task_id: str) -> list[dict[str, Any]]:
        task = await self.get_task(user_id, task_id)
        if task is None:
            return []
        return task.get("events", [])

    async def get_all_completed_tasks(self, user_id: str) -> list[dict[str, Any]]:
        tasks = await self.list_user_tasks(user_id, limit=500)
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


def get_store(bucket_name: str | None) -> TaskStore | LocalTaskStore:
    if bucket_name:
        return TaskStore(bucket_name)
    return LocalTaskStore()
