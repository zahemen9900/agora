"""Source upload and retrieval helpers for task-attached files."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import mimetypes
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from google.api_core import exceptions as gcs_exceptions

from api.config import settings
from api.models import (
    SourceUploadInitResponse,
    TaskSourceKindName,
    TaskSourceRecord,
    TaskSourceResponse,
)
from api.security import validate_storage_id
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
        if isinstance(task_store, TaskStore):
            self._backend = task_store.backend
            self._bucket_name = task_store.bucket_name
            self._storage_client = task_store.client
        else:
            self._backend = "local"
            self._bucket_name = ""
            self._storage_client = None

    def supports_cloud_storage(self) -> bool:
        return self._storage_client is not None and bool(self._bucket_name)

    def supports_signed_uploads(self) -> bool:
        return self.supports_cloud_storage()

    def _scheme(self) -> str:
        return "s3" if self._backend == "s3" else "gs"

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
        if self.supports_cloud_storage():
            storage_uri = (
                f"{self._scheme()}://{self._bucket_name}/"
                f"{_source_object_name(workspace_id, source_id, display_name, mime_type)}"
            )
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

    def _blob_for(self, source: TaskSourceRecord) -> Any:
        if not self.supports_cloud_storage():
            raise RuntimeError("Cloud source storage is not configured")
        parsed = urlparse(source.storage_uri)
        if parsed.scheme != self._scheme() or parsed.netloc != self._bucket_name:
            raise ValueError(
                f"Source URI does not belong to the configured storage bucket: {source.source_id}"
            )
        actual_key = parsed.path.lstrip("/")
        expected_prefix = (
            f"agora/users/{validate_storage_id(source.workspace_id, field_name='workspace_id')}"
            f"/source-objects/{validate_storage_id(source.source_id, field_name='source_id')}/"
        )
        if not actual_key.startswith(expected_prefix):
            raise ValueError(
                f"Source URI does not match its workspace/source record: {source.source_id}"
            )
        return self._storage_client.bucket(self._bucket_name).blob(actual_key)

    async def create_upload_session(
        self,
        *,
        workspace_id: str,
        source: TaskSourceRecord,
    ) -> SourceUploadInitResponse:
        await self.task_store.save_source(
            workspace_id,
            source.source_id,
            source.model_dump(mode="json"),
        )
        expires_at = datetime.now(UTC) + timedelta(minutes=settings.source_upload_expiry_minutes)
        if self.supports_signed_uploads():
            try:
                blob = self._blob_for(source)
                if self._backend == "s3":
                    upload_url = blob.generate_signed_url(
                        version="v4",
                        expiration=expires_at,
                        method="PUT",
                        content_type=source.mime_type,
                        content_length=source.size_bytes,
                        if_none_match=True,
                    )
                else:
                    upload_url = blob.generate_signed_url(
                        version="v4",
                        expiration=expires_at,
                        method="PUT",
                        content_type=source.mime_type,
                    )
            except Exception as exc:
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
            headers = {"Content-Type": source.mime_type}
            if self._backend == "s3":
                headers["If-None-Match"] = "*"
            return SourceUploadInitResponse(
                source=TaskSourceResponse.model_validate(source.model_dump(mode="json")),
                upload_url=upload_url,
                upload_headers=headers,
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
        try:
            payload = await self.read_source_bytes(source)
        except gcs_exceptions.NotFound as exc:
            raise FileNotFoundError(
                f"Uploaded source object not found for {source.source_id}"
            ) from exc
        except FileNotFoundError:
            raise
        actual_digest = hashlib.sha256(payload).hexdigest()
        if sha256 and sha256.strip().lower() != actual_digest:
            raise ValueError("Uploaded source checksum does not match the declared sha256")
        if len(payload) != source.size_bytes:
            raise ValueError(
                f"Uploaded source size {len(payload)} does not match "
                f"declared size {source.size_bytes}"
            )
        if self.supports_cloud_storage():
            blob = self._blob_for(source)
            try:
                await asyncio.to_thread(blob.reload)
            except gcs_exceptions.NotFound as exc:
                raise FileNotFoundError(
                    f"Uploaded source object not found for {source.source_id}"
                ) from exc
            actual_type = getattr(blob, "content_type", None)
            if actual_type:
                normalized_actual = actual_type.split(";")[0].strip().lower()
                normalized_expected = source.mime_type.split(";")[0].strip().lower()
                if normalized_actual != normalized_expected:
                    raise ValueError(
                        f"Uploaded source content type {actual_type!r} "
                        f"does not match {source.mime_type!r}"
                    )
        updated = source.model_copy(
            update={
                "sha256": sha256 or actual_digest,
                "status": "ready",
            }
        )
        await self.task_store.save_source(
            workspace_id,
            source.source_id,
            updated.model_dump(mode="json"),
        )
        return updated

    async def object_exists(self, source: TaskSourceRecord) -> bool:
        if self.supports_cloud_storage():
            return await asyncio.to_thread(self._blob_for(source).exists)
        return self._local_source_path(source).is_file()

    async def write_upload_bytes(
        self,
        *,
        source: TaskSourceRecord,
        data: bytes,
    ) -> str:
        if len(data) > source.size_bytes or len(data) > settings.source_max_file_bytes:
            raise ValueError("Uploaded source exceeds the declared or configured size limit")
        digest = hashlib.sha256(data).hexdigest()
        if self.supports_cloud_storage():
            blob = self._blob_for(source)
            try:
                await asyncio.to_thread(
                    blob.upload_from_string,
                    data,
                    content_type=source.mime_type,
                    if_generation_match=0,
                )
            except gcs_exceptions.PreconditionFailed:
                existing = await asyncio.to_thread(blob.download_as_bytes)
                if existing != data:
                    raise ValueError(
                        "Source object already exists with different bytes"
                    ) from None
        else:
            local_store = self._require_local_store()
            path = self._local_source_path(source)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            await local_store.save_source(
                source.workspace_id,
                source.source_id,
                source.model_dump(mode="json"),
            )
        updated = source.model_copy(update={"sha256": digest, "status": "uploaded"})
        await self.task_store.save_source(
            source.workspace_id,
            source.source_id,
            updated.model_dump(mode="json"),
        )
        return digest

    async def read_source_bytes(self, source: TaskSourceRecord) -> bytes:
        if self.supports_cloud_storage():
            return await asyncio.to_thread(self._blob_for(source).download_as_bytes)
        return self._local_source_path(source).read_bytes()

    def _local_source_path(self, source: TaskSourceRecord) -> Path:
        local_store = self._require_local_store()
        parsed = urlparse(source.storage_uri)
        if parsed.scheme != "file":
            raise ValueError(f"Unsupported local source URI scheme: {parsed.scheme}")
        path = Path(parsed.path).resolve()
        if not path.is_relative_to(local_store.root):
            raise ValueError("Source URI escapes the configured local data directory")
        return path

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
