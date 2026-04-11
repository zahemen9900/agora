# AGORA Phase Status

Last updated: Saturday 11:24am, 04/11/2026

## Purpose

This file tracks what is done, what is owned, what is blocked, and what must not be duplicated.
It is the working execution ledger for AGORA across runtime, on-chain, API, and frontend tracks.

## Current Phase

| Area | Status | Owner | Notes |
|---|---|---|---|
| Runtime core | In progress | Dave track | Week 1 Python core is largely implemented and passing tests. |
| On-chain settlement | Partially implemented in Python | Josh track | HTTP-backed bridge boundary exists in Python runtime. Anchor contract and RPC backend are not present here. |
| API bridge | Not started in this repo | Josh track | FastAPI bridge described in docs, not implemented in this repo. |
| Frontend dashboard | Not started in this repo | Joshua Ddf track | No frontend folder or dashboard code present here. |
| Project planning and coordination | In progress | Joshua | Planning package now exists in `docs/`; awaiting approval. |
| Graph harness and architecture snapshot | Complete | Shared | Local harness added and first backend snapshot generated. |

## What Exists Now

| Component | Status | Evidence |
|---|---|---|
| Shared types | Complete for Week 1 scope | `agora/types.py` |
| Agent abstraction | Implemented | `agora/agent.py` |
| Feature extraction | Implemented | `agora/selector/features.py` |
| Thompson sampling selector | Implemented | `agora/selector/bandit.py` |
| LLM reasoning selector | Implemented | `agora/selector/reasoning.py` |
| Combined selector | Implemented | `agora/selector/selector.py` |
| Debate engine | Implemented | `agora/engines/debate.py` |
| Vote engine | Implemented | `agora/engines/vote.py` |
| State monitor | Implemented | `agora/runtime/monitor.py` |
| Transcript hasher / Merkle builder | Implemented | `agora/runtime/hasher.py` |
| Orchestrator | Implemented | `agora/runtime/orchestrator.py` |
| Solana client boundary | Implemented as HTTP-backed bridge | `agora/solana/client.py` |
| Public SDK facade | Stub / minimal | `agora/sdk/arbitrator.py` |
| Graph harness | Implemented | `scripts/agent_harness/build_graphify_snapshot.py` |
| Graph snapshot outputs | Generated | `graphify-out/agora-runtime/` |

## Validated Today

| Check | Result | Notes |
|---|---|---|
| Git remote sync vs `origin/main` | Clean | `0` ahead, `0` behind after fetch |
| Local git identity | Set | `jnopareboateng <jnopareboateng@outlook.com>` |
| Test suite | Pass | `37 passed in 6.26s` via `uv run pytest -q` |
| Lint | Pass | `uv run --with ruff ruff check .` |
| Settlement smoke | Pass | `logs/2026-04-11-settlement-smoke.log` |
| Branching baseline | Ready | Working branch created for planning and tracking |
| Graph harness | Pass | Snapshot generated successfully for `agora-runtime` scope |

## Critical Gaps

| Gap | Severity | Why it matters |
|---|---|---|
| Orchestrator can submit receipts, but the backend is still mocked behind HTTP | High | Core "on-chain arbitration" claim is still incomplete without a real contract/backend. |
| Solana client has a real HTTP contract, but no chain backend in repo | High | Josh-owned contract/API integration is still the main missing boundary. |
| No API service in this repo | High | No stable external interface for task submission, status, or live execution. |
| No frontend code in this repo | Medium | Dashboard ownership exists in docs but not in implementation. |
| Repo has planning docs but no active execution ledger | Fixed now | This file is the first pass at that ledger. |

## Ownership Boundary

| Track | In scope | Out of scope |
|---|---|---|
| Dave runtime track | Selector, engines, monitor, orchestrator, hashing, model layer | Contract deployment, API serving, dashboard |
| Josh integration track | Anchor contract, Solana client, FastAPI bridge, deployment, settlement reliability | Debate/vote engine internals unless integration requires contract fields |
| Joshua planning / product track | Architecture lock, execution order, validation bar, integration acceptance, roadmap control | Low-level implementation ownership by default |

## Do Not Duplicate

| Do not redo | Reason |
|---|---|
| Re-implement selector, debate, vote, monitor, hasher from scratch | They already exist and pass tests. Improvement should be targeted, not reset-based. |
| Build contract assumptions without locking receipt schema first | Runtime and chain must share one deterministic receipt contract. |
| Start frontend work before API contract is frozen | Dashboard drift is guaranteed if task and receipt payloads are unstable. |
| Add Delphi / MoA now as priority work | Core value path is runtime to chain, not more mechanism count. |

## Recommended Immediate Sequence

| Order | Step | Owner | Outcome |
|---|---|---|---|
| 1 | Lock project master plan and Joshua critical path | Joshua | Shared operating plan with explicit interfaces and milestones |
| 2 | Freeze runtime-to-chain receipt contract | Josh + Dave | One canonical payload for chain submission and status queries |
| 3 | Implement Solana client boundary in Python and wire orchestrator integration points | Josh | Runtime can submit and query receipts |
| 4 | Build FastAPI task lifecycle endpoints | Josh | External execution surface for dashboard and SDK |
| 5 | Define dashboard contract from API events and receipt payloads | Joshua Ddf + Joshua | Prevent frontend drift |
| 6 | Add end-to-end integration tests across runtime, API, and chain sandbox | Team | Proof that product claim is real |

## Working Branch

`feat/project-orientation-tracking`
