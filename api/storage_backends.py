"""Storage client adapter for S3 with the subset of GCS semantics used by TaskStore."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

from botocore.exceptions import ClientError
from google.api_core import exceptions as gcs_exceptions


def _error_details(exc: ClientError) -> tuple[str, int]:
    error = exc.response.get("Error") or {}
    metadata = exc.response.get("ResponseMetadata") or {}
    code = str(error.get("Code") or "")
    status = int(metadata.get("HTTPStatusCode") or 0)
    return code, status


def _is_not_found(exc: ClientError) -> bool:
    code, status = _error_details(exc)
    return status == 404 or code in {"404", "NoSuchKey", "NotFound"}


def _is_precondition_failed(exc: ClientError) -> bool:
    code, status = _error_details(exc)
    return status in {409, 412} or code in {
        "409",
        "412",
        "ConditionalRequestConflict",
        "PreconditionFailed",
    }


def _normalize_etag(value: Any) -> str | None:
    if value is None:
        return None
    token = str(value).strip()
    if token.startswith("W/"):
        token = token[2:]
    if len(token) >= 2 and token.startswith('"') and token.endswith('"'):
        token = token[1:-1]
    return token or None


def _quote_etag(value: str) -> str:
    token = value.strip()
    if token.startswith("W/"):
        token = token[2:]
    if len(token) >= 2 and token.startswith('"') and token.endswith('"'):
        return token
    return f'"{token}"'


class S3StorageClient:
    """S3 client that exposes the GCS-shaped ``bucket``/``blob`` surface."""

    def __init__(self, *, client: Any | None = None, region_name: str | None = None) -> None:
        if client is None:
            import boto3
            from botocore.config import Config

            client = boto3.client(
                "s3",
                region_name=region_name,
                config=Config(signature_version="s3v4"),
            )
        self._client = client

    def bucket(self, name: str) -> S3Bucket:
        return S3Bucket(self._client, name)


class S3Bucket:
    def __init__(self, client: Any, name: str) -> None:
        self._client = client
        self.name = name

    def blob(self, name: str) -> S3Blob:
        return S3Blob(self._client, self.name, name)

    def list_blobs(self, prefix: str = "") -> Iterator[S3Blob]:
        continuation_token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"Bucket": self.name, "Prefix": prefix}
            if continuation_token:
                kwargs["ContinuationToken"] = continuation_token
            response = self._client.list_objects_v2(**kwargs)
            for item in response.get("Contents", []) or []:
                yield S3Blob(
                    self._client,
                    self.name,
                    str(item["Key"]),
                    generation=_normalize_etag(item.get("ETag")),
                    updated=item.get("LastModified"),
                )
            if not response.get("IsTruncated"):
                return
            continuation_token = response.get("NextContinuationToken")
            if not continuation_token:
                return


class S3Blob:
    """A single S3 object with GCS-compatible read/write/CAS behavior."""

    def __init__(
        self,
        client: Any,
        bucket_name: str,
        name: str,
        *,
        generation: str | None = None,
        updated: datetime | None = None,
    ) -> None:
        self._client = client
        self._bucket_name = bucket_name
        self.name = name
        self._generation = generation
        self._updated = updated
        self._size: int | None = None
        self._content_type: str | None = None

    @property
    def generation(self) -> str | None:
        return self._generation

    @property
    def updated(self) -> datetime | None:
        return self._updated

    @property
    def size(self) -> int | None:
        return self._size

    @property
    def content_type(self) -> str | None:
        return self._content_type

    def _record_metadata(self, response: dict[str, Any]) -> None:
        self._generation = _normalize_etag(response.get("ETag")) or self._generation
        updated = response.get("LastModified")
        if isinstance(updated, datetime):
            self._updated = updated
        size = response.get("ContentLength")
        if isinstance(size, int):
            self._size = size
        content_type = response.get("ContentType")
        if isinstance(content_type, str):
            self._content_type = content_type

    def _download(self) -> bytes:
        try:
            response = self._client.get_object(Bucket=self._bucket_name, Key=self.name)
        except ClientError as exc:
            if _is_not_found(exc):
                raise gcs_exceptions.NotFound(f"blob missing: {self.name}") from exc
            raise

        body = response.get("Body")
        try:
            payload = body.read() if body is not None else b""
        finally:
            close = getattr(body, "close", None)
            if callable(close):
                close()
        self._record_metadata(response)
        return payload

    def download_as_bytes(self) -> bytes:
        return self._download()

    def download_as_text(self) -> str:
        return self._download().decode("utf-8")

    def reload(self) -> None:
        try:
            response = self._client.head_object(Bucket=self._bucket_name, Key=self.name)
        except ClientError as exc:
            if _is_not_found(exc):
                raise gcs_exceptions.NotFound(f"blob missing: {self.name}") from exc
            raise
        self._record_metadata(response)

    def exists(self) -> bool:
        try:
            self._client.head_object(Bucket=self._bucket_name, Key=self.name)
            return True
        except ClientError as exc:
            if _is_not_found(exc):
                return False
            raise

    def upload_from_string(
        self,
        payload: str | bytes,
        content_type: str,
        if_generation_match: int | str | None = None,
    ) -> None:
        body = payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)
        kwargs: dict[str, Any] = {
            "Bucket": self._bucket_name,
            "Key": self.name,
            "Body": body,
            "ContentType": content_type,
        }
        conditional = if_generation_match is not None
        if isinstance(if_generation_match, int):
            if if_generation_match != 0:
                raise ValueError(
                    "S3 backend supports only integer generation 0 (create-only) "
                    "or an opaque ETag token"
                )
            kwargs["IfNoneMatch"] = "*"
        elif isinstance(if_generation_match, str):
            if not if_generation_match.strip():
                raise ValueError("S3 generation token must not be empty")
            kwargs["IfMatch"] = _quote_etag(if_generation_match)
        elif if_generation_match is not None:
            raise TypeError("if_generation_match must be int, str, or None")

        try:
            response = self._client.put_object(**kwargs)
        except ClientError as exc:
            if _is_precondition_failed(exc):
                raise gcs_exceptions.PreconditionFailed(
                    f"conditional write failed: {self.name}"
                ) from exc
            if conditional and _is_not_found(exc):
                # A conditional write to a disappeared object is a CAS conflict; the
                # caller retries from a fresh read and surfaces NotFound on that read.
                raise gcs_exceptions.PreconditionFailed(
                    f"conditional write target disappeared: {self.name}"
                ) from exc
            if _is_not_found(exc):
                raise gcs_exceptions.NotFound(f"blob missing: {self.name}") from exc
            raise

        self._record_metadata(response)
        self._size = len(body)
        self._content_type = content_type
        if self._updated is None:
            self._updated = datetime.now(UTC)

    def delete(self) -> None:
        try:
            self._client.delete_object(Bucket=self._bucket_name, Key=self.name)
        except ClientError as exc:
            if _is_not_found(exc):
                raise gcs_exceptions.NotFound(f"blob missing: {self.name}") from exc
            raise

    def generate_signed_url(
        self,
        *,
        version: str | None = None,
        expiration: datetime | timedelta | None = None,
        method: str = "GET",
        content_type: str | None = None,
        content_length: int | None = None,
        if_none_match: bool | str | None = None,
        **kwargs: Any,
    ) -> str:
        del version, kwargs
        if expiration is None:
            expires_in = 900
        elif isinstance(expiration, timedelta):
            expires_in = int(expiration.total_seconds())
        else:
            expires_in = int((expiration - datetime.now(UTC)).total_seconds())
        expires_in = max(1, min(expires_in, 604800))

        params: dict[str, Any] = {"Bucket": self._bucket_name, "Key": self.name}
        if content_type:
            params["ContentType"] = content_type
        if content_length is not None:
            params["ContentLength"] = int(content_length)
        if if_none_match is True:
            params["IfNoneMatch"] = "*"
        elif isinstance(if_none_match, str) and if_none_match:
            params["IfNoneMatch"] = if_none_match

        method_upper = method.upper()
        if method_upper == "PUT":
            client_method = "put_object"
        elif method_upper == "GET":
            client_method = "get_object"
        else:
            raise ValueError(f"Unsupported S3 signed URL method: {method}")

        return self._client.generate_presigned_url(
            client_method,
            Params=params,
            ExpiresIn=expires_in,
        )
