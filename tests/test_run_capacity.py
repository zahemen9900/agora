"""Tests for host-wide execution admission."""

from __future__ import annotations

import pytest

from api import run_capacity
from api.coordination import InMemoryCoordinationBackend


@pytest.mark.asyncio
async def test_host_capacity_limits_active_runs_across_workspaces(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = InMemoryCoordinationBackend()
    monkeypatch.setattr(run_capacity, "get_coordination_backend", lambda: backend)
    monkeypatch.setattr(run_capacity.settings, "host_concurrent_runs", 2)
    monkeypatch.setattr(run_capacity.settings, "task_run_lock_ttl_seconds", 60)
    capacity = run_capacity.HostedRunCapacity()

    first = await capacity.acquire(run_key="workspace-a:task-1", lease_id="lease-a")
    second = await capacity.acquire(run_key="workspace-b:task-1", lease_id="lease-b")
    third = await capacity.acquire(run_key="workspace-c:task-1", lease_id="lease-c")

    assert first is not None
    assert second is not None
    assert third is None

    assert await capacity.release(run_key="workspace-a:task-1", lease_id="lease-a")
    replacement = await capacity.acquire(run_key="workspace-c:task-1", lease_id="lease-c")
    assert replacement is not None


@pytest.mark.asyncio
async def test_host_capacity_force_release_and_disabled_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = InMemoryCoordinationBackend()
    monkeypatch.setattr(run_capacity, "get_coordination_backend", lambda: backend)
    monkeypatch.setattr(run_capacity.settings, "host_concurrent_runs", 1)
    monkeypatch.setattr(run_capacity.settings, "task_run_lock_ttl_seconds", 60)
    capacity = run_capacity.HostedRunCapacity()

    assert await capacity.acquire(run_key="workspace-a:task-1", lease_id="lease-a") is not None
    assert await capacity.force_release(run_key="workspace-a:task-1")
    assert await capacity.acquire(run_key="workspace-b:task-1", lease_id="lease-b") is not None

    monkeypatch.setattr(run_capacity.settings, "host_concurrent_runs", 0)
    assert await capacity.acquire(run_key="workspace-c:task-1", lease_id="lease-c") is None
