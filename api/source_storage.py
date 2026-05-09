"""Source upload and retrieval helpers for task-attached files."""

from __future__ import annotations

import hashlib
import logging
import mimetypes
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from google.cloud import storage

from api.config import settings
from api.models import (
    SourceUploadInitResponse,
    TaskSourceKindName,
    TaskSourceRecord,
    TaskSourceResponse,
)
from api.security import safe_child_path, validate_storage_id
from api.store import TaskStore
from api.store_local import LocalTaskStore

_CODE_EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml"}
_TEXT_EXTENSIONS = {".md", ".txt", ".csv", ".tsv"}
_SUPPORTED_EXTENSIONS = _CODE_EXTENSIONS | _TEXT_EXTENSIONS | {
    ".xlsx",
    ".xls",
    ".xlsb",
    ".parquet",
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
}
_IMAGE_MIME_PREFIX = "image/"
_PDF_MIME = "application/pdf"
_LOGGER = logging.getLogger(__name__)


def infer_source_kind(*, filename: str, mime_type: str) -> TaskSourceKindName:
    """Infer the normalized task source kind for one uploaded file."""

    suffix = Path(filename).suffix.lower()
    normalized_mime = mime_type.strip().lower()
    if normalized_mime == _PDF_MIME or suffix == ".pdf":
        return "pdf"
    if normalized_mime.startswith(_IMAGE_MIME_PREFIX) or suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        return "image"
    if suffix in _CODE_EXTENSIONS:
        return "code_file"
    return "text_file"


def normalize_source_url(value: str) -> str:
    """Validate and normalize one public source URL."""

    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"Invalid source URL: {value!r}")
    return parsed.geturl()


def build_source_content_path(source_id: str) -> str:
    """Build the durable API-relative content path for one uploaded source."""

    return f"/api/sources/{validate_storage_id(source_id, field_name='source_id')}/content"


def is_supported_source_file(*, filename: str, mime_type: str) -> bool:
    """Return whether one uploaded file is supported by the v1 source pipeline."""

    suffix = Path(filename).suffix.lower()
    normalized_mime = mime_type.strip().lower()
    if suffix in _SUPPORTED_EXTENSIONS:
        return True
    if normalized_mime == _PDF_MIME or normalized_mime.startswith(_IMAGE_MIME_PREFIX):
        return True
    if normalized_mime.startswith("text/"):
        return True
    if normalized_mime in {
        "application/json",
        "application/x-yaml",
        "text/x-python",
        "application/javascript",
        "text/javascript",
        "application/typescript",
        "text/markdown",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
        "application/vnd.ms-excel.sheet.binary.macroenabled.12",
        "application/vnd.apache.parquet",
    }:
        return True
    return False


def _source_object_filename(display_name: str, mime_type: str) -> str:
    suffix = Path(display_name).suffix
    if suffix:
        return f"original{suffix.lower()}"
    guessed = mimetypes.guess_extension(mime_type.strip().lower()) or ""
    return f"original{guessed.lower()}"


def _source_object_name(workspace_id: str, source_id: str, display_name: str, mime_type: str) -> str:
    filename = _source_object_filename(display_name, mime_type)
    return TaskStore._source_object_name(workspace_id, source_id, filename)


def _source_local_object_path(
    store: LocalTaskStore,
    workspace_id: str,
    source_id: str,
    display_name: str,
    mime_type: str,
) -> Path:
    filename = _source_object_filename(display_name, mime_type)
    return store._source_object_path(workspace_id, source_id, filename)


