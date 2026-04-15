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

    def _workspace_dir(self, workspace_id: str) -> Path:
        safe_workspace_id = validate_storage_id(workspace_id, field_name="workspace_id")
        return safe_child_path(self.root, "workspaces", safe_workspace_id)

    def _task_path(self, workspace_id: str, task_id: str) -> Path:
        safe_task_id = validate_storage_id(task_id, field_name="task_id")
        # Keep the users/ task layout for v1 compatibility while
        # tenancy semantics shift to workspaces.
        return self._user_dir(workspace_id) / "tasks" / f"{safe_task_id}.json"

    def _workspace_profile_path(self, workspace_id: str) -> Path:
        return self._workspace_dir(workspace_id) / "profile.json"

    def _api_key_path(self, workspace_id: str, key_id: str) -> Path:
        safe_key_id = validate_storage_id(key_id, field_name="key_id")
        return self._workspace_dir(workspace_id) / "api_keys" / f"{safe_key_id}.json"

    def _api_key_index_path(self, public_id: str) -> Path:
        safe_public_id = validate_storage_id(public_id, field_name="public_id")
        return safe_child_path(self.root, "api_keys", "by_public_id", f"{safe_public_id}.json")

    @staticmethod
    def _personal_workspace_id(user_id: str) -> str:
        safe_user_id = validate_storage_id(user_id, field_name="user_id")
        return safe_user_id

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any] | None:
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def _write_json(path: Path, data: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, default=str), encoding="utf-8")

    async def save_task(self, workspace_id: str, task_id: str, data: dict[str, Any]) -> None:
        path = self._task_path(workspace_id, task_id)
        self._write_json(path, data)

    async def upsert_user(
        self,
        user_id: str,
        email: str,
        name: str | None = None,
    ) -> dict[str, Any]:
        path = self._user_dir(user_id) / "profile.json"
        data = self._read_json(path)
        if data is not None:
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
        self._write_json(path, data)
        return data

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        return self._read_json(self._user_dir(user_id) / "profile.json")

    async def ensure_personal_workspace(
        self,
        user_id: str,
        email: str,
        name: str | None = None,
    ) -> dict[str, Any]:
        user = await self.upsert_user(user_id, email, name)
        workspace_id = str(user.get("workspace_id") or self._personal_workspace_id(user_id))
        now = datetime.now(UTC).isoformat()
        workspace_path = self._workspace_profile_path(workspace_id)
        workspace = self._read_json(workspace_path)
        if workspace is None:
            display_name = (name or email or user_id).strip() or user_id
            workspace = {
                "id": workspace_id,
                "display_name": f"{display_name}'s Workspace",
                "kind": "personal",
                "owner_user_id": user_id,
                "created_at": now,
            }
            self._write_json(workspace_path, workspace)
        if user.get("workspace_id") != workspace_id:
            user["workspace_id"] = workspace_id
            self._write_json(self._user_dir(user_id) / "profile.json", user)
        return workspace

    async def get_workspace(self, workspace_id: str) -> dict[str, Any] | None:
        return self._read_json(self._workspace_profile_path(workspace_id))

    async def get_task(self, workspace_id: str, task_id: str) -> dict[str, Any] | None:
        return self._read_json(self._task_path(workspace_id, task_id))

    async def list_user_tasks(self, workspace_id: str, limit: int = 20) -> list[dict[str, Any]]:
        task_dir = self._user_dir(workspace_id) / "tasks"
        if not task_dir.exists():
            return []

        files = sorted(task_dir.glob("*.json"), key=lambda file: file.stat().st_mtime, reverse=True)
        return [json.loads(file.read_text(encoding="utf-8")) for file in files[:limit]]

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

    async def save_api_key(self, workspace_id: str, key_id: str, data: dict[str, Any]) -> None:
        self._write_json(self._api_key_path(workspace_id, key_id), data)
        self._write_json(
            self._api_key_index_path(str(data["public_id"])),
            {"workspace_id": workspace_id, "key_id": key_id},
        )

    async def get_api_key(self, workspace_id: str, key_id: str) -> dict[str, Any] | None:
        return self._read_json(self._api_key_path(workspace_id, key_id))

    async def list_api_keys(self, workspace_id: str) -> list[dict[str, Any]]:
        api_key_dir = self._workspace_dir(workspace_id) / "api_keys"
        if not api_key_dir.exists():
            return []
        files = sorted(
            api_key_dir.glob("*.json"),
            key=lambda file: file.stat().st_mtime,
            reverse=True,
        )
        return [json.loads(file.read_text(encoding="utf-8")) for file in files]

    async def get_api_key_by_public_id(self, public_id: str) -> dict[str, Any] | None:
        index = self._read_json(self._api_key_index_path(public_id))
        if index is None:
            return None
        workspace_id = str(index["workspace_id"])
        key_id = str(index["key_id"])
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
