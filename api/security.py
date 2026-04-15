"""Security helpers shared by API persistence and routes."""

from __future__ import annotations

import re
from pathlib import Path

_STORAGE_ID_RE = re.compile(r"^[A-Za-z0-9_.@:-]{1,255}$")


def validate_storage_id(value: str, *, field_name: str) -> str:
    """Return a path/object-safe identifier or raise ``ValueError``."""

    if (
        not isinstance(value, str)
        or value in {".", ".."}
        or not _STORAGE_ID_RE.fullmatch(value)
    ):
        raise ValueError(f"{field_name} contains unsafe characters")
    return value


def safe_child_path(root: Path, *parts: str) -> Path:
    """Build a child path and assert it remains under ``root``."""

    resolved_root = root.resolve()
    candidate = resolved_root.joinpath(*parts).resolve()
    if candidate != resolved_root and resolved_root not in candidate.parents:
        raise ValueError("path escapes storage root")
    return candidate