class SourceStorageService:
    """Create upload sessions and read/write task-attached source objects."""

    def __init__(
        self,
        *,
        task_store: TaskStore | LocalTaskStore,
        api_base_path: str = "/sources",
    ) -> None:
        self.task_store = task_store
        self.api_base_path = api_base_path.rstrip("/")
        self._bucket_name = settings.gcs_bucket.strip()
        self._project_id = settings.google_cloud_project.strip()
        self._storage_client: storage.Client | None = None
        if isinstance(task_store, TaskStore) and self._bucket_name and self._project_id:
            self._storage_client = task_store.client

    def supports_signed_uploads(self) -> bool:
        return self._storage_client is not None

    def _build_api_upload_response(
        self,
        *,
        source: TaskSourceRecord,
        expires_at: datetime,
    ) -> SourceUploadInitResponse:
        return SourceUploadInitResponse(
            source=TaskSourceResponse.model_validate(source.model_dump(mode="json")),
            upload_url=f"{self.api_base_path}/{source.source_id}/upload-bytes",
            upload_headers={"Content-Type": source.mime_type},
            expires_at=expires_at,
        )

    def build_source_record(
        self,
        *,
        workspace_id: str,
        created_by: str,
        source_id: str,
        display_name: str,
        mime_type: str,
        size_bytes: int,
    ) -> TaskSourceRecord:
        kind = infer_source_kind(filename=display_name, mime_type=mime_type)
        if self.supports_signed_uploads():
            storage_uri = f"gs://{self._bucket_name}/{_source_object_name(workspace_id, source_id, display_name, mime_type)}"
        else:
            local_store = self._require_local_store()
            storage_uri = _source_local_object_path(
                local_store,
                workspace_id,
                source_id,
                display_name,
                mime_type,
            ).as_uri()
        return TaskSourceRecord(
            source_id=source_id,
            workspace_id=workspace_id,
            created_by=created_by,
            kind=kind,
            display_name=display_name,
            mime_type=mime_type,
            size_bytes=size_bytes,
            sha256=None,
            status="pending_upload",
            created_at=datetime.now(UTC),
            source_url=build_source_content_path(source_id),
            storage_uri=storage_uri,
        )

    async def create_upload_session(
        self,
        *,
        workspace_id: str,
        source: TaskSourceRecord,
    ) -> SourceUploadInitResponse:
        await self.task_store.save_source(workspace_id, source.source_id, source.model_dump(mode="json"))
        expires_at = datetime.now(UTC) + timedelta(minutes=settings.source_upload_expiry_minutes)
        if self.supports_signed_uploads():
            assert self._storage_client is not None
            bucket = self._storage_client.bucket(self._bucket_name)
            parsed = urlparse(source.storage_uri)
            object_name = parsed.path.lstrip("/")
            blob = bucket.blob(object_name)
            try:
                upload_url = blob.generate_signed_url(
                    version="v4",
                    expiration=expires_at,
                    method="PUT",
                    content_type=source.mime_type,
                )
            except AttributeError as exc:
                _LOGGER.warning(
                    "source_signed_upload_unavailable_falling_back_to_api_upload",
                    extra={
                        "workspace_id": workspace_id,
                        "source_id": source.source_id,
                        "bucket": self._bucket_name,
                        "error": str(exc),
                    },
                )
                return self._build_api_upload_response(source=source, expires_at=expires_at)
            return SourceUploadInitResponse(
                source=TaskSourceResponse.model_validate(source.model_dump(mode="json")),
                upload_url=upload_url,
                upload_headers={"Content-Type": source.mime_type},
                expires_at=expires_at,
            )
        return self._build_api_upload_response(source=source, expires_at=expires_at)

    async def mark_upload_complete(
        self,
        *,
        workspace_id: str,
        source: TaskSourceRecord,
        sha256: str | None,
    ) -> TaskSourceRecord:
        exists = await self.object_exists(source)
        if not exists:
            raise FileNotFoundError(f"Uploaded source object not found for {source.source_id}")
        updated = source.model_copy(
            update={
                "sha256": sha256 or source.sha256,
                "status": "ready",
            }
        )
        await self.task_store.save_source(workspace_id, source.source_id, updated.model_dump(mode="json"))
        return updated

    async def object_exists(self, source: TaskSourceRecord) -> bool:
        if self.supports_signed_uploads():
            assert self._storage_client is not None
            bucket = self._storage_client.bucket(self._bucket_name)
            parsed = urlparse(source.storage_uri)
            return bucket.blob(parsed.path.lstrip("/")).exists()
        path = Path(urlparse(source.storage_uri).path)
        return path.is_file()

    async def write_upload_bytes(
        self,
        *,
        source: TaskSourceRecord,
        data: bytes,
    ) -> str:
        digest = hashlib.sha256(data).hexdigest()
        if self.supports_signed_uploads():
            assert self._storage_client is not None
            bucket = self._storage_client.bucket(self._bucket_name)
            parsed = urlparse(source.storage_uri)
            bucket.blob(parsed.path.lstrip("/")).upload_from_string(
                data,
                content_type=source.mime_type,
            )
        else:
            local_store = self._require_local_store()
            path = Path(urlparse(source.storage_uri).path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            await local_store.save_source(
                source.workspace_id,
                source.source_id,
                source.model_dump(mode="json"),
            )
        updated = source.model_copy(update={"sha256": digest, "status": "uploaded"})
        await self.task_store.save_source(source.workspace_id, source.source_id, updated.model_dump(mode="json"))
        return digest

    async def read_source_bytes(self, source: TaskSourceRecord) -> bytes:
        if self.supports_signed_uploads():
            assert self._storage_client is not None
            bucket = self._storage_client.bucket(self._bucket_name)
            parsed = urlparse(source.storage_uri)
            return bucket.blob(parsed.path.lstrip("/")).download_as_bytes()
        path = Path(urlparse(source.storage_uri).path)
        return path.read_bytes()

    def _require_local_store(self) -> LocalTaskStore:
        if not isinstance(self.task_store, LocalTaskStore):
            raise RuntimeError("Local source upload is unavailable for the configured task store.")
        return self.task_store


def build_source_id(
    *,
    workspace_id: str,
    display_name: str,
    mime_type: str,
    size_bytes: int,
) -> str:
    """Build a stable opaque identifier for one source registry record."""

    payload = (
        f"{validate_storage_id(workspace_id, field_name='workspace_id')}\n"
        f"{display_name}\n{mime_type}\n{size_bytes}\n{datetime.now(UTC).isoformat()}"
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
