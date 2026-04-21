"""FastAPI entrypoint for Agora API."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.coordination import validate_coordination_configuration
from api.routes import api_keys, auth_session, benchmarks, health, tasks, webhooks
from api.streaming import validate_streaming_configuration

_CORS_ALLOWED_ORIGINS = [
    "https://agora-bay-seven.vercel.app",
    "https://agora-dashboard.vercel.app",
    "http://localhost",
    "http://localhost:3000",
    "http://localhost:4173",
    "http://localhost:5173",
]


@asynccontextmanager
async def app_lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Validate hosted runtime configuration before serving requests."""

    validate_coordination_configuration()
    validate_streaming_configuration()
    yield

app = FastAPI(
    title="Agora Protocol API",
    description="On-chain multi-agent orchestration primitive",
    version="0.1.0",
    lifespan=app_lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ALLOWED_ORIGINS,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, tags=["health"])
app.include_router(auth_session.router, tags=["auth"])
app.include_router(api_keys.router)
app.include_router(benchmarks.router, tags=["benchmarks"])
app.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
app.include_router(webhooks.router, tags=["webhooks"])
