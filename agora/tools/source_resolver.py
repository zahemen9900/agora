"""Resolve task-attached source references into bytes for broker backends."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from agora.config import get_config
from agora.tools.types import SourceRef


class SourceResolver:
    """Read source content from local files or cloud object storage URIs."""

    def __init__(self) -> None:
        self._config = get_config()
        self._storage_client: Any | None = None
        self._s3_client: Any | None = None

    async def read_bytes(self, source: SourceRef) -> bytes:
        """Read one source payload into memory."""

        if source.storage_uri is None:
            raise FileNotFoundError(f"Source {source.source_id} has no storage URI")
        parsed = urlparse(source.storage_uri)
        if parsed.scheme == "gs":
            return self._read_gcs_bytes(
                bucket_name=parsed.netloc,
                object_name=parsed.path.lstrip("/"),
            )
        if parsed.scheme == "s3":
            return self._read_s3_bytes(
                bucket_name=parsed.netloc,
                object_name=parsed.path.lstrip("/"),
            )
        if parsed.scheme == "file":
            return Path(parsed.path).read_bytes()
        raise ValueError(f"Unsupported source URI scheme for {source.source_id}: {parsed.scheme}")

    def _read_gcs_bytes(self, *, bucket_name: str, object_name: str) -> bytes:
        if self._storage_client is None:
            from google.cloud import storage

            project = self._config.google_cloud_project or None
            self._storage_client = storage.Client(project=project)
        bucket = self._storage_client.bucket(bucket_name)
        return bucket.blob(object_name).download_as_bytes()

    def _read_s3_bytes(self, *, bucket_name: str, object_name: str) -> bytes:
        if self._s3_client is None:
            import boto3

            self._s3_client = boto3.client(
                "s3",
                region_name=os.getenv("AWS_REGION") or None,
            )
        response = self._s3_client.get_object(Bucket=bucket_name, Key=object_name)
        body = response["Body"]
        try:
            return body.read()
        finally:
            close = getattr(body, "close", None)
            if callable(close):
                close()
