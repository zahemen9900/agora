"""HTTP client for the external Docker sandbox runner service."""

from __future__ import annotations

import httpx

from api.config import settings as api_settings
from agora.tools.types import SourceRef, ToolResult


class SandboxRunnerError(RuntimeError):
    """Raised when sandbox execution cannot be completed."""


class SandboxRunnerClient:
    """Thin authenticated client for the e2-small sandbox runner."""

    def __init__(self, *, http_client: httpx.AsyncClient | None = None) -> None:
        self._base_url = api_settings.sandbox_runner_url.rstrip("/")
        self._token = api_settings.sandbox_runner_bearer_token
        self._http = http_client or httpx.AsyncClient(timeout=45.0)
        self._owns_http_client = http_client is None
        if not self._base_url:
            raise SandboxRunnerError("Sandbox runner URL is not configured")
        if not self._token:
            raise SandboxRunnerError("Sandbox runner bearer token is not configured")

    async def aclose(self) -> None:
        if self._owns_http_client:
            await self._http.aclose()

    async def execute_python(
        self,
        *,
        code: str,
        sources: list[SourceRef],
        timeout_seconds: int,
    ) -> ToolResult:
        response = await self._http.post(
            f"{self._base_url}/execute",
            headers={"Authorization": f"Bearer {self._token}"},
            json={
                "code": code,
                "timeout_seconds": timeout_seconds,
                "sources": [source.model_dump(mode="json") for source in sources],
            },
        )
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict):
            raise SandboxRunnerError("Sandbox runner returned a non-object response")
        return ToolResult(
            tool_name="execute_python",
            status="success" if int(body.get("exit_code", 1)) == 0 else "failed",
            request={"timeout_seconds": timeout_seconds},
            summary=str(body.get("summary") or "Executed Python sandbox task"),
            sources=sources,
            stdout=str(body.get("stdout") or "") or None,
            stderr=str(body.get("stderr") or "") or None,
            exit_code=int(body.get("exit_code", 1)),
            artifacts=[
                str(item)
                for item in body.get("artifacts", [])
                if isinstance(item, str)
            ],
            raw_metadata={
                "runner_latency_ms": body.get("latency_ms"),
            },
        )
