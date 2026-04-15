"""Coordination backends for run leases and one-time stream tickets."""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

import structlog

from api.config import settings

logger = structlog.get_logger(__name__)


@dataclass(frozen=True)
class StreamTicketRecord:
    """Resolved stream ticket payload after one-time validation."""

    workspace_id: str
    task_id: str
    expires_at: datetime


class CoordinationBackend(Protocol):
    """Protocol for task-run and stream-ticket coordination primitives."""

    async def issue_stream_ticket(
        self,
        workspace_id: str,
        task_id: str,
        ttl_seconds: int,
    ) -> tuple[str, datetime]: ...

    async def consume_stream_ticket(
        self,
        ticket: str,
        *,
        task_id: str,
    ) -> StreamTicketRecord | None: ...

    async def acquire_run_lock(
        self,
        run_key: str,
        *,
        ttl_seconds: int,
    ) -> bool: ...

    async def claim_dedupe_key(
        self,
        key: str,
        *,
        ttl_seconds: int,
    ) -> bool: ...

    async def release_run_lock(self, run_key: str) -> None: ...

    async def reset_state(self) -> None: ...


class InMemoryCoordinationBackend:
    """Single-process coordination backend for local development and tests."""

    def __init__(self) -> None:
        self._stream_tickets: dict[str, StreamTicketRecord] = {}
        self._run_locks: dict[str, datetime] = {}
        self._dedupe_keys: dict[str, datetime] = {}

    def _purge_expired_stream_tickets(self) -> None:
        now = datetime.now(UTC)
        expired = [ticket for ticket, entry in self._stream_tickets.items() if entry.expires_at <= now]
        for ticket in expired:
            self._stream_tickets.pop(ticket, None)

    def _purge_expired_run_locks(self) -> None:
        now = datetime.now(UTC)
        expired = [run_key for run_key, expires_at in self._run_locks.items() if expires_at <= now]
        for run_key in expired:
            self._run_locks.pop(run_key, None)

    def _purge_expired_dedupe_keys(self) -> None:
        now = datetime.now(UTC)
        expired = [key for key, expires_at in self._dedupe_keys.items() if expires_at <= now]
        for key in expired:
            self._dedupe_keys.pop(key, None)

    async def issue_stream_ticket(
        self,
        workspace_id: str,
        task_id: str,
        ttl_seconds: int,
    ) -> tuple[str, datetime]:
        self._purge_expired_stream_tickets()
        expires_at = datetime.now(UTC) + timedelta(seconds=ttl_seconds)
        ticket = secrets.token_urlsafe(32)
        self._stream_tickets[ticket] = StreamTicketRecord(
            workspace_id=workspace_id,
            task_id=task_id,
            expires_at=expires_at,
        )
        return ticket, expires_at

    async def consume_stream_ticket(
        self,
        ticket: str,
        *,
        task_id: str,
    ) -> StreamTicketRecord | None:
        self._purge_expired_stream_tickets()
        entry = self._stream_tickets.pop(ticket, None)
        if entry is None:
            return None
        if entry.task_id != task_id or entry.expires_at <= datetime.now(UTC):
            return None
        return entry

    async def acquire_run_lock(
        self,
        run_key: str,
        *,
        ttl_seconds: int,
    ) -> bool:
        self._purge_expired_run_locks()
        if run_key in self._run_locks:
            return False
        self._run_locks[run_key] = datetime.now(UTC) + timedelta(seconds=ttl_seconds)
        return True

    async def release_run_lock(self, run_key: str) -> None:
        self._run_locks.pop(run_key, None)

    async def claim_dedupe_key(
        self,
        key: str,
        *,
        ttl_seconds: int,
    ) -> bool:
        self._purge_expired_dedupe_keys()
        if key in self._dedupe_keys:
            return False
        self._dedupe_keys[key] = datetime.now(UTC) + timedelta(seconds=ttl_seconds)
        return True

    async def reset_state(self) -> None:
        self._stream_tickets.clear()
        self._run_locks.clear()
        self._dedupe_keys.clear()


