"""Internal Delphi roadmap stub; not part of the supported runtime surface."""

from __future__ import annotations

from agora.types import DeliberationResult, MechanismSelection


class DelphiEngine:
    """Placeholder Delphi engine implementation."""

    async def run(self, task: str, selection: MechanismSelection) -> DeliberationResult:
        """Raise until Phase 3 implementation is added.

        Args:
            task: Task prompt.
            selection: Mechanism selection payload.

        Raises:
            NotImplementedError: Always for this phase.
        """

        raise NotImplementedError("Delphi engine is scheduled for Phase 3")
