# AGORA Project Memory

Last updated: Saturday 11:24am, 04/11/2026

## Durable Facts

- This repository currently contains the Python runtime track only.
- The runtime implements selector, debate, vote, monitor, hasher, and orchestrator logic.
- The runtime passes its current automated test suite: `32 passed`.
- The Solana boundary is HTTP-backed in `agora/solana/client.py`, and the orchestrator can auto-submit receipts when a client is configured.
- The orchestrator still depends on an external backend for actual chain settlement and task retrieval.
- The guiding architecture docs in `docs/` define a larger multi-track system than what exists in code.
- A checked-in graph harness now exists at `scripts/agent_harness/build_graphify_snapshot.py`.
- The first architecture snapshot has been generated under `graphify-out/agora-runtime/`.
- The planning package now lives in `docs/`, with a brainstorming spec mirror under `docs/superpowers/specs/`.
- A reusable proof-of-work runner now exists at `scripts/pipeline_demo.py`; it prints a clean runtime summary and can load `ANTHROPIC_API_KEY` from the `even-ally-480821-f3` GCloud project secret path when `gcloud` is available.
- Validation on Saturday 11:49am, 04/11/2026: `37 passed` via `uv run pytest -q`, `uv run --with ruff ruff check .` passed, and a smoke run wrote settlement logs under `logs/`.

## Ownership Model

- Dave track: runtime core and ML/LLM orchestration.
- Josh track: Anchor contract, FastAPI bridge, deployment, and chain integration.
- Joshua Ddf track: React dashboard.
- Joshua: planning lock, execution sequencing, interface control, and acceptance bar.

## Technical Shape

- Central dependency hub is `agora/types.py`.
- Runtime hub is `agora/runtime/orchestrator.py`, which depends on selector, engines, monitor, and hasher.
- The codebase is compact enough for direct review, but dense enough that architecture notes should be maintained explicitly.

## Important Gaps

- No API service or contract code exists in this repo.
- No frontend code exists in this repo.
- The "on-chain arbitration" claim is only partially realized until receipt submission and task status are wired.

## Git / Repo Conventions For This Workspace

- Repo-local git identity is intentionally set to `jnopareboateng <jnopareboateng@outlook.com>` by explicit user direction.
- Planning and execution docs for this project should live under `docs/`.

## Planning Guidance

- Do not treat this as a blank-slate build. Treat it as a partially completed runtime that needs integration, interface freezing, and execution discipline.
- The next highest-leverage planning move is to separate the master plan from Joshua's implementation lane while keeping one canonical status ledger.
