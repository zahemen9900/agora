"""Tests for hardened store failure semantics and event appends."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from google.api_core import exceptions as gcs_exceptions

from api.store import TaskStore
from api.store_errors import TaskStoreNotFound, TaskStorePayloadError, TaskStoreUnavailable
from api.store_local import LocalTaskStore


class _FakeBlob:
    def __init__(self, bucket: "_FakeBucket", name: str) -> None:
        self._bucket = bucket
        self.name = name
        self.generation: int | None = None

    @property
    def updated(self) -> datetime | None:
        record = self._bucket.objects.get(self.name)
        if record is None:
            return None
        return record["updated"]

    def _raise_if_failed(self, op: str) -> None:
        key = (self.name, op)
        queue = self._bucket.failures.get(key)
        if not queue:
            return
        exc = queue.pop(0)
        if not queue:
            self._bucket.failures.pop(key, None)
        raise exc

    def download_as_text(self) -> str:
        self._raise_if_failed("download")
        record = self._bucket.objects.get(self.name)
        if record is None:
            raise gcs_exceptions.NotFound("blob missing")
        self.generation = int(record["generation"])
        return str(record["payload"])

    def upload_from_string(
        self,
        payload: str,
        content_type: str,
        if_generation_match: int | None = None,
    ) -> None:
        del content_type
        self._raise_if_failed("upload")
        record = self._bucket.objects.get(self.name)

        if if_generation_match is not None:
            if record is None or int(record["generation"]) != int(if_generation_match):
                raise gcs_exceptions.PreconditionFailed("generation mismatch")

        generation = 1 if record is None else int(record["generation"]) + 1
        self._bucket.objects[self.name] = {
            "payload": payload,
            "generation": generation,
            "updated": datetime.now(UTC),
        }
        self.generation = generation

    def reload(self) -> None:
        self._raise_if_failed("reload")
        record = self._bucket.objects.get(self.name)
        if record is None:
            raise gcs_exceptions.NotFound("blob missing")
        self.generation = int(record["generation"])


class _FakeBucket:
    def __init__(self) -> None:
        self.objects: dict[str, dict[str, Any]] = {}
        self.failures: dict[tuple[str, str], list[Exception]] = {}

    def blob(self, name: str) -> _FakeBlob:
        return _FakeBlob(self, name)

    def list_blobs(self, prefix: str) -> list[_FakeBlob]:
        names = sorted(name for name in self.objects if name.startswith(prefix))
        return [self.blob(name) for name in names]

    def seed_json(self, name: str, payload: dict[str, Any], *, generation: int = 1) -> None:
        self.objects[name] = {
            "payload": json.dumps(payload),
            "generation": generation,
            "updated": datetime.now(UTC),
        }

    def seed_raw(self, name: str, payload: str, *, generation: int = 1) -> None:
        self.objects[name] = {
            "payload": payload,
            "generation": generation,
            "updated": datetime.now(UTC),
        }

    def fail_once(self, name: str, op: str, exc: Exception) -> None:
        self.failures[(name, op)] = [exc]


def _make_store(bucket: _FakeBucket) -> TaskStore:
    store = TaskStore.__new__(TaskStore)
    store.client = None  # type: ignore[assignment]
    store.bucket = bucket
    return store


@pytest.mark.asyncio
async def test_task_store_get_task_distinguishes_missing_payload_and_backend_failures() -> None:
    bucket = _FakeBucket()
    store = _make_store(bucket)

    assert await store.get_task("user-1", "task-1") is None

    blob_name = TaskStore._task_blob_name("user-1", "task-1")
    bucket.seed_raw(blob_name, "{malformed-json")
    with pytest.raises(TaskStorePayloadError):
        await store.get_task("user-1", "task-1")

    bucket.seed_json(blob_name, {"task_id": "task-1", "events": []})
    bucket.fail_once(blob_name, "download", RuntimeError("rpc unavailable"))
    with pytest.raises(TaskStoreUnavailable):
        await store.get_task("user-1", "task-1")


@pytest.mark.asyncio
async def test_task_store_append_event_retries_on_generation_conflicts() -> None:
    bucket = _FakeBucket()
    store = _make_store(bucket)
    blob_name = TaskStore._task_blob_name("user-1", "task-1")
    bucket.seed_json(
        blob_name,
        {
            "task_id": "task-1",
            "workspace_id": "user-1",
            "events": [],
        },
    )
    bucket.fail_once(
        blob_name,
        "upload",
        gcs_exceptions.PreconditionFailed("generation mismatch"),
    )

    await store.append_event("user-1", "task-1", {"event": "agent_output", "data": {}})
    task = await store.get_task("user-1", "task-1")
    assert task is not None
    assert len(task.get("events", [])) == 1
    assert task["events"][0]["event"] == "agent_output"


@pytest.mark.asyncio
async def test_task_store_append_event_raises_not_found_when_task_missing() -> None:
    store = _make_store(_FakeBucket())

    with pytest.raises(TaskStoreNotFound):
        await store.append_event("user-1", "task-1", {"event": "agent_output", "data": {}})


@pytest.mark.asyncio
async def test_local_store_append_event_raises_not_found_for_missing_task(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "local-store-missing-task"))

    with pytest.raises(TaskStoreNotFound):
        await store.append_event("user-1", "task-1", {"event": "agent_output", "data": {}})


@pytest.mark.asyncio
async def test_local_store_get_task_raises_payload_error_for_malformed_json(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "local-store-malformed-task"))
    task_path = store._task_path("user-1", "task-1")
    task_path.parent.mkdir(parents=True, exist_ok=True)
    task_path.write_text("{malformed-json", encoding="utf-8")

    with pytest.raises(TaskStorePayloadError):
        await store.get_task("user-1", "task-1")


@pytest.mark.asyncio
async def test_local_store_append_event_persists_timestamped_event(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "local-store-append"))
    await store.save_task(
        "user-1",
        "task-1",
        {
            "task_id": "task-1",
            "workspace_id": "user-1",
            "events": [],
        },
    )

    await store.append_event("user-1", "task-1", {"event": "agent_output", "data": {"text": "ok"}})
    task = await store.get_task("user-1", "task-1")

    assert task is not None
    events = task.get("events", [])
    assert len(events) == 1
    assert events[0]["event"] == "agent_output"
    assert events[0]["timestamp"]
