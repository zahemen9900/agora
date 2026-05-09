from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from api import auth
from api.auth import AuthenticatedUser
from api.main import app
from api.routes import sources as source_routes
from api.source_storage import SourceStorageService
from api.store_local import LocalTaskStore


def _override_user() -> AuthenticatedUser:
    return AuthenticatedUser(
        workspace_id="user-1",
        user_id="user-1",
        email="user@example.com",
        display_name="User One",
        scopes=["tasks:read", "tasks:write"],
    )


@pytest.mark.asyncio
async def test_source_upload_flow_local_store(tmp_path: Path) -> None:
    source_routes._store = LocalTaskStore(data_dir=str(tmp_path / "sources"))
    app.dependency_overrides[auth.get_current_user] = _override_user
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            init_response = await client.post(
                "/sources/upload-init",
                json={
                    "filename": "notes.py",
                    "mime_type": "text/x-python",
                    "size_bytes": 14,
                },
            )
            assert init_response.status_code == 200
            init_payload = init_response.json()
            source_id = init_payload["source"]["source_id"]
            upload_path = init_payload["upload_url"]
            assert upload_path.endswith("/upload-bytes")

            bytes_response = await client.put(
                upload_path,
                content=b"print('hello')\n",
                headers={"Content-Type": "text/x-python"},
            )
            assert bytes_response.status_code == 200
            sha256 = bytes_response.json()["sha256"]

            complete_response = await client.post(
                f"/sources/{source_id}/upload-complete",
                json={"sha256": sha256},
            )
            assert complete_response.status_code == 200
            assert complete_response.json()["status"] == "ready"

            fetch_response = await client.get(f"/sources/{source_id}")
            assert fetch_response.status_code == 200
            payload = fetch_response.json()
            assert payload["source_id"] == source_id
            assert payload["kind"] == "code_file"
            assert payload["sha256"] == sha256
            assert payload["source_url"] == f"/api/sources/{source_id}/content"

            content_response = await client.get(payload["source_url"])
            assert content_response.status_code == 200
            assert content_response.content == b"print('hello')\n"
            assert content_response.headers["content-type"].startswith("text/x-python")
    finally:
        app.dependency_overrides.clear()
        source_routes._store = None


@pytest.mark.asyncio
async def test_source_upload_init_rejects_files_over_five_megabytes(tmp_path: Path) -> None:
    source_routes._store = LocalTaskStore(data_dir=str(tmp_path / "sources"))
    app.dependency_overrides[auth.get_current_user] = _override_user
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/sources/upload-init",
                json={
                    "filename": "big.pdf",
                    "mime_type": "application/pdf",
                    "size_bytes": 5 * 1024 * 1024 + 1,
                },
            )
            assert response.status_code == 422
    finally:
        app.dependency_overrides.clear()
        source_routes._store = None


@pytest.mark.asyncio
async def test_source_upload_init_accepts_spreadsheet_and_parquet_extensions(tmp_path: Path) -> None:
    source_routes._store = LocalTaskStore(data_dir=str(tmp_path / "sources"))
    app.dependency_overrides[auth.get_current_user] = _override_user
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            spreadsheet = await client.post(
                "/sources/upload-init",
                json={
                    "filename": "vendors.xlsx",
                    "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "size_bytes": 1024,
                },
            )
            parquet = await client.post(
                "/sources/upload-init",
                json={
                    "filename": "vendors.parquet",
                    "mime_type": "application/vnd.apache.parquet",
                    "size_bytes": 2048,
                },
            )
            assert spreadsheet.status_code == 200
            assert parquet.status_code == 200
            assert spreadsheet.json()["source"]["kind"] == "text_file"
            assert parquet.json()["source"]["kind"] == "text_file"
    finally:
        app.dependency_overrides.clear()
        source_routes._store = None


class _FakeBlob:
    def __init__(self) -> None:
        self.uploaded: bytes | None = None
        self.content_type: str | None = None

    def generate_signed_url(self, **_: object) -> str:
        raise AttributeError("signing unavailable")

    def upload_from_string(self, data: bytes, *, content_type: str) -> None:
        self.uploaded = data
        self.content_type = content_type

    def exists(self) -> bool:
        return self.uploaded is not None


class _FakeBucket:
    def __init__(self, blob: _FakeBlob) -> None:
        self._blob = blob

    def blob(self, _: str) -> _FakeBlob:
        return self._blob


class _FakeStorageClient:
    def __init__(self, blob: _FakeBlob) -> None:
        self._bucket = _FakeBucket(blob)

    def bucket(self, _: str) -> _FakeBucket:
        return self._bucket


@pytest.mark.asyncio
async def test_source_upload_session_falls_back_to_api_upload_when_signing_is_unavailable(
    tmp_path: Path,
) -> None:
    store = LocalTaskStore(data_dir=str(tmp_path / "sources"))
    storage = SourceStorageService(task_store=store)
    blob = _FakeBlob()
    storage._storage_client = _FakeStorageClient(blob)  # type: ignore[assignment]
    storage._bucket_name = "agora-data"

    source = storage.build_source_record(
        workspace_id="user-1",
        created_by="user-1",
        source_id="source-1",
        display_name="notes.py",
        mime_type="text/x-python",
        size_bytes=14,
    )

    session = await storage.create_upload_session(workspace_id="user-1", source=source)

    assert session.upload_url == "/sources/source-1/upload-bytes"
    digest = await storage.write_upload_bytes(source=source, data=b"print('hello')\n")
    assert len(digest) == 64
    assert blob.uploaded == b"print('hello')\n"
    assert blob.content_type == "text/x-python"
