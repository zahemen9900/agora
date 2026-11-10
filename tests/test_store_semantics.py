"""Tests for hardened store failure semantics and event appends."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from google.api_core import exceptions as gcs_exceptions

from api.config import Settings
from api.store import TaskStore, get_store, resolve_storage_settings
from api.store_errors import TaskStoreNotFound, TaskStorePayloadError, TaskStoreUnavailable
from api.store_local import LocalTaskStore


class _FakeBlob:
    def __init__(self, bucket: _FakeBucket, name: str) -> None:
        self._bucket = bucket
        self.name = name
        self.generation: int | str | None = None

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
        self.generation = record["generation"]
        return str(record["payload"])

    def upload_from_string(
        self,
        payload: str,
        content_type: str,
        if_generation_match: int | str | None = None,
    ) -> None:
        del content_type
        self._raise_if_failed("upload")
        record = self._bucket.objects.get(self.name)

        if if_generation_match is not None:
            if record is None or record["generation"] != if_generation_match:
                raise gcs_exceptions.PreconditionFailed("generation mismatch")

        if record is None:
            generation: int | str = 1
        elif isinstance(record["generation"], int):
            generation = record["generation"] + 1
        else:
            generation = f"{record['generation']}-next"
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
        self.generation = record["generation"]


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
    store.backend = "gcs"
    store.bucket_name = "test-bucket"
    store.client = None  # type: ignore[assignment]
    store.bucket = bucket
    return store


@pytest.mark.asyncio
async def test_task_store_get_task_distinguishes_missing_payload_and_backend_failures() -> None:
    bucket = _FakeBucket()
    store = _make_store(bucket)

    assert await store.get_task("user-1", "task-1") is None

    blob_name = TaskStore._task_blob_name("user-1", "task-1")
    assert blob_name == "agora/users/user-1/tasks/task-1.json"
    bucket.seed_raw(blob_name, "{malformed-json")
    with pytest.raises(TaskStorePayloadError):
        await store.get_task("user-1", "task-1")

    bucket.seed_json(blob_name, {"task_id": "task-1", "events": []})
    bucket.fail_once(blob_name, "download", RuntimeError("rpc unavailable"))
    with pytest.raises(TaskStoreUnavailable):
        await store.get_task("user-1", "task-1")


@pytest.mark.asyncio
async def test_task_store_get_task_reads_legacy_task_prefix() -> None:
    bucket = _FakeBucket()
    store = _make_store(bucket)
    legacy_blob_name = TaskStore._legacy_task_blob_name("user-1", "task-1")
    bucket.seed_json(legacy_blob_name, {"task_id": "task-1", "events": []})

    task = await store.get_task("user-1", "task-1")

    assert task is not None
    assert task["task_id"] == "task-1"


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
async def test_task_store_append_events_persists_all_events_in_order() -> None:
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

    await store.append_events(
        "user-1",
        "task-1",
        [
            {"event": "agent_output_delta", "data": {"chunk": "hello"}},
            {"event": "usage_delta", "data": {"total_tokens": 42}},
        ],
    )

    task = await store.get_task("user-1", "task-1")
    assert task is not None
    events = task.get("events", [])
    assert [event["event"] for event in events] == ["agent_output_delta", "usage_delta"]
    assert all(event["timestamp"] for event in events)


@pytest.mark.asyncio
async def test_task_store_append_event_accepts_opaque_generation_token() -> None:
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
        generation="etag-1",  # type: ignore[arg-type]
    )

    await store.append_event("user-1", "task-1", {"event": "agent_output", "data": {}})

    task = await store.get_task("user-1", "task-1")
    assert task is not None
    assert len(task.get("events", [])) == 1
    assert bucket.objects[blob_name]["generation"] == "etag-1-next"


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
    assert "agora/users/user-1/tasks/task-1.json" in task_path.as_posix()
    task_path.parent.mkdir(parents=True, exist_ok=True)
    task_path.write_text("{malformed-json", encoding="utf-8")

    with pytest.raises(TaskStorePayloadError):
        await store.get_task("user-1", "task-1")


@pytest.mark.asyncio
async def test_local_store_get_task_reads_legacy_task_prefix(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "local-store-legacy-task"))
    legacy_path = store._legacy_task_path("user-1", "task-1")
    legacy_path.parent.mkdir(parents=True, exist_ok=True)
    legacy_path.write_text(json.dumps({"task_id": "task-1", "events": []}), encoding="utf-8")

    task = await store.get_task("user-1", "task-1")

    assert task is not None
    assert task["task_id"] == "task-1"


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


@pytest.mark.asyncio
async def test_local_store_append_events_persists_all_events_in_order(tmp_path: Path) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "local-store-append-many"))
    await store.save_task(
        "user-1",
        "task-1",
        {
            "task_id": "task-1",
            "workspace_id": "user-1",
            "events": [],
        },
    )

    await store.append_events(
        "user-1",
        "task-1",
        [
            {"event": "agent_output_delta", "data": {"chunk": "hello"}},
            {"event": "thinking_delta", "data": {"chunk": "reasoning"}},
        ],
    )

    task = await store.get_task("user-1", "task-1")
    assert task is not None
    events = task.get("events", [])
    assert [event["event"] for event in events] == ["agent_output_delta", "thinking_delta"]
    assert all(event["timestamp"] for event in events)


def test_resolve_storage_settings_uses_s3_bucket() -> None:
    settings = Settings(
        _env_file=None,
        ENVIRONMENT="production",
        STORAGE_BACKEND="s3",
        S3_BUCKET="agora-data",
    )

    backend, bucket = resolve_storage_settings(settings)

    assert backend == "s3"
    assert bucket == "agora-data"


def test_resolve_storage_settings_requires_bucket_in_production() -> None:
    settings = Settings(
        _env_file=None,
        ENVIRONMENT="production",
        STORAGE_BACKEND="s3",
        S3_BUCKET="",
    )

    with pytest.raises(RuntimeError, match="requires a bucket"):
        resolve_storage_settings(settings)


class _BackendClient:
    def __init__(self) -> None:
        self.bucket_calls: list[str] = []

    def bucket(self, name: str) -> _FakeBucket:
        self.bucket_calls.append(name)
        return _FakeBucket()


def test_task_store_selects_injected_s3_client() -> None:
    client = _BackendClient()

    store = TaskStore("agora-data", backend="s3", client=client)

    assert store.backend == "s3"
    assert store.bucket_name == "agora-data"
    assert store.client is client
    assert client.bucket_calls == ["agora-data"]


def test_get_store_uses_selected_backend() -> None:
    store = get_store("agora-data", backend="s3", region_name="us-east-1")

    # get_store creates a real S3 client; only assert the selected abstraction.
    assert isinstance(store, TaskStore)
    assert store.backend == "s3"
    assert store.bucket_name == "agora-data"
