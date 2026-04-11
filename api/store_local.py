"""Local filesystem-backed task store for development."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class LocalTaskStore:
    def __init__(self, data_dir: str = "./data") -> None:
        self.root = Path(data_dir)
        self.root.mkdir(parents=True, exist_ok=True)

    async def save_task(self, user_id: str, task_id: str, data: dict[str, Any]) -> None:
        path = self.root / "users" / user_id / "tasks" / f"{task_id}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, default=str), encoding="utf-8")

    async def get_task(self, user_id: str, task_id: str) -> dict[str, Any] | None:
        path = self.root / "users" / user_id / "tasks" / f"{task_id}.json"
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    async def list_user_tasks(self, user_id: str, limit: int = 20) -> list[dict[str, Any]]:
        task_dir = self.root / "users" / user_id / "tasks"
        if not task_dir.exists():
            return []

        files = sorted(task_dir.glob("*.json"), key=lambda file: file.stat().st_mtime, reverse=True)
        return [json.loads(file.read_text(encoding="utf-8")) for file in files[:limit]]
