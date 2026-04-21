"""Coordination backends for run leases, abuse controls, and stream tickets."""

from __future__ import annotations

import json
import math
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol, cast

import structlog

from api.config import settings

logger = structlog.get_logger(__name__)


@dataclass(frozen=True)
class StreamTicketRecord:
    """Resolved stream ticket payload after one-time validation."""

    workspace_id: str
    task_id: str
    expires_at: datetime


@dataclass(frozen=True)
class RunLockLease:
    """Owned lease for a task execution lock."""

    run_key: str
    lease_id: str
    expires_at: datetime


@dataclass(frozen=True)
class ConcurrencySlotLease:
    """Owned lease for a workspace-level concurrent execution slot."""

    bucket_key: str
    holder_key: str
    lease_id: str
    expires_at: datetime


@dataclass(frozen=True)
class RateLimitState:
    """Fixed-window rate-limit state after recording a hit."""

    key: str
    count: int
    limit: int
    retry_after_seconds: int


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
    ) -> RunLockLease | None: ...

    async def refresh_run_lock(
        self,
        run_key: str,
        *,
        lease_id: str,
        ttl_seconds: int,
    ) -> RunLockLease | None: ...

    async def claim_dedupe_key(
        self,
        key: str,
        *,
        ttl_seconds: int,
    ) -> bool: ...

    async def hit_rate_limit(
        self,
        key: str,
        *,
        limit: int,
        window_seconds: int,
    ) -> RateLimitState: ...

    async def acquire_concurrency_slot(
        self,
        bucket_key: str,
        *,
        holder_key: str,
        lease_id: str,
        limit: int,
        ttl_seconds: int,
    ) -> ConcurrencySlotLease | None: ...

    async def refresh_concurrency_slot(
        self,
        bucket_key: str,
        *,
        holder_key: str,
        lease_id: str,
        ttl_seconds: int,
    ) -> ConcurrencySlotLease | None: ...

    async def release_concurrency_slot(
        self,
        bucket_key: str,
        *,
        holder_key: str,
        lease_id: str,
    ) -> bool: ...

    async def release_run_lock(self, run_key: str, *, lease_id: str) -> bool: ...

    async def reset_state(self) -> None: ...


