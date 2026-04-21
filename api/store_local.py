"""Local filesystem-backed task store for development."""

from __future__ import annotations

import fcntl
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from api.security import safe_child_path, validate_storage_id
from api.store_errors import TaskStoreNotFound, TaskStorePayloadError, TaskStoreUnavailable


class LocalTaskStore:
    def __init__(self, data_dir: str = "api/data") -> None:
        self.root = Path(data_dir).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._agora_root = self.root / "agora"

    def _user_dir(self, user_id: str) -> Path:
        safe_user_id = validate_storage_id(user_id, field_name="user_id")
        return safe_child_path(self.root, "users", safe_user_id)

    def _workspace_dir(self, workspace_id: str) -> Path:
        safe_workspace_id = validate_storage_id(workspace_id, field_name="workspace_id")
        return safe_child_path(self.root, "workspaces", safe_workspace_id)

    def _task_path(self, workspace_id: str, task_id: str) -> Path:
        safe_task_id = validate_storage_id(task_id, field_name="task_id")
        safe_workspace_id = validate_storage_id(workspace_id, field_name="workspace_id")
        return safe_child_path(
            self._agora_root,
            "users",
            safe_workspace_id,
            "tasks",
            f"{safe_task_id}.json",
        )

    def _legacy_task_path(self, workspace_id: str, task_id: str) -> Path:
        safe_task_id = validate_storage_id(task_id, field_name="task_id")
        return self._user_dir(workspace_id) / "tasks" / f"{safe_task_id}.json"

    def _workspace_profile_path(self, workspace_id: str) -> Path:
        return self._workspace_dir(workspace_id) / "profile.json"

    def _api_key_path(self, workspace_id: str, key_id: str) -> Path:
        safe_key_id = validate_storage_id(key_id, field_name="key_id")
        return self._workspace_dir(workspace_id) / "api_keys" / f"{safe_key_id}.json"

    def _api_key_index_path(self, public_id: str) -> Path:
        safe_public_id = validate_storage_id(public_id, field_name="public_id")
        return safe_child_path(self.root, "api_keys", "by_public_id", f"{safe_public_id}.json")

    def _global_benchmark_path(self, artifact_id: str) -> Path:
        safe_artifact_id = validate_storage_id(artifact_id, field_name="artifact_id")
        return safe_child_path(self._agora_root, "benchmarks", f"{safe_artifact_id}.json")

    def _user_benchmark_path(self, user_id: str, artifact_id: str) -> Path:
        safe_user_id = validate_storage_id(user_id, field_name="user_id")
        safe_artifact_id = validate_storage_id(artifact_id, field_name="artifact_id")
        return safe_child_path(
            self._agora_root,
            "users",
            safe_user_id,
            "benchmarks",
            f"{safe_artifact_id}.json",
        )

    def _user_test_path(self, user_id: str, run_id: str) -> Path:
        safe_user_id = validate_storage_id(user_id, field_name="user_id")
        safe_run_id = validate_storage_id(run_id, field_name="run_id")
        return safe_child_path(
            self._agora_root,
            "users",
            safe_user_id,
            "tests",
            f"{safe_run_id}.json",
        )

    def _runtime_state_path(self, key: str) -> Path:
        safe_key = validate_storage_id(key, field_name="runtime_state_key")
        return safe_child_path(self._agora_root, "runtime", f"{safe_key}.json")

    @staticmethod
    def _personal_workspace_id(user_id: str) -> str:
        safe_user_id = validate_storage_id(user_id, field_name="user_id")
        return safe_user_id

    @staticmethod
    def _read_json(
        path: Path,
        *,
        allow_missing: bool,
        operation: str,
    ) -> dict[str, Any] | None:
        try:
            payload = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            if allow_missing:
                return None
            raise TaskStoreNotFound(f"Missing file while {operation}: path={path}") from None
        except OSError as exc:
            raise TaskStoreUnavailable(
                f"Failed to read file while {operation}: path={path}"
            ) from exc

        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise TaskStorePayloadError(f"Invalid JSON while {operation}: path={path}") from exc

        if not isinstance(parsed, dict):
            raise TaskStorePayloadError(f"Expected JSON object while {operation}: path={path}")
        return parsed

    @staticmethod
    def _write_json(path: Path, data: dict[str, Any], *, operation: str) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data, default=str), encoding="utf-8")
        except OSError as exc:
            raise TaskStoreUnavailable(
                f"Failed to write file while {operation}: path={path}"
            ) from exc

    async def save_task(self, workspace_id: str, task_id: str, data: dict[str, Any]) -> None:
        path = self._task_path(workspace_id, task_id)
        self._write_json(path, data, operation="save_task")

    async def upsert_user(
        self,
        user_id: str,
        email: str,
        name: str | None = None,
    ) -> dict[str, Any]:
        path = self._user_dir(user_id) / "profile.json"
        data = self._read_json(path, allow_missing=True, operation="upsert_user.read_profile")
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
        self._write_json(path, data, operation="upsert_user.write_profile")
        return data

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        return self._read_json(
            self._user_dir(user_id) / "profile.json",
            allow_missing=True,
            operation="get_user",
        )

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
        workspace = self._read_json(
            workspace_path,
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
                "created_at": now,
            }
            self._write_json(
                workspace_path,
                workspace,
                operation="ensure_personal_workspace.write_workspace",
            )
        elif name and str(workspace.get("display_name") or "") != desired_display_name:
            workspace["display_name"] = desired_display_name
            self._write_json(
                workspace_path,
                workspace,
                operation="ensure_personal_workspace.refresh_workspace",
            )
        if user.get("workspace_id") != workspace_id:
            user["workspace_id"] = workspace_id
            self._write_json(
                self._user_dir(user_id) / "profile.json",
                user,
                operation="ensure_personal_workspace.write_user_profile",
            )
        return workspace

    async def get_workspace(self, workspace_id: str) -> dict[str, Any] | None:
        return self._read_json(
            self._workspace_profile_path(workspace_id),
            allow_missing=True,
            operation="get_workspace",
        )

    async def get_task(self, workspace_id: str, task_id: str) -> dict[str, Any] | None:
        task = self._read_json(
            self._task_path(workspace_id, task_id),
            allow_missing=True,
            operation="get_task",
        )
        if task is not None:
            return task
        return self._read_json(
            self._legacy_task_path(workspace_id, task_id),
            allow_missing=True,
            operation="get_task.read_legacy",
        )

    async def list_user_tasks(self, workspace_id: str, limit: int = 20) -> list[dict[str, Any]]:
        safe_workspace_id = validate_storage_id(workspace_id, field_name="workspace_id")
        task_dirs = [
            safe_child_path(self._agora_root, "users", safe_workspace_id, "tasks"),
            self._user_dir(workspace_id) / "tasks",
        ]
        task_files = [
            file
            for task_dir in task_dirs
            if task_dir.exists()
            for file in task_dir.glob("*.json")
        ]
        files = sorted(
            task_files,
            key=lambda file: file.stat().st_mtime,
            reverse=True,
        )
        tasks: list[dict[str, Any]] = []
        seen_task_ids: set[str] = set()
        for file in files:
            task = self._read_json(file, allow_missing=True, operation="list_user_tasks.read_task")
            if task is None:
                continue
            dedupe_key = str(task.get("task_id") or file)
            if dedupe_key in seen_task_ids:
                continue
            seen_task_ids.add(dedupe_key)
            tasks.append(task)
            if len(tasks) >= limit:
                break
        return tasks

    async def append_event(self, workspace_id: str, task_id: str, event: dict[str, Any]) -> None:
        path = self._task_path(workspace_id, task_id)
        if not path.exists():
            legacy_path = self._legacy_task_path(workspace_id, task_id)
            if legacy_path.exists():
                path = legacy_path
        timestamp = event.get("timestamp") or datetime.now(UTC).isoformat()

        try:
            with path.open("r+", encoding="utf-8") as handle:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                try:
                    raw = handle.read()
                    try:
                        task = json.loads(raw)
                    except json.JSONDecodeError as exc:
                        raise TaskStorePayloadError(
                            f"Invalid JSON while append_event: path={path}"
                        ) from exc

                    if not isinstance(task, dict):
                        raise TaskStorePayloadError(
                            f"Expected JSON object while append_event: path={path}"
                        )

                    task.setdefault("events", []).append(
                        {
                            **event,
                            "timestamp": timestamp,
                        }
                    )

                    handle.seek(0)
                    handle.truncate()
                    handle.write(json.dumps(task, default=str))
                    handle.flush()
                    os.fsync(handle.fileno())
                finally:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except FileNotFoundError as exc:
            raise TaskStoreNotFound(
                f"Cannot append event: task not found workspace_id={workspace_id} task_id={task_id}"
            ) from exc
        except OSError as exc:
            raise TaskStoreUnavailable(
                f"Failed to append event: workspace_id={workspace_id} task_id={task_id}"
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

        task_files = sorted(
            [
                *self._agora_root.glob("users/*/tasks/*.json"),
                *self.root.glob("users/*/tasks/*.json"),
            ],
            key=lambda file: file.stat().st_mtime,
            reverse=True,
        )
        tasks: list[dict[str, Any]] = []
        seen_task_ids: set[str] = set()
        for file in task_files:
            task = self._read_json(
                file,
                allow_missing=True,
                operation="get_completed_tasks_for_benchmarks.read_task",
            )
            if task is None:
                continue
            dedupe_key = str(task.get("task_id") or file)
            if dedupe_key in seen_task_ids:
                continue
            seen_task_ids.add(dedupe_key)
            if task.get("status") in {"completed", "paid"}:
                tasks.append(task)
            if len(tasks) >= limit:
                break
        return tasks

    async def save_benchmark_summary(self, summary: dict[str, Any]) -> None:
        path = self.root / "benchmarks" / "summary.json"
        self._write_json(path, summary, operation="save_benchmark_summary")

    async def get_benchmark_summary(self) -> dict[str, Any] | None:
        path = self.root / "benchmarks" / "summary.json"
        return self._read_json(path, allow_missing=True, operation="get_benchmark_summary")

    async def save_runtime_state(self, key: str, payload: dict[str, Any]) -> None:
        self._write_json(
            self._runtime_state_path(key),
            payload,
            operation="save_runtime_state",
        )

    async def get_runtime_state(self, key: str) -> dict[str, Any] | None:
        return self._read_json(
            self._runtime_state_path(key),
            allow_missing=True,
            operation="get_runtime_state",
        )

    async def save_global_benchmark_artifact(
        self,
        artifact_id: str,
        artifact: dict[str, Any],
    ) -> None:
        self._write_json(
            self._global_benchmark_path(artifact_id),
            artifact,
            operation="save_global_benchmark_artifact",
        )

    async def list_global_benchmark_artifacts(self, limit: int = 50) -> list[dict[str, Any]]:
        benchmark_dir = safe_child_path(self._agora_root, "benchmarks")
        if not benchmark_dir.exists():
            return []

        files = sorted(
            benchmark_dir.glob("*.json"),
            key=lambda file: file.stat().st_mtime,
            reverse=True,
        )
        artifacts: list[dict[str, Any]] = []
        for file in files[:limit]:
            artifact = self._read_json(
                file,
                allow_missing=True,
                operation="list_global_benchmark_artifacts.read_artifact",
            )
            if artifact is None:
                continue
            artifacts.append(artifact)
        return artifacts

    async def get_global_benchmark_artifact(self, artifact_id: str) -> dict[str, Any] | None:
        return self._read_json(
            self._global_benchmark_path(artifact_id),
            allow_missing=True,
            operation="get_global_benchmark_artifact",
        )

    async def save_user_benchmark_artifact(
        self,
        user_id: str,
        artifact_id: str,
        artifact: dict[str, Any],
    ) -> None:
        self._write_json(
            self._user_benchmark_path(user_id, artifact_id),
            artifact,
            operation="save_user_benchmark_artifact",
        )

    async def list_user_benchmark_artifacts(
        self,
        user_id: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        safe_user_id = validate_storage_id(user_id, field_name="user_id")
        benchmark_dir = safe_child_path(self._agora_root, "users", safe_user_id, "benchmarks")
        if not benchmark_dir.exists():
            return []

        files = sorted(
            benchmark_dir.glob("*.json"),
            key=lambda file: file.stat().st_mtime,
            reverse=True,
        )
        artifacts: list[dict[str, Any]] = []
        for file in files[:limit]:
            artifact = self._read_json(
                file,
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
        return self._read_json(
            self._user_benchmark_path(user_id, artifact_id),
            allow_missing=True,
            operation="get_user_benchmark_artifact",
        )

    async def save_user_test_result(
        self,
        user_id: str,
        run_id: str,
        result: dict[str, Any],
    ) -> None:
        self._write_json(
            self._user_test_path(user_id, run_id),
            result,
            operation="save_user_test_result",
        )

    async def get_user_test_result(self, user_id: str, run_id: str) -> dict[str, Any] | None:
        return self._read_json(
            self._user_test_path(user_id, run_id),
            allow_missing=True,
            operation="get_user_test_result",
        )

    async def append_user_test_event(
        self,
        user_id: str,
        run_id: str,
        event: dict[str, Any],
    ) -> None:
        path = self._user_test_path(user_id, run_id)
        if not path.exists():
            raise TaskStoreNotFound(
                f"Cannot append benchmark event: run not found user_id={user_id} run_id={run_id}"
            )
        timestamp = event.get("timestamp") or datetime.now(UTC).isoformat()

        try:
            with path.open("r+", encoding="utf-8") as handle:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                try:
                    raw = handle.read()
                    try:
                        record = json.loads(raw)
                    except json.JSONDecodeError as exc:
                        raise TaskStorePayloadError(
                            f"Invalid JSON while append_user_test_event: path={path}"
                        ) from exc

                    if not isinstance(record, dict):
                        raise TaskStorePayloadError(
                            f"Expected JSON object while append_user_test_event: path={path}"
                        )

                    record.setdefault("events", []).append(
                        {
                            **event,
                            "timestamp": timestamp,
                        }
                    )

                    handle.seek(0)
                    handle.truncate()
                    handle.write(json.dumps(record, default=str))
                    handle.flush()
                    os.fsync(handle.fileno())
                finally:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except FileNotFoundError as exc:
            raise TaskStoreNotFound(
                f"Cannot append benchmark event: run not found user_id={user_id} run_id={run_id}"
            ) from exc
        except OSError as exc:
            raise TaskStoreUnavailable(
                f"Failed to append benchmark event: user_id={user_id} run_id={run_id}"
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
        safe_user_id = validate_storage_id(user_id, field_name="user_id")
        test_dir = safe_child_path(self._agora_root, "users", safe_user_id, "tests")
        if not test_dir.exists():
            return []

        files = sorted(
            test_dir.glob("*.json"),
            key=lambda file: file.stat().st_mtime,
            reverse=True,
        )
        results: list[dict[str, Any]] = []
        for file in files[:limit]:
            result = self._read_json(
                file,
                allow_missing=True,
                operation="list_user_test_results.read_test",
            )
            if result is None:
                continue
            results.append(result)
        return results

    async def save_api_key(self, workspace_id: str, key_id: str, data: dict[str, Any]) -> None:
        self._write_json(
            self._api_key_path(workspace_id, key_id),
            data,
            operation="save_api_key.write_key",
        )
        self._write_json(
            self._api_key_index_path(str(data["public_id"])),
            {"workspace_id": workspace_id, "key_id": key_id},
            operation="save_api_key.write_index",
        )

    async def get_api_key(self, workspace_id: str, key_id: str) -> dict[str, Any] | None:
        return self._read_json(
            self._api_key_path(workspace_id, key_id),
            allow_missing=True,
            operation="get_api_key",
        )

    async def list_api_keys(self, workspace_id: str) -> list[dict[str, Any]]:
        api_key_dir = self._workspace_dir(workspace_id) / "api_keys"
        if not api_key_dir.exists():
            return []
        files = sorted(
            api_key_dir.glob("*.json"),
            key=lambda file: file.stat().st_mtime,
            reverse=True,
        )
        keys: list[dict[str, Any]] = []
        for file in files:
            key = self._read_json(file, allow_missing=True, operation="list_api_keys.read_key")
            if key is None:
                continue
            keys.append(key)
        return keys

    async def get_api_key_by_public_id(self, public_id: str) -> dict[str, Any] | None:
        index = self._read_json(
            self._api_key_index_path(public_id),
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
