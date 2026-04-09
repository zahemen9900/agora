"""Public SDK stub for Phase 2 packaging."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from agora.runtime.orchestrator import AgoraOrchestrator
from agora.types import DeliberationResult


class ArbitratorConfig(BaseModel):
    """SDK configuration for the public arbitrator interface."""

    model_config = ConfigDict(frozen=True)

    agent_count: int = 3
    default_stakes: float = 0.5


class AgoraArbitrator:
    """SDK facade over the runtime orchestrator."""

    def __init__(self, config: ArbitratorConfig | None = None) -> None:
        """Initialize arbitrator facade.

        Args:
            config: Optional SDK configuration.
        """

        self.config = config or ArbitratorConfig()
        self._orchestrator = AgoraOrchestrator(
            agent_count=self.config.agent_count,
            default_stakes=self.config.default_stakes,
        )

    async def arbitrate(self, task: str, stakes: float | None = None) -> DeliberationResult:
        """Run arbitration for a task.

        Args:
            task: Task prompt.
            stakes: Optional normalized stake override.

        Returns:
            DeliberationResult: Orchestrated arbitration result.
        """

        return await self._orchestrator.run(task=task, stakes=stakes)