class InMemoryCoordinationBackend:
    """Single-process coordination backend for local development and tests."""

    def __init__(self) -> None:
        self._stream_tickets: dict[str, StreamTicketRecord] = {}
        self._run_locks: dict[str, RunLockLease] = {}
        self._dedupe_keys: dict[str, datetime] = {}
        self._rate_limits: dict[str, tuple[int, datetime]] = {}
        self._concurrency_slots: dict[str, dict[str, ConcurrencySlotLease]] = {}

    def _purge_expired_stream_tickets(self) -> None:
        now = datetime.now(UTC)
        expired = [
            ticket for ticket, entry in self._stream_tickets.items() if entry.expires_at <= now
        ]
        for ticket in expired:
            self._stream_tickets.pop(ticket, None)

    def _purge_expired_run_locks(self) -> None:
        now = datetime.now(UTC)
        expired = [
            run_key
            for run_key, lease in self._run_locks.items()
            if lease.expires_at <= now
        ]
        for run_key in expired:
            self._run_locks.pop(run_key, None)

    def _purge_expired_dedupe_keys(self) -> None:
        now = datetime.now(UTC)
        expired = [key for key, expires_at in self._dedupe_keys.items() if expires_at <= now]
        for key in expired:
            self._dedupe_keys.pop(key, None)

    def _purge_expired_rate_limits(self) -> None:
        now = datetime.now(UTC)
        expired = [key for key, (_count, reset_at) in self._rate_limits.items() if reset_at <= now]
        for key in expired:
            self._rate_limits.pop(key, None)

    def _purge_expired_concurrency_slots(self) -> None:
        now = datetime.now(UTC)
        empty_buckets: list[str] = []
        for bucket_key, holders in self._concurrency_slots.items():
            expired = [
                holder_key
                for holder_key, lease in holders.items()
                if lease.expires_at <= now
            ]
            for holder_key in expired:
                holders.pop(holder_key, None)
            if not holders:
                empty_buckets.append(bucket_key)
        for bucket_key in empty_buckets:
            self._concurrency_slots.pop(bucket_key, None)

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
    ) -> RunLockLease | None:
        self._purge_expired_run_locks()
        if run_key in self._run_locks:
            return None
        lease = RunLockLease(
            run_key=run_key,
            lease_id=secrets.token_urlsafe(24),
            expires_at=datetime.now(UTC) + timedelta(seconds=ttl_seconds),
        )
        self._run_locks[run_key] = lease
        return lease

    async def refresh_run_lock(
        self,
        run_key: str,
        *,
        lease_id: str,
        ttl_seconds: int,
    ) -> RunLockLease | None:
        self._purge_expired_run_locks()
        current = self._run_locks.get(run_key)
        if current is None or current.lease_id != lease_id:
            return None
        refreshed = RunLockLease(
            run_key=run_key,
            lease_id=lease_id,
            expires_at=datetime.now(UTC) + timedelta(seconds=ttl_seconds),
        )
        self._run_locks[run_key] = refreshed
        return refreshed

    async def release_run_lock(self, run_key: str, *, lease_id: str) -> bool:
        current = self._run_locks.get(run_key)
        if current is None or current.lease_id != lease_id:
            return False
        self._run_locks.pop(run_key, None)
        return True

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

    async def hit_rate_limit(
        self,
        key: str,
        *,
        limit: int,
        window_seconds: int,
    ) -> RateLimitState:
        self._purge_expired_rate_limits()
        now = datetime.now(UTC)
        count, reset_at = self._rate_limits.get(
            key,
            (0, now + timedelta(seconds=window_seconds)),
        )
        count += 1
        self._rate_limits[key] = (count, reset_at)
        retry_after = max(1, math.ceil((reset_at - now).total_seconds()))
        return RateLimitState(
            key=key,
            count=count,
            limit=limit,
            retry_after_seconds=retry_after,
        )

    async def acquire_concurrency_slot(
        self,
        bucket_key: str,
        *,
        holder_key: str,
        lease_id: str,
        limit: int,
        ttl_seconds: int,
    ) -> ConcurrencySlotLease | None:
        self._purge_expired_concurrency_slots()
        holders = self._concurrency_slots.setdefault(bucket_key, {})
        current = holders.get(holder_key)
        if current is not None:
            if current.lease_id != lease_id:
                return None
            refreshed = ConcurrencySlotLease(
                bucket_key=bucket_key,
                holder_key=holder_key,
                lease_id=lease_id,
                expires_at=datetime.now(UTC) + timedelta(seconds=ttl_seconds),
            )
            holders[holder_key] = refreshed
            return refreshed
        if len(holders) >= limit:
            return None
        lease = ConcurrencySlotLease(
            bucket_key=bucket_key,
            holder_key=holder_key,
            lease_id=lease_id,
            expires_at=datetime.now(UTC) + timedelta(seconds=ttl_seconds),
        )
        holders[holder_key] = lease
        return lease

    async def refresh_concurrency_slot(
        self,
        bucket_key: str,
        *,
        holder_key: str,
        lease_id: str,
        ttl_seconds: int,
    ) -> ConcurrencySlotLease | None:
        self._purge_expired_concurrency_slots()
        holders = self._concurrency_slots.get(bucket_key)
        if holders is None:
            return None
        current = holders.get(holder_key)
        if current is None or current.lease_id != lease_id:
            return None
        refreshed = ConcurrencySlotLease(
            bucket_key=bucket_key,
            holder_key=holder_key,
            lease_id=lease_id,
            expires_at=datetime.now(UTC) + timedelta(seconds=ttl_seconds),
        )
        holders[holder_key] = refreshed
        return refreshed

    async def release_concurrency_slot(
        self,
        bucket_key: str,
        *,
        holder_key: str,
        lease_id: str,
    ) -> bool:
        holders = self._concurrency_slots.get(bucket_key)
        if holders is None:
            return False
        current = holders.get(holder_key)
        if current is None or current.lease_id != lease_id:
            return False
        holders.pop(holder_key, None)
        if not holders:
            self._concurrency_slots.pop(bucket_key, None)
        return True

    async def reset_state(self) -> None:
        self._stream_tickets.clear()
        self._run_locks.clear()
        self._dedupe_keys.clear()
        self._rate_limits.clear()
        self._concurrency_slots.clear()


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

    def _rate_limit_key(self, key: str) -> str:
        return f"{self._namespace}:rate-limit:{key}"

    def _concurrency_bucket_key(self, bucket_key: str) -> str:
        return f"{self._namespace}:concurrency:{bucket_key}"

    def _concurrency_bucket_meta_key(self, bucket_key: str) -> str:
        return f"{self._namespace}:concurrency-meta:{bucket_key}"

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
    ) -> RunLockLease | None:
        lease_id = secrets.token_urlsafe(24)
        stored = await self._redis.set(
            self._run_lock_key(run_key),
            lease_id,
            ex=ttl_seconds,
            nx=True,
        )
        if not stored:
            return None
        return RunLockLease(
            run_key=run_key,
            lease_id=lease_id,
            expires_at=datetime.now(UTC) + timedelta(seconds=ttl_seconds),
        )

    async def refresh_run_lock(
        self,
        run_key: str,
        *,
        lease_id: str,
        ttl_seconds: int,
    ) -> RunLockLease | None:
        refreshed = await self._redis.eval(
            """
            local value = redis.call('GET', KEYS[1])
            if not value or value ~= ARGV[1] then
              return 0
            end
            redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'XX')
            return 1
            """,
            1,
            self._run_lock_key(run_key),
            lease_id,
            ttl_seconds,
        )
        if not refreshed:
            return None
        return RunLockLease(
            run_key=run_key,
            lease_id=lease_id,
            expires_at=datetime.now(UTC) + timedelta(seconds=ttl_seconds),
        )

    async def release_run_lock(self, run_key: str, *, lease_id: str) -> bool:
        deleted = await self._redis.eval(
            """
            local value = redis.call('GET', KEYS[1])
            if not value or value ~= ARGV[1] then
              return 0
            end
            return redis.call('DEL', KEYS[1])
            """,
            1,
            self._run_lock_key(run_key),
            lease_id,
        )
        return bool(deleted)

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

    async def hit_rate_limit(
        self,
        key: str,
        *,
        limit: int,
        window_seconds: int,
    ) -> RateLimitState:
        rate_key = self._rate_limit_key(key)
        count = int(await self._redis.incr(rate_key))
        if count == 1:
            await self._redis.expire(rate_key, window_seconds)
        ttl = int(await self._redis.ttl(rate_key))
        if ttl < 0:
            await self._redis.expire(rate_key, window_seconds)
            ttl = window_seconds
        return RateLimitState(
            key=key,
            count=count,
            limit=limit,
            retry_after_seconds=max(1, ttl),
        )

    async def acquire_concurrency_slot(
        self,
        bucket_key: str,
        *,
        holder_key: str,
        lease_id: str,
        limit: int,
        ttl_seconds: int,
    ) -> ConcurrencySlotLease | None:
        now_ms = int(datetime.now(UTC).timestamp() * 1000)
        expires_at = datetime.now(UTC) + timedelta(seconds=ttl_seconds)
        expires_ms = int(expires_at.timestamp() * 1000)
        housekeeping_ttl = max(ttl_seconds * 2, ttl_seconds + 1)
        acquired = await self._redis.eval(
            """
            local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
            if #expired > 0 then
              redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
              redis.call('HDEL', KEYS[2], unpack(expired))
            end

            local current = redis.call('HGET', KEYS[2], ARGV[2])
            if current then
              if current ~= ARGV[3] then
                return 0
              end
              redis.call('ZADD', KEYS[1], ARGV[4], ARGV[2])
              redis.call('EXPIRE', KEYS[1], ARGV[6])
              redis.call('EXPIRE', KEYS[2], ARGV[6])
              return 1
            end

            if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5]) then
              return 0
            end

            redis.call('ZADD', KEYS[1], ARGV[4], ARGV[2])
            redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
            redis.call('EXPIRE', KEYS[1], ARGV[6])
            redis.call('EXPIRE', KEYS[2], ARGV[6])
            return 1
            """,
            2,
            self._concurrency_bucket_key(bucket_key),
            self._concurrency_bucket_meta_key(bucket_key),
            now_ms,
            holder_key,
            lease_id,
            expires_ms,
            limit,
            housekeeping_ttl,
        )
        if not acquired:
            return None
        return ConcurrencySlotLease(
            bucket_key=bucket_key,
            holder_key=holder_key,
            lease_id=lease_id,
            expires_at=expires_at,
        )

    async def refresh_concurrency_slot(
        self,
        bucket_key: str,
        *,
        holder_key: str,
        lease_id: str,
        ttl_seconds: int,
    ) -> ConcurrencySlotLease | None:
        now_ms = int(datetime.now(UTC).timestamp() * 1000)
        expires_at = datetime.now(UTC) + timedelta(seconds=ttl_seconds)
        expires_ms = int(expires_at.timestamp() * 1000)
        housekeeping_ttl = max(ttl_seconds * 2, ttl_seconds + 1)
        refreshed = await self._redis.eval(
            """
            local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
            if #expired > 0 then
              redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
              redis.call('HDEL', KEYS[2], unpack(expired))
            end

            local current = redis.call('HGET', KEYS[2], ARGV[2])
            if not current or current ~= ARGV[3] then
              return 0
            end

            local score = redis.call('ZSCORE', KEYS[1], ARGV[2])
            if not score then
              redis.call('HDEL', KEYS[2], ARGV[2])
              return 0
            end

            redis.call('ZADD', KEYS[1], ARGV[4], ARGV[2])
            redis.call('EXPIRE', KEYS[1], ARGV[5])
            redis.call('EXPIRE', KEYS[2], ARGV[5])
            return 1
            """,
            2,
            self._concurrency_bucket_key(bucket_key),
            self._concurrency_bucket_meta_key(bucket_key),
            now_ms,
            holder_key,
            lease_id,
            expires_ms,
            housekeeping_ttl,
        )
        if not refreshed:
            return None
        return ConcurrencySlotLease(
            bucket_key=bucket_key,
            holder_key=holder_key,
            lease_id=lease_id,
            expires_at=expires_at,
        )

    async def release_concurrency_slot(
        self,
        bucket_key: str,
        *,
        holder_key: str,
        lease_id: str,
    ) -> bool:
        deleted = await self._redis.eval(
            """
            local current = redis.call('HGET', KEYS[2], ARGV[1])
            if not current or current ~= ARGV[2] then
              return 0
            end
            redis.call('HDEL', KEYS[2], ARGV[1])
            redis.call('ZREM', KEYS[1], ARGV[1])
            return 1
            """,
            2,
            self._concurrency_bucket_key(bucket_key),
            self._concurrency_bucket_meta_key(bucket_key),
            holder_key,
            lease_id,
        )
        return bool(deleted)

    async def reset_state(self) -> None:
        keys: list[str] = []
        async for key in self._redis.scan_iter(match=f"{self._namespace}:*"):
            keys.append(key)
        if keys:
            await self._redis.delete(*keys)


