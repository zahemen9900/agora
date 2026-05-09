"""OpenRouter-backed multimodal analysis helpers for PDFs and images."""

from __future__ import annotations

import base64
from pathlib import Path
from urllib.parse import urlparse

import httpx

from agora.config import AgoraConfig, get_config
from agora.tools.types import CitationItem, SourceRef, ToolResult


class OpenRouterMultimodalError(RuntimeError):
    """Raised when OpenRouter multimodal analysis fails."""


class OpenRouterMultimodalClient:
    """Dedicated low-cost multimodal analysis path for PDFs and images."""

    def __init__(
        self,
        *,
        config: AgoraConfig | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._config = config or get_config()
        self._http = http_client or httpx.AsyncClient(
            base_url=self._config.openrouter_base_url.rstrip("/"),
            timeout=60.0,
            headers=self._default_headers(),
        )
        self._owns_http_client = http_client is None
        if not self._config.openrouter_api_key:
            raise OpenRouterMultimodalError("OpenRouter multimodal analysis requires OPENROUTER_API_KEY")

    async def aclose(self) -> None:
        if self._owns_http_client:
            await self._http.aclose()

    async def analyze_file(
        self,
        *,
        question: str,
        source: SourceRef,
        source_bytes: bytes | None = None,
    ) -> ToolResult:
        if source.kind not in {"pdf", "image"}:
            raise OpenRouterMultimodalError(
                f"OpenRouter multimodal client does not support source kind {source.kind}"
            )
        payload = {
            "model": self._config.openrouter_analysis_model,
            "messages": [
                {
                    "role": "user",
                    "content": self._build_content(
                        question=question,
                        source=source,
                        source_bytes=source_bytes,
                    ),
                }
            ],
            "stream": False,
        }
        if source.kind == "pdf":
            payload["plugins"] = [{"id": "file-parser", "pdf": {"engine": "cloudflare-ai"}}]
        response = await self._http.post(
            "/chat/completions",
            json=payload,
            headers={"Authorization": f"Bearer {self._config.openrouter_api_key}"},
        )
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict):
            raise OpenRouterMultimodalError("OpenRouter returned a non-object response")
        content = self._extract_message_text(body)
        parsed = urlparse(source.source_url) if source.source_url else None
        citation = CitationItem(
            title=source.display_name,
            url=source.source_url,
            domain=(parsed.netloc if parsed else None),
            source_kind=source.kind,
            source_id=source.source_id,
        )
        return ToolResult(
            tool_name="analyze_file",
            status="success",
            request={"question": question, "source_id": source.source_id},
            summary=f"Analyzed {source.kind.replace('_', ' ')} source {source.display_name}",
            citations=[citation],
            sources=[source],
            raw_text=content,
            raw_metadata={"model": self._config.openrouter_analysis_model},
        )

    def _build_content(
        self,
        *,
        question: str,
        source: SourceRef,
        source_bytes: bytes | None,
    ) -> list[dict[str, object]]:
        content: list[dict[str, object]] = [{"type": "text", "text": question}]
        if source.kind == "image":
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": self._resolve_content_url(source=source, source_bytes=source_bytes),
                    },
                }
            )
            return content

        content.append(
            {
                "type": "file",
                "file": {
                    "filename": Path(source.display_name).name or "document.pdf",
                    "file_data": self._resolve_content_url(source=source, source_bytes=source_bytes),
                },
            }
        )
        return content

    def _resolve_content_url(self, *, source: SourceRef, source_bytes: bytes | None) -> str:
        if source.source_url:
            return source.source_url
        if source_bytes is None:
            raise OpenRouterMultimodalError(
                f"Source {source.source_id} requires bytes because it is not publicly addressable"
            )
        encoded = base64.b64encode(source_bytes).decode("ascii")
        return f"data:{source.mime_type};base64,{encoded}"

    @staticmethod
    def _extract_message_text(body: dict[str, object]) -> str:
        choices = body.get("choices")
        if not isinstance(choices, list) or not choices:
            raise OpenRouterMultimodalError("OpenRouter response did not include choices")
        first = choices[0]
        if not isinstance(first, dict):
            raise OpenRouterMultimodalError("OpenRouter first choice was not an object")
        message = first.get("message")
        if not isinstance(message, dict):
            raise OpenRouterMultimodalError("OpenRouter choice did not include a message object")
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            return "\n".join(parts)
        raise OpenRouterMultimodalError("OpenRouter message content was not text")

    def _default_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._config.openrouter_http_referer:
            headers["HTTP-Referer"] = self._config.openrouter_http_referer
        if self._config.openrouter_app_title:
            headers["X-Title"] = self._config.openrouter_app_title
        return headers
