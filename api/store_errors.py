"""Typed persistence errors for task store backends."""

from __future__ import annotations


class TaskStoreError(RuntimeError):
    """Base class for persistence-layer failures."""


class TaskStoreNotFound(TaskStoreError):
    """Raised when a requested object is missing in persistence."""


class TaskStorePayloadError(TaskStoreError):
    """Raised when persisted JSON payloads are malformed or incomplete."""


class TaskStoreUnavailable(TaskStoreError):
    """Raised for infrastructure/auth/connectivity errors in persistence backend."""
