"""Local filesystem-backed task store for development."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from api.security import safe_child_path, validate_storage_id


class LocalTaskStore:
    def __init__(self, data_dir: str = "api/data") -> None:
        self.root = Path(data_dir).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _user_dir(self, user_id: str) -> Path:
        safe_user_id = validate_storage_id(user_id, field_name="user_id")
        return safe_child_path(self.root, "users", safe_user_id)

    def _task_path(self, user_id: str, task_id: str) -> Path:
        safe_task_id = validate_storage_id(task_id, field_name="task_id")
        return self._user_dir(user_id) / "tasks" / f"{safe_task_id}.json"

    async def save_task(self, user_id: str, task_id: str, data: dict[str, Any]) -> None:
        path = self._task_path(user_id, task_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, default=str), encoding="utf-8")

    async def upsert_user(
        self,
        user_id: str,
        email: str,
        name: str | None = None,
    ) -> dict[str, Any]:
        path = self._user_dir(user_id) / "profile.json"
        path.parent.mkdir(parents=True, exist_ok=True)

        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            data["last_seen_at"] = datetime.now(UTC).isoformat()
            data["email"] = email
            if name:
                data["display_name"] = name
        else:
            now = datetime.now(UTC).isoformat()
            data = {
                "id": user_id,
                "email": email,
                "display_name": name or "",
                "created_at": now,
                "last_seen_at": now,
            }

        path.write_text(json.dumps(data, default=str), encoding="utf-8")
        return data

    async def get_task(self, user_id: str, task_id: str) -> dict[str, Any] | None:
        path = self._task_path(user_id, task_id)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    async def list_user_tasks(self, user_id: str, limit: int = 20) -> list[dict[str, Any]]:
        task_dir = self._user_dir(user_id) / "tasks"
        if not task_dir.exists():
            return []

        files = sorted(task_dir.glob("*.json"), key=lambda file: file.stat().st_mtime, reverse=True)
        return [json.loads(file.read_text(encoding="utf-8")) for file in files[:limit]]

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

        task_files = sorted(
            self.root.glob("users/*/tasks/*.json"),
            key=lambda file: file.stat().st_mtime,
            reverse=True,
        )
        tasks: list[dict[str, Any]] = []
        for file in task_files:
            task = json.loads(file.read_text(encoding="utf-8"))
            if task.get("status") in {"completed", "paid"}:
                tasks.append(task)
            if len(tasks) >= limit:
                break
        return tasks

    async def save_benchmark_summary(self, summary: dict[str, Any]) -> None:
        path = self.root / "benchmarks" / "summary.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(summary, default=str), encoding="utf-8")

    async def get_benchmark_summary(self) -> dict[str, Any] | None:
        path = self.root / "benchmarks" / "summary.json"
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
