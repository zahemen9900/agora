from __future__ import annotations

import asyncio

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
