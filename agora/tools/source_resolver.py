"""Resolve task-attached source references into bytes for broker backends."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse

from google.cloud import storage

from agora.config import get_config
from agora.tools.types import SourceRef


class SourceResolver:
    """Read source content from local files or GCS-backed storage URIs."""

    def __init__(self) -> None:
        self._config = get_config()
        self._storage_client: storage.Client | None = None

    async def read_bytes(self, source: SourceRef) -> bytes:
        """Read one source payload into memory."""

        if source.storage_uri is None:
            raise FileNotFoundError(f"Source {source.source_id} has no storage URI")
        parsed = urlparse(source.storage_uri)
        if parsed.scheme == "gs":
            return self._read_gcs_bytes(bucket_name=parsed.netloc, object_name=parsed.path.lstrip("/"))
        if parsed.scheme == "file":
            return Path(parsed.path).read_bytes()
        raise ValueError(f"Unsupported source URI scheme for {source.source_id}: {parsed.scheme}")

    def _read_gcs_bytes(self, *, bucket_name: str, object_name: str) -> bytes:
        if self._storage_client is None:
            project = self._config.google_cloud_project or None
            self._storage_client = storage.Client(project=project)
        bucket = self._storage_client.bucket(bucket_name)
        return bucket.blob(object_name).download_as_bytes()
