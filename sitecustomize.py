"""Fail fast when running the repo with an unsupported Python version."""

from __future__ import annotations

import sys

if sys.version_info < (3, 11):  # noqa: UP036
    version = ".".join(str(part) for part in sys.version_info[:3])
    raise RuntimeError(
        "Agora requires Python 3.11 or newer. "
        f"Detected Python {version}. Activate `agora-env` or another 3.11 environment."
    )
