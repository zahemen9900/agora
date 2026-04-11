"""GCS-backed persistence abstraction for user tasks and events."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from google.cloud import storage

from api.store_local import LocalTaskStore


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

        task.setdefault("events", []).append({
            **event,
            "timestamp": datetime.now(UTC).isoformat(),
        })
        await self.save_task(user_id, task_id, task)

    async def get_events(self, user_id: str, task_id: str) -> list[dict[str, Any]]:
        task = await self.get_task(user_id, task_id)
        if task is None:
            return []
        return task.get("events", [])


def get_store(bucket_name: str | None) -> TaskStore | LocalTaskStore:
    if bucket_name:
        return TaskStore(bucket_name)
    return LocalTaskStore()
