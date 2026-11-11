from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest

from sandbox_runner_service import app as sandbox_app


@pytest.mark.asyncio
async def test_sandbox_runner_health() -> None:
    transport = httpx.ASGITransport(app=sandbox_app.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_sandbox_runner_execute_requires_bearer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sandbox_app._SETTINGS, "bearer_token", "test-token")
    transport = httpx.ASGITransport(app=sandbox_app.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/execute", json={"code": "print('hello')"})

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_sandbox_runner_execute_returns_executor_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sandbox_app._SETTINGS, "bearer_token", "test-token")

    async def fake_execute(request: sandbox_app.ExecuteRequest) -> sandbox_app.ExecuteResponse:
        assert request.code == "print('hello')"
        return sandbox_app.ExecuteResponse(
            exit_code=0,
            stdout="hello\n",
            stderr="",
            summary="Executed Python sandbox task successfully",
            artifacts=["output/result.txt"],
            latency_ms=12.5,
        )

    monkeypatch.setattr(sandbox_app._EXECUTOR, "execute", fake_execute)
    transport = httpx.ASGITransport(app=sandbox_app.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/execute",
            headers={"Authorization": "Bearer test-token"},
            json={"code": "print('hello')", "timeout_seconds": 5, "sources": []},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["exit_code"] == 0
    assert payload["stdout"] == "hello\n"
    assert payload["artifacts"] == ["output/result.txt"]


@pytest.mark.asyncio
async def test_sandbox_runner_materializes_s3_source(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    settings = sandbox_app._RunnerSettings(
        bearer_token="token",
        max_concurrent_runs=1,
        data_bucket="agora-data",
    )
    executor = sandbox_app._SandboxExecutor(settings)

    def fake_read_s3(*, bucket_name: str, object_name: str) -> bytes:
        assert bucket_name == "agora-data"
        assert object_name.endswith("original.txt")
        return b"hello"

    monkeypatch.setattr(executor, "_read_s3_bytes", fake_read_s3)
    source = sandbox_app.SandboxSourceRef(
        source_id="source-1",
        kind="text_file",
        display_name="notes.txt",
        mime_type="text/plain",
        storage_uri="s3://agora-data/agora/users/u/source-objects/source-1/original.txt",
        size_bytes=5,
    )
    target_dir = tmp_path / "input"
    target_dir.mkdir()

    await executor._materialize_source(source=source, target_dir=target_dir)

    target_file = target_dir / executor._target_filename("source-1", "notes.txt")
    assert target_file.read_bytes() == b"hello"


@pytest.mark.asyncio
async def test_sandbox_runner_rejects_file_sources_in_production(
    tmp_path: Path,
) -> None:
    settings = sandbox_app._RunnerSettings(
        bearer_token="token",
        max_concurrent_runs=1,
        allow_file_sources=False,
    )
    executor = sandbox_app._SandboxExecutor(settings)
    source = sandbox_app.SandboxSourceRef(
        source_id="source-1",
        kind="text_file",
        display_name="notes.txt",
        mime_type="text/plain",
        storage_uri="file:///etc/passwd",
        size_bytes=5,
    )

    with pytest.raises(Exception) as exc_info:
        await executor._materialize_source(source=source, target_dir=tmp_path)

    assert "file://" in str(exc_info.value)


def test_sandbox_runner_sanitizes_source_filenames() -> None:
    assert sandbox_app._SandboxExecutor._sanitize_filename("../weird name?.py") == "weird_name_.py"


def test_sandbox_runner_builds_deterministic_target_filenames() -> None:
    assert (
        sandbox_app._SandboxExecutor._target_filename("a1670b5ade3f", "vendor dataset.csv")
        == "a1670b5ade3f__vendor_dataset.csv"
    )


@pytest.mark.asyncio
async def test_sandbox_runner_force_removes_container_on_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = sandbox_app._RunnerSettings(bearer_token="token", max_concurrent_runs=1)
    executor = sandbox_app._SandboxExecutor(settings)
    calls: list[tuple[str, ...]] = []

    class _RunProcess:
        returncode: int | None = None

        def __init__(self) -> None:
            self._killed = False
            self._communicate_calls = 0

        async def communicate(self) -> tuple[bytes, bytes]:
            self._communicate_calls += 1
            if self._killed:
                self.returncode = -9
                return b"", b""
            await asyncio.sleep(60)
            self.returncode = 0
            return b"", b""

        def kill(self) -> None:
            self._killed = True

    class _CleanupProcess:
        returncode = 0

        async def communicate(self) -> tuple[bytes, bytes]:
            return b"", b""

    async def fake_create_subprocess_exec(*command: str, **_: object) -> object:
        calls.append(tuple(command))
        if command[:3] == ("docker", "rm", "-f"):
            return _CleanupProcess()
        if command[:2] == ("docker", "run"):
            return _RunProcess()
        raise AssertionError(f"Unexpected subprocess command: {command}")

    monkeypatch.setattr(sandbox_app.asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    stdout, stderr, exit_code = await executor._run_docker(
        work_dir=sandbox_app.Path("/tmp/work"),
        input_dir=sandbox_app.Path("/tmp/work/input"),
        output_dir=sandbox_app.Path("/tmp/work/output"),
        timeout_seconds=0.01,
    )

    assert stdout == ""
    assert "Execution timed out." in stderr
    assert exit_code == 124
    run_call = next(command for command in calls if command[:2] == ("docker", "run"))
    container_name = run_call[run_call.index("--name") + 1]
    assert any(command[:3] == ("docker", "rm", "-f") and command[3] == container_name for command in calls)
