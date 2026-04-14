"""FastAPI entrypoint for Agora API."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import benchmarks, health, tasks, webhooks

_CORS_ALLOWED_ORIGINS = [
    "https://agora-bay-seven.vercel.app",
    "https://agora-dashboard.vercel.app",
    "http://localhost",
    "http://localhost:3000",
    "http://localhost:4173",
    "http://localhost:5173",
]

app = FastAPI(
    title="Agora Protocol API",
    description="On-chain multi-agent orchestration primitive",
    version="0.1.0",
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
app.include_router(benchmarks.router, tags=["benchmarks"])
app.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
app.include_router(webhooks.router, tags=["webhooks"])
