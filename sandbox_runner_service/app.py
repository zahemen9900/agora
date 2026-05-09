"""Authenticated Docker sandbox runner service for Agora tool execution."""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, Header, HTTPException, status
from google.cloud import storage
from pydantic import BaseModel, ConfigDict, Field


class SandboxSourceRef(BaseModel):
    """Source metadata required to materialize execution inputs."""

    model_config = ConfigDict(extra="ignore")

    source_id: str
    kind: str
    display_name: str
    mime_type: str
    storage_uri: str
    size_bytes: int


class ExecuteRequest(BaseModel):
    """Execution request accepted by the sandbox runner."""

    code: str = Field(min_length=1)
    timeout_seconds: int = Field(default=20, ge=1, le=30)
    sources: list[SandboxSourceRef] = Field(default_factory=list)


class ExecuteResponse(BaseModel):
    """Normalized execution response returned to the broker."""

    exit_code: int
    stdout: str = ""
    stderr: str = ""
    summary: str
    artifacts: list[str] = Field(default_factory=list)
    latency_ms: float = 0.0


class _RunnerSettings(BaseModel):
    """Environment-backed runtime settings for the sandbox service."""

    bearer_token: str = Field(default_factory=lambda: os.getenv("AGORA_SANDBOX_RUNNER_BEARER_TOKEN", ""))
    docker_image: str = Field(default_factory=lambda: os.getenv("AGORA_SANDBOX_IMAGE", "python:3.11-slim"))
    work_root: str = Field(default_factory=lambda: os.getenv("AGORA_SANDBOX_ROOT", "/tmp/agora-sandbox"))
    cpu_limit: str = Field(default_factory=lambda: os.getenv("AGORA_SANDBOX_CPU_LIMIT", "0.5"))
    memory_limit: str = Field(default_factory=lambda: os.getenv("AGORA_SANDBOX_MEMORY_LIMIT", "512m"))
    pids_limit: int = Field(default_factory=lambda: int(os.getenv("AGORA_SANDBOX_PIDS_LIMIT", "128")))
    output_file_limit: int = Field(default_factory=lambda: int(os.getenv("AGORA_SANDBOX_OUTPUT_FILE_LIMIT", "20")))
    max_concurrent_runs: int = Field(default_factory=lambda: int(os.getenv("AGORA_SANDBOX_MAX_CONCURRENT_RUNS", "1")))
    google_cloud_project: str = Field(default_factory=lambda: os.getenv("GOOGLE_CLOUD_PROJECT", ""))


