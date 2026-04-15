"""Helpers for invoking user-supplied local agent callables."""

from __future__ import annotations

import inspect
import json
from collections.abc import Callable
from typing import Any, TypeVar

from pydantic import BaseModel

CustomAgentCallable = Callable[..., Any]
ResponseModelT = TypeVar("ResponseModelT", bound=BaseModel)

_TEXT_FIELDS = ("answer", "claim", "final_answer", "reasoning", "defense", "evidence")


async def invoke_custom_agent(
    agent: CustomAgentCallable,
    *,
    system_prompt: str,
    user_prompt: str,
    response_model: type[ResponseModelT],
    fallback: ResponseModelT,
) -> tuple[ResponseModelT, dict[str, float | int]]:
    """Invoke a local agent callable and coerce output into a response model."""

    raw_response = await _call_agent(agent, system_prompt=system_prompt, user_prompt=user_prompt)
    parsed = _coerce_response(raw_response, response_model=response_model, fallback=fallback)
    return parsed, {"tokens": 0, "latency_ms": 0.0}


async def _call_agent(
    agent: CustomAgentCallable,
    *,
    system_prompt: str,
    user_prompt: str,
) -> Any:
    """Call a sync or async agent while preserving system and user prompts."""

    args: tuple[Any, ...] = ()
    kwargs: dict[str, Any] = {}

    try:
        signature = inspect.signature(agent)
    except (TypeError, ValueError):
        kwargs = {"system_prompt": system_prompt, "user_prompt": user_prompt}
    else:
        parameters = signature.parameters
        accepts_kwargs = any(
            parameter.kind is inspect.Parameter.VAR_KEYWORD
            for parameter in parameters.values()
        )
        if accepts_kwargs or {"system_prompt", "user_prompt"}.issubset(parameters):
            kwargs = {"system_prompt": system_prompt, "user_prompt": user_prompt}
        else:
            positional = [
                parameter
                for parameter in parameters.values()
                if parameter.kind
                in {
                    inspect.Parameter.POSITIONAL_ONLY,
                    inspect.Parameter.POSITIONAL_OR_KEYWORD,
                }
            ]
            if len(positional) >= 2:
                args = (system_prompt, user_prompt)
            else:
                raise TypeError(
                    "Custom agent must accept both system_prompt and user_prompt"
                )

    value = agent(*args, **kwargs)
    if inspect.isawaitable(value):
        return await value
    return value


def _coerce_response(
    raw_response: Any,
    *,
    response_model: type[ResponseModelT],
    fallback: ResponseModelT,
) -> ResponseModelT:
    """Best-effort conversion from arbitrary agent output to a structured model."""

    if isinstance(raw_response, response_model):
        return raw_response

    if isinstance(raw_response, BaseModel):
        try:
            return response_model.model_validate(raw_response.model_dump(mode="json"))
        except Exception:
            return fallback

    if isinstance(raw_response, dict):
        try:
            return response_model.model_validate(raw_response)
        except Exception:
            return fallback

    if isinstance(raw_response, str):
        stripped = raw_response.strip()
        if stripped:
            try:
                return response_model.model_validate_json(stripped)
            except Exception:
                merged = fallback.model_dump(mode="json")
                for field_name in _TEXT_FIELDS:
                    if field_name in merged:
                        merged[field_name] = stripped
                        try:
                            return response_model.model_validate(merged)
                        except Exception:
                            break
                try:
                    return response_model.model_validate(json.loads(stripped))
                except Exception:
                    return fallback

    return fallback
