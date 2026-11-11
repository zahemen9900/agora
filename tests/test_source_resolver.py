"""Tests for the source resolver's cloud object storage support."""

from __future__ import annotations

import pytest

from agora.tools.source_resolver import SourceResolver
from agora.tools.types import SourceRef


class _Body:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self.closed = False

    def read(self) -> bytes:
        return self._payload

    def close(self) -> None:
        self.closed = True


class _S3Client:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.calls: list[dict[str, str]] = []

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, object]:  # noqa: N803
        self.calls.append({"bucket": Bucket, "key": Key})
        return {"Body": _Body(self.payload)}


@pytest.mark.asyncio
async def test_source_resolver_reads_s3_uri() -> None:
    resolver = SourceResolver()
    client = _S3Client(b"source-bytes")
    resolver._s3_client = client

    payload = await resolver.read_bytes(
        SourceRef(
            source_id="source-1",
            kind="text_file",
            display_name="notes.txt",
            mime_type="text/plain",
            storage_uri="s3://agora-data/agora/users/u/source-objects/source-1/original.txt",
            size_bytes=12,
        )
    )

    assert payload == b"source-bytes"
    assert client.calls == [
        {
            "bucket": "agora-data",
            "key": "agora/users/u/source-objects/source-1/original.txt",
        }
    ]


@pytest.mark.asyncio
async def test_source_resolver_rejects_unknown_scheme() -> None:
    resolver = SourceResolver()

    with pytest.raises(ValueError, match="Unsupported source URI scheme"):
        await resolver.read_bytes(
            SourceRef(
                source_id="source-1",
                kind="text_file",
                display_name="notes.txt",
                mime_type="text/plain",
                storage_uri="ftp://example.com/notes.txt",
                size_bytes=12,
            )
        )