class RedisCoordinationBackend:
    """Redis-backed coordination backend for multi-instance deployments."""

    def __init__(self, redis_url: str, *, namespace: str) -> None:
        from redis.asyncio import Redis

        self._redis = Redis.from_url(redis_url, decode_responses=True)
        self._namespace = namespace

    def _ticket_key(self, ticket: str) -> str:
        return f"{self._namespace}:stream-ticket:{ticket}"

    def _run_lock_key(self, run_key: str) -> str:
        return f"{self._namespace}:run-lock:{run_key}"

    def _dedupe_key(self, key: str) -> str:
        return f"{self._namespace}:dedupe:{key}"

    async def issue_stream_ticket(
        self,
        workspace_id: str,
        task_id: str,
        ttl_seconds: int,
    ) -> tuple[str, datetime]:
        expires_at = datetime.now(UTC) + timedelta(seconds=ttl_seconds)
        payload = json.dumps(
            {
                "workspace_id": workspace_id,
                "task_id": task_id,
                "expires_at": expires_at.isoformat(),
            }
        )

        for _ in range(5):
            ticket = secrets.token_urlsafe(32)
            stored = await self._redis.set(
                self._ticket_key(ticket),
                payload,
                ex=ttl_seconds,
                nx=True,
            )
            if stored:
                return ticket, expires_at

        raise RuntimeError("Failed to allocate unique stream ticket")

    async def consume_stream_ticket(
        self,
        ticket: str,
        *,
        task_id: str,
    ) -> StreamTicketRecord | None:
        payload = await self._redis.getdel(self._ticket_key(ticket))
        if payload is None:
            return None

        try:
            parsed = json.loads(payload)
            entry = StreamTicketRecord(
                workspace_id=str(parsed["workspace_id"]),
                task_id=str(parsed["task_id"]),
                expires_at=datetime.fromisoformat(str(parsed["expires_at"])),
            )
        except Exception:
            logger.warning("coordination_stream_ticket_corrupt", ticket=ticket)
            return None

        if entry.task_id != task_id or entry.expires_at <= datetime.now(UTC):
            return None
        return entry

    async def acquire_run_lock(
        self,
        run_key: str,
        *,
        ttl_seconds: int,
    ) -> bool:
        stored = await self._redis.set(
            self._run_lock_key(run_key),
            datetime.now(UTC).isoformat(),
            ex=ttl_seconds,
            nx=True,
        )
        return bool(stored)

    async def release_run_lock(self, run_key: str) -> None:
        await self._redis.delete(self._run_lock_key(run_key))

    async def claim_dedupe_key(
        self,
        key: str,
        *,
        ttl_seconds: int,
    ) -> bool:
        stored = await self._redis.set(
            self._dedupe_key(key),
            "1",
            ex=ttl_seconds,
            nx=True,
        )
        return bool(stored)

    async def reset_state(self) -> None:
        keys: list[str] = []
        async for key in self._redis.scan_iter(match=f"{self._namespace}:*"):
            keys.append(key)
        if keys:
            await self._redis.delete(*keys)


_coordination_backend: CoordinationBackend | None = None


def _create_coordination_backend() -> CoordinationBackend:
    backend = settings.coordination_backend.strip().lower()
    if backend in {"", "memory", "in-memory", "local"}:
        return InMemoryCoordinationBackend()

    if backend == "redis":
        redis_url = settings.redis_url.strip()
        if not redis_url:
            raise RuntimeError(
                "AGORA_COORDINATION_BACKEND=redis requires AGORA_REDIS_URL or REDIS_URL"
            )
        return RedisCoordinationBackend(
            redis_url=redis_url,
            namespace=settings.coordination_namespace.strip() or "agora",
        )

    raise RuntimeError(
        "Unsupported coordination backend "
        f"{settings.coordination_backend!r}; expected 'memory' or 'redis'"
    )


def get_coordination_backend() -> CoordinationBackend:
    """Return lazily initialized coordination backend singleton."""

    global _coordination_backend
    if _coordination_backend is None:
        _coordination_backend = _create_coordination_backend()
    return _coordination_backend


def reset_coordination_backend_cache_for_tests() -> None:
    """Reset cached coordination backend instance for deterministic tests."""

    global _coordination_backend
    _coordination_backend = None


async def reset_coordination_state_for_tests() -> None:
    """Clear backend state (tickets + locks) while preserving backend type."""

    await get_coordination_backend().reset_state()