_coordination_backend: CoordinationBackend | None = None


def coordination_config_signature() -> tuple[str, str, str]:
    """Return the active coordination config tuple."""

    return (
        settings.environment.strip().lower(),
        settings.coordination_backend.strip().lower(),
        settings.redis_url.strip(),
    )


def coordination_redis_required() -> bool:
    """Return whether hosted environments must use Redis coordination."""

    return settings.environment.strip().lower() in {"prod", "production", "staging", "preview"}


def _create_coordination_backend() -> CoordinationBackend:
    backend = settings.coordination_backend.strip().lower()
    if coordination_redis_required() and backend in {"", "memory", "in-memory", "local"}:
        raise RuntimeError(
            "Hosted environments require Redis coordination; "
            "set AGORA_COORDINATION_BACKEND=redis and AGORA_REDIS_URL."
        )
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
    if _coordination_backend is None or getattr(
        _coordination_backend,
        "_config_signature",
        None,
    ) != coordination_config_signature():
        backend = _create_coordination_backend()
        cast(Any, backend)._config_signature = coordination_config_signature()
        _coordination_backend = backend
    return _coordination_backend


def reset_coordination_backend_cache_for_tests() -> None:
    """Reset cached coordination backend instance for deterministic tests."""

    global _coordination_backend
    _coordination_backend = None


async def reset_coordination_state_for_tests() -> None:
    """Clear backend state (tickets + locks) while preserving backend type."""

    await get_coordination_backend().reset_state()


def validate_coordination_configuration() -> None:
    """Fail fast when hosted coordination is misconfigured."""

    get_coordination_backend()
