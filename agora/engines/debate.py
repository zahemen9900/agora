"""Compatibility alias for the canonical debate engine implementation."""

from __future__ import annotations

import sys

from agora.tools import debate as _debate

sys.modules[__name__] = _debate
