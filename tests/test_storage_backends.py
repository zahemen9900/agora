"""Tests for the S3 storage adapter and GCS-compatible blob semantics."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from botocore.exceptions import ClientError
from google.api_core import exceptions as gcs_exceptions

from api.storage_backends import S3StorageClient


class _FakeBody:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self.closed = False

    def read(self) -> bytes:
        return self._payload

    def close(self) -> None:
        self.closed = True


class _FakeS3Client:
    """Small S3 double that exercises only the adapter's used operations."""

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], dict[str, Any]] = {}
        self.put_calls: list[dict[str, Any]] = []
        self.signed_calls: list[dict[str, Any]] = []
        self._etag_counter = 0
        self.page_size = 2

    def seed(
        self,
        bucket: str,
        key: str,
        payload: bytes,
        *,
        etag: str | None = None,
        updated: datetime | None = None,
        content_type: str = "application/octet-stream",
    ) -> None:
        self._etag_counter += 1
        self.objects[(bucket, key)] = {
            "body": payload,
            "etag": etag or f'"etag-{self._etag_counter}"',
            "updated": updated or datetime.now(UTC),
            "content_type": content_type,
        }

    @staticmethod
    def _error(code: str, status: int, operation: str) -> ClientError:
        return ClientError(
            {
                "Error": {"Code": code, "Message": code},
                "ResponseMetadata": {"HTTPStatusCode": status},
            },
            operation,
        )

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        record = self.objects.get((Bucket, Key))
        if record is None:
            raise self._error("NoSuchKey", 404, "GetObject")
        return {
            "Body": _FakeBody(record["body"]),
            "ETag": record["etag"],
            "LastModified": record["updated"],
            "ContentLength": len(record["body"]),
            "ContentType": record["content_type"],
        }

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        record = self.objects.get((Bucket, Key))
        if record is None:
            raise self._error("404", 404, "HeadObject")
        return {
            "ETag": record["etag"],
            "LastModified": record["updated"],
            "ContentLength": len(record["body"]),
            "ContentType": record["content_type"],
        }

    def put_object(self, **kwargs: Any) -> dict[str, Any]:
        self.put_calls.append(dict(kwargs))
        key = (kwargs["Bucket"], kwargs["Key"])
        record = self.objects.get(key)

        if kwargs.get("IfNoneMatch") == "*" and record is not None:
            raise self._error("PreconditionFailed", 412, "PutObject")
        if "IfMatch" in kwargs:
            if record is None or record["etag"] != kwargs["IfMatch"]:
                raise self._error("PreconditionFailed", 412, "PutObject")

        self._etag_counter += 1
        etag = f'"etag-{self._etag_counter}"'
        self.objects[key] = {
            "body": kwargs["Body"],
            "etag": etag,
            "updated": datetime.now(UTC),
            "content_type": kwargs.get("ContentType", "application/octet-stream"),
        }
        return {"ETag": etag}

    def delete_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        self.objects.pop((Bucket, Key), None)
        return {}

    def list_objects_v2(self, **kwargs: Any) -> dict[str, Any]:
        prefix = kwargs.get("Prefix", "")
        bucket = kwargs["Bucket"]
        names = sorted(
            key
            for (object_bucket, key) in self.objects
            if object_bucket == bucket and key.startswith(prefix)
        )
        start = 0
        token = kwargs.get("ContinuationToken")
        if token is not None:
            start = int(token)
        page = names[start : start + self.page_size]
        next_index = start + len(page)
        response: dict[str, Any] = {
            "Contents": [
                {
                    "Key": name,
                    "ETag": self.objects[(bucket, name)]["etag"],
                    "LastModified": self.objects[(bucket, name)]["updated"],
                }
                for name in page
            ],
            "IsTruncated": next_index < len(names),
        }
        if next_index < len(names):
            response["NextContinuationToken"] = str(next_index)
        return response

    def generate_presigned_url(
        self,
        client_method: str,
        *,
        Params: dict[str, Any],  # noqa: N803
        ExpiresIn: int,  # noqa: N803
    ) -> str:
        self.signed_calls.append(
            {
                "client_method": client_method,
                "Params": dict(Params),
                "ExpiresIn": ExpiresIn,
            }
        )
        return f"https://s3.example/{Params['Bucket']}/{Params['Key']}?expires={ExpiresIn}"


