"""S3-backed source upload, read, and completion tests."""

from __future__ import annotations

import hashlib

import pytest

from api.source_storage import SourceStorageService
from api.storage_backends import S3StorageClient
from api.store import TaskStore
from tests.test_storage_backends import _FakeS3Client


def _service() -> tuple[SourceStorageService, _FakeS3Client]:
    fake = _FakeS3Client()
    store = TaskStore(
        "agora-data",
        backend="s3",
        client=S3StorageClient(client=fake),
    )
    return SourceStorageService(task_store=store), fake


def test_s3_source_record_uses_s3_scheme_and_signed_upload_headers() -> None:
    storage, _ = _service()

    source = storage.build_source_record(
        workspace_id="user-1",
        created_by="user-1",
        source_id="source-1",
        display_name="notes.py",
        mime_type="text/x-python",
        size_bytes=14,
    )

    assert source.storage_uri == (
        "s3://agora-data/agora/users/user-1/source-objects/source-1/original.py"
    )
    assert storage.supports_signed_uploads() is True


@pytest.mark.asyncio
async def test_s3_source_signed_session_includes_create_only_headers() -> None:
    storage, fake = _service()
    source = storage.build_source_record(
        workspace_id="user-1",
        created_by="user-1",
        source_id="source-1",
        display_name="notes.py",
        mime_type="text/x-python",
        size_bytes=14,
    )

    session = await storage.create_upload_session(workspace_id="user-1", source=source)

    assert session.upload_url.startswith("https://s3.example/agora-data/")
    assert session.upload_headers == {
        "Content-Type": "text/x-python",
        "If-None-Match": "*",
    }
    call = fake.signed_calls[0]
    assert call["Params"]["ContentLength"] == 14
    assert call["Params"]["IfNoneMatch"] == "*"
    assert call["Params"]["ContentType"] == "text/x-python"


@pytest.mark.asyncio
async def test_s3_source_round_trip_completion() -> None:
    storage, fake = _service()
    payload = b"print('hello')\n"
    source = storage.build_source_record(
        workspace_id="user-1",
        created_by="user-1",
        source_id="source-1",
        display_name="notes.py",
        mime_type="text/x-python",
        size_bytes=len(payload),
    )

    digest = await storage.write_upload_bytes(source=source, data=payload)
    completed = await storage.mark_upload_complete(
        workspace_id="user-1",
        source=source,
        sha256=digest,
    )

    assert digest == hashlib.sha256(payload).hexdigest()
    assert completed.status == "ready"
    assert completed.sha256 == digest
    assert fake.put_calls[0]["IfNoneMatch"] == "*"
    assert await storage.read_source_bytes(source) == payload


@pytest.mark.asyncio
async def test_s3_source_rejects_wrong_bucket_uri() -> None:
    storage, _ = _service()
    source = storage.build_source_record(
        workspace_id="user-1",
        created_by="user-1",
        source_id="source-1",
        display_name="notes.py",
        mime_type="text/x-python",
        size_bytes=14,
    )
    source = source.model_copy(update={"storage_uri": "s3://other-bucket/whatever"})

    with pytest.raises(ValueError, match="configured storage bucket"):
        await storage.read_source_bytes(source)


@pytest.mark.asyncio
async def test_s3_source_completion_rejects_size_mismatch() -> None:
    storage, _ = _service()
    source = storage.build_source_record(
        workspace_id="user-1",
        created_by="user-1",
        source_id="source-1",
        display_name="notes.py",
        mime_type="text/x-python",
        size_bytes=14,
    )
    await storage.write_upload_bytes(source=source, data=b"short")

    with pytest.raises(ValueError, match="size"):
        await storage.mark_upload_complete(workspace_id="user-1", source=source, sha256=None)


@pytest.mark.asyncio
async def test_s3_source_duplicate_upload_rejects_different_bytes() -> None:
    storage, _ = _service()
    source = storage.build_source_record(
        workspace_id="user-1",
        created_by="user-1",
        source_id="source-1",
        display_name="notes.py",
        mime_type="text/x-python",
        size_bytes=5,
    )
    await storage.write_upload_bytes(source=source, data=b"first")

    with pytest.raises(ValueError, match="different bytes"):
        await storage.write_upload_bytes(source=source, data=b"other")


@pytest.mark.asyncio
async def test_s3_source_completion_maps_missing_object_to_file_not_found() -> None:
    storage, _ = _service()
    source = storage.build_source_record(
        workspace_id="user-1",
        created_by="user-1",
        source_id="source-1",
        display_name="notes.py",
        mime_type="text/x-python",
        size_bytes=14,
    )

    with pytest.raises(FileNotFoundError):
        await storage.mark_upload_complete(workspace_id="user-1", source=source, sha256=None)