class _SandboxExecutor:
    """Materialize source inputs and execute Python inside Docker."""

    def __init__(self, settings: _RunnerSettings) -> None:
        self._settings = settings
        self._storage_client: storage.Client | None = None
        self._slots = asyncio.Semaphore(max(1, settings.max_concurrent_runs))

    async def execute(self, request: ExecuteRequest) -> ExecuteResponse:
        async with self._slots:
            started = time.perf_counter()
            base_dir = Path(
                tempfile.mkdtemp(prefix="run-", dir=self._settings.work_root)
            )
            input_dir = base_dir / "input"
            output_dir = base_dir / "output"
            input_dir.mkdir(parents=True, exist_ok=True)
            output_dir.mkdir(parents=True, exist_ok=True)
            program_path = base_dir / "program.py"
            program_path.write_text(request.code, encoding="utf-8")

            try:
                for source in request.sources:
                    await self._materialize_source(source=source, target_dir=input_dir)
                stdout, stderr, exit_code = await self._run_docker(
                    work_dir=base_dir,
                    input_dir=input_dir,
                    output_dir=output_dir,
                    timeout_seconds=request.timeout_seconds,
                )
                latency_ms = (time.perf_counter() - started) * 1000.0
                artifacts = self._collect_artifacts(output_dir)
                summary = (
                    "Executed Python sandbox task successfully"
                    if exit_code == 0
                    else f"Python sandbox execution failed with exit code {exit_code}"
                )
                return ExecuteResponse(
                    exit_code=exit_code,
                    stdout=stdout,
                    stderr=stderr,
                    summary=summary,
                    artifacts=artifacts,
                    latency_ms=latency_ms,
                )
            finally:
                shutil.rmtree(base_dir, ignore_errors=True)

    async def _materialize_source(
        self,
        *,
        source: SandboxSourceRef,
        target_dir: Path,
    ) -> None:
        target_name = self._target_filename(source.source_id, source.display_name)
        target_path = target_dir / target_name
        parsed = urlparse(source.storage_uri)
        if parsed.scheme == "gs":
            payload = await asyncio.to_thread(
                self._read_gcs_bytes,
                bucket_name=parsed.netloc,
                object_name=parsed.path.lstrip("/"),
            )
        elif parsed.scheme == "file":
            payload = await asyncio.to_thread(Path(parsed.path).read_bytes)
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported source URI scheme: {parsed.scheme}",
            )
        await asyncio.to_thread(target_path.write_bytes, payload)

    def _read_gcs_bytes(self, *, bucket_name: str, object_name: str) -> bytes:
        if self._storage_client is None:
            project = self._settings.google_cloud_project or None
            self._storage_client = storage.Client(project=project)
        bucket = self._storage_client.bucket(bucket_name)
        return bucket.blob(object_name).download_as_bytes()

    async def _run_docker(
        self,
        *,
        work_dir: Path,
        input_dir: Path,
        output_dir: Path,
        timeout_seconds: int,
    ) -> tuple[str, str, int]:
        container_name = f"agora-sandbox-{uuid.uuid4().hex[:12]}"
        command = [
            "docker",
            "run",
            "--rm",
            "--name",
            container_name,
            "--network",
            "none",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,size=64m",
            "--env",
            "HOME=/tmp/home",
            "--env",
            "XDG_CACHE_HOME=/tmp/.cache",
            "--env",
            "MPLCONFIGDIR=/tmp/matplotlib",
            "--cpus",
            self._settings.cpu_limit,
            "--memory",
            self._settings.memory_limit,
            "--pids-limit",
            str(self._settings.pids_limit),
            "-v",
            f"{work_dir}:/workspace:rw",
            "-v",
            f"{input_dir}:/workspace/input:ro",
            "-v",
            f"{output_dir}:/workspace/output:rw",
            "-w",
            "/workspace",
            self._settings.docker_image,
            "python",
            "/workspace/program.py",
        ]
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout_seconds,
            )
            return (
                stdout.decode("utf-8", errors="replace"),
                stderr.decode("utf-8", errors="replace"),
                int(process.returncode or 0),
            )
        except TimeoutError:
            process.kill()
            stdout, stderr = await process.communicate()
            stderr_text = stderr.decode("utf-8", errors="replace")
            if stderr_text:
                stderr_text = f"{stderr_text}\nExecution timed out."
            else:
                stderr_text = "Execution timed out."
            return (
                stdout.decode("utf-8", errors="replace"),
                stderr_text,
                124,
            )
        finally:
            await self._remove_container(container_name)

    async def _remove_container(self, container_name: str) -> None:
        process = await asyncio.create_subprocess_exec(
            "docker",
            "rm",
            "-f",
            container_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await process.communicate()

    def _collect_artifacts(self, output_dir: Path) -> list[str]:
        artifacts: list[str] = []
        for path in sorted(output_dir.rglob("*")):
            if not path.is_file():
                continue
            artifacts.append(str(path.relative_to(output_dir)))
            if len(artifacts) >= self._settings.output_file_limit:
                break
        return artifacts

    @staticmethod
    def _sanitize_filename(name: str) -> str:
        candidate = Path(name).name.strip() or "source"
        return "".join(char if char.isalnum() or char in {"-", "_", "."} else "_" for char in candidate)

    @classmethod
    def _target_filename(cls, source_id: str, display_name: str) -> str:
        source_slug = cls._sanitize_filename(source_id) or "source"
        name_slug = cls._sanitize_filename(display_name)
        return f"{source_slug}__{name_slug}"


_SETTINGS = _RunnerSettings()
_EXECUTOR = _SandboxExecutor(_SETTINGS)
app = FastAPI(title="Agora Sandbox Runner", version="0.1.0")


def _authorize(authorization: str | None = Header(default=None)) -> None:
    expected = _SETTINGS.bearer_token.strip()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Sandbox runner bearer token is not configured",
        )
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe for the sandbox runner."""

    return {"status": "ok"}


@app.post("/execute", response_model=ExecuteResponse)
async def execute(
    request: ExecuteRequest,
    _authorized: None = Depends(_authorize),
) -> ExecuteResponse:
    """Run Python code inside a constrained Docker container."""

    Path(_SETTINGS.work_root).mkdir(parents=True, exist_ok=True)
    return await _EXECUTOR.execute(request)