def _client(fake: _FakeS3Client) -> S3StorageClient:
    return S3StorageClient(client=fake)


def test_s3_blob_download_captures_etag_from_the_same_get() -> None:
    fake = _FakeS3Client()
    updated = datetime(2026, 1, 1, tzinfo=UTC)
    fake.seed(
        "agora-data", "path/to/object.json", b'{"ok": true}', etag='"etag-read"', updated=updated
    )
    blob = _client(fake).bucket("agora-data").blob("path/to/object.json")

    assert blob.download_as_text() == '{"ok": true}'
    assert blob.generation == "etag-read"
    assert blob.updated == updated


def test_s3_blob_missing_key_maps_to_not_found_and_exists_is_false() -> None:
    fake = _FakeS3Client()
    blob = _client(fake).bucket("agora-data").blob("missing.json")

    with pytest.raises(gcs_exceptions.NotFound):
        blob.download_as_text()
    assert blob.exists() is False
    with pytest.raises(gcs_exceptions.NotFound):
        blob.reload()


def test_s3_blob_create_only_upload_uses_if_none_match() -> None:
    fake = _FakeS3Client()
    blob = _client(fake).bucket("agora-data").blob("new.json")

    blob.upload_from_string('{"ok": true}', content_type="application/json", if_generation_match=0)

    assert fake.put_calls[0]["IfNoneMatch"] == "*"
    with pytest.raises(gcs_exceptions.PreconditionFailed):
        blob.upload_from_string("{}", content_type="application/json", if_generation_match=0)


def test_s3_blob_opaque_etag_is_used_for_if_match() -> None:
    fake = _FakeS3Client()
    fake.seed("agora-data", "task.json", b'{"events": []}', etag='"etag-current"')
    blob = _client(fake).bucket("agora-data").blob("task.json")
    blob.download_as_text()

    blob.upload_from_string(
        '{"events": [1]}',
        content_type="application/json",
        if_generation_match=blob.generation,
    )

    assert fake.put_calls[0]["IfMatch"] == '"etag-current"'


def test_s3_blob_rejects_nonzero_integer_generation() -> None:
    fake = _FakeS3Client()
    blob = _client(fake).bucket("agora-data").blob("task.json")

    with pytest.raises(ValueError, match="integer generation"):
        blob.upload_from_string("{}", content_type="application/json", if_generation_match=5)


def test_s3_blob_stale_etag_raises_precondition_failed() -> None:
    fake = _FakeS3Client()
    fake.seed("agora-data", "task.json", b"{}", etag='"etag-current"')
    blob = _client(fake).bucket("agora-data").blob("task.json")

    with pytest.raises(gcs_exceptions.PreconditionFailed):
        blob.upload_from_string(
            "{}", content_type="application/json", if_generation_match="etag-stale"
        )


def test_s3_bucket_list_blobs_paginates() -> None:
    fake = _FakeS3Client()
    for index in range(5):
        fake.seed("agora-data", f"agora/tasks/{index}.json", b"{}")

    names = [
        blob.name for blob in _client(fake).bucket("agora-data").list_blobs(prefix="agora/tasks/")
    ]

    assert names == [f"agora/tasks/{index}.json" for index in range(5)]


def test_s3_blob_presigned_put_includes_exact_headers_and_expiry() -> None:
    fake = _FakeS3Client()
    blob = _client(fake).bucket("agora-data").blob("source-objects/source.pdf")
    expiration = datetime.now(UTC) + timedelta(minutes=15)

    url = blob.generate_signed_url(
        version="v4",
        expiration=expiration,
        method="PUT",
        content_type="application/pdf",
        content_length=1234,
        if_none_match=True,
    )

    assert url.startswith("https://s3.example/agora-data/source-objects/source.pdf")
    call = fake.signed_calls[0]
    assert call["client_method"] == "put_object"
    assert call["Params"] == {
        "Bucket": "agora-data",
        "Key": "source-objects/source.pdf",
        "ContentType": "application/pdf",
        "ContentLength": 1234,
        "IfNoneMatch": "*",
    }
    assert 890 <= call["ExpiresIn"] <= 900


def test_s3_blob_delete_removes_object() -> None:
    fake = _FakeS3Client()
    fake.seed("agora-data", "remove.json", b"{}")
    blob = _client(fake).bucket("agora-data").blob("remove.json")

    blob.delete()

    assert blob.exists() is False
