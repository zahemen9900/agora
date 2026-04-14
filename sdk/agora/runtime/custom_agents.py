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
    """Call a sync or async agent using a permissive invocation strategy."""

    candidates: list[tuple[tuple[Any, ...], dict[str, Any]]] = [
        ((), {"system_prompt": system_prompt, "user_prompt": user_prompt}),
        ((system_prompt, user_prompt), {}),
        ((user_prompt,), {}),
        ((), {"prompt": user_prompt}),
    ]

    last_error: TypeError | None = None
    for args, kwargs in candidates:
        try:
            value = agent(*args, **kwargs)
        except TypeError as exc:
            last_error = exc
            continue
        if inspect.isawaitable(value):
            return await value
        return value

    if last_error is not None:
        raise last_error
    raise TypeError("Custom agent callable could not be invoked")


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
