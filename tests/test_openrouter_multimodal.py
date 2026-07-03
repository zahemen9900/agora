from __future__ import annotations

import base64

import httpx
import pytest

from agora.config import AgoraConfig
from agora.tools.openrouter_multimodal import OpenRouterMultimodalClient
from agora.tools.types import SourceRef


def _client_with_transport(handler):
    return OpenRouterMultimodalClient(
        config=AgoraConfig(
            openrouter_api_key="or-key",
            openrouter_base_url="https://openrouter.test/api/v1",
        ),
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url="https://openrouter.test/api/v1",
        )
    )


@pytest.mark.asyncio
async def test_pdf_upload_analysis_uses_default_openrouter_file_handling() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["json"] = request.read().decode("utf-8")
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "The PDF says: Hello from uploaded PDF",
                        }
                    }
                ]
            },
        )

    client = _client_with_transport(handler)
    pdf_bytes = b"%PDF-1.4 fake"
    source = SourceRef(
        source_id="pdf-1",
        kind="pdf",
        display_name="upload.pdf",
        mime_type="application/pdf",
        size_bytes=len(pdf_bytes),
    )

    try:
        result = await client.analyze_file(
            question="What does this PDF say?",
            source=source,
            source_bytes=pdf_bytes,
        )
    finally:
        await client.aclose()

    assert result.status == "success"
    assert result.raw_text == "The PDF says: Hello from uploaded PDF"
    payload = captured["json"]
    assert isinstance(payload, str)
    assert '"plugins"' not in payload
    assert '"type":"file"' in payload
    expected_data_prefix = (
        "data:application/pdf;base64,"
        + base64.b64encode(pdf_bytes).decode("ascii")
    )
    assert expected_data_prefix in payload


@pytest.mark.asyncio
async def test_pdf_url_analysis_uses_source_url_without_plugins() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["json"] = request.read().decode("utf-8")
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "The PDF contains Dummy PDF file",
                        }
                    }
                ]
            },
        )

    client = _client_with_transport(handler)
    source = SourceRef(
        source_id="pdf-url",
        kind="pdf",
        display_name="dummy.pdf",
        mime_type="application/pdf",
        source_url="https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
        size_bytes=0,
    )

    try:
        result = await client.analyze_file(
            question="What does this PDF say?",
            source=source,
        )
    finally:
        await client.aclose()

    assert result.status == "success"
    assert "Dummy PDF file" in (result.raw_text or "")
    payload = captured["json"]
    assert isinstance(payload, str)
    assert '"plugins"' not in payload
    assert "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf" in payload
