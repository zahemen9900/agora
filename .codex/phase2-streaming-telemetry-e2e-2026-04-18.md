# Phase 2 Streaming and Telemetry E2E Closure

Date: 2026-04-18
Scope: Streaming envelope reliability, live/benchmark UX fidelity, 4/8/12 agent parity, backend per-model telemetry, and regression hardening.

## 1) Objective

Complete implementation and objective closure of Phase 2 work across backend, runtime engines, frontend, tests, and contract boundary behavior, including final validation and commit readiness.

## 2) Plan-to-Implementation Mapping

### A. Stream Envelope Reliability and Client Recovery

Implemented:
- API stream output normalization to explicit SSE payload shape with replay/live parity.
- Envelope shape:
  - event: <event_name>
  - data:
    - payload: <event_payload>
    - timestamp: <event_timestamp>
- Frontend stream client now supports:
  - bounded exponential backoff reconnect
  - fresh stream-ticket fetch per reconnect
  - payload shape normalization across new/legacy forms
  - duplicate event suppression via deterministic event signatures
  - terminal-event-aware shutdown

Files:
- api/routes/tasks.py
- agora-web/src/lib/api.ts

### B. Runtime Telemetry (Per-Model Tokens and Latency)

Implemented:
- Extended runtime deliberation result model to include:
  - model_token_usage: dict[str, int]
  - model_latency_ms: dict[str, float]
- Vote engine now aggregates per-model token and latency metrics from vote outputs.
- Debate engine now aggregates per-stage and synthesis usage, preserving model attribution through:
  - opening/rebuttal/cross-exam aggregation
  - final synthesis aggregation
  - prior-stage carry-forward into final result

Files:
- agora/types.py
- agora/engines/vote.py
- agora/engines/debate.py

### C. API Response Contract Expansion

Implemented:
- Deliberation result API now includes:
  - model_token_usage
  - model_latency_ms
  - payment_amount
  - payment_status
  - informational_model_payouts
- Added informational per-model payout derivation:
  - proportional by token usage when available
  - even split fallback when token map is absent but model roster is known
- run_task now maps task payment metadata into result response.

Files:
- api/models.py
- api/routes/tasks.py
- agora-web/src/lib/api.generated.ts

### D. Agent Count and Defaults Parity (API + UI + Contract)

Implemented:
- API request defaults and limits updated to 4 default, 12 max for:
  - TaskCreateRequest
  - BenchmarkRunRequest
- Solana bridge guard updated to [1, 12].
- On-chain initialize_task validation updated to <= 12.
- Frontend controls updated to 4/8/12 options and stake default 0.001 in task submission and benchmark trigger flow.

Files:
- api/models.py
- api/solana_bridge.py
- contract/programs/agora/src/instructions/initialize_task.rs
- agora-web/src/pages/TaskSubmit.tsx
- agora-web/src/pages/Benchmarks.tsx

### E. Live and Benchmark UX Enrichment

Implemented:
- Live deliberation page now supports:
  - timeline hydration from persisted + live events without duplicates
  - typed event mapping and richer cards (mechanism, cross exam, quorum, receipt/payment/error)
  - model telemetry panel using measured backend fields with fallback estimation
- Benchmarks page now supports:
  - benchmark run agent-count selector (4/8/12)
  - richer run table columns (status/tokens/confidence/payment/event metadata)
  - selected-run error/model telemetry cards
  - payload decoding resilience for schema drift

Files:
- agora-web/src/pages/LiveDeliberation.tsx
- agora-web/src/pages/Benchmarks.tsx

### F. Regression Coverage Hardening

Implemented:
- Added/updated tests to cover:
  - new TaskCreateRequest and BenchmarkRunRequest defaults/bounds
  - _result_to_response telemetry and payout allocation behavior
  - SSE replay/ticket stream envelope shape
  - debate final aggregation signature and model telemetry assertions

Files:
- tests/test_api_infra_routes.py
- tests/test_debate.py

## 3) Validation Evidence

Backend targeted regression command:
- /home/zahemen/projects/dl-lib/agora/.venv/bin/python -m pytest tests/test_api_infra_routes.py tests/test_e2e.py tests/test_vote.py tests/test_debate.py -q

Result:
- 79 passed, 4 skipped, 0 failed

Frontend build command:
- npm run build (in agora-web)

Result:
- TypeScript + Vite build succeeded.
- Non-blocking bundle-size warning remains for one large chunk.

## 4) Audit-Driven Fixes During Closure

During objective closure, one regression surfaced:
- tests/test_debate.py failed due debate _final_aggregation signature drift.

Resolution:
- Updated test call with new prior_model_* args.
- Fixed debate synthesis aggregation to fold synthesis model usage into model_token_usage/model_latency_ms.
- Re-ran targeted regression suite to green.

## 5) Commit Scope and Hygiene

Included in implementation scope:
- Backend/runtime/API/frontend/contract/test changes listed above.
- Generated frontend API types update.

Excluded from implementation commit:
- benchmarks/results/phase2_demo.json (generated runtime artifact; intentionally left out to avoid noisy artifact churn in code-change commit).

Workspace hygiene:
- Removed accidental root-level stray file named ='replace').

## 6) Residual Non-Blocking Notes

- Frontend build reports a chunk-size warning only; no compile/type/build failure.
- Informational model payouts are explicitly display-oriented and not on-chain settlement splits.

## 7) Final Status

Phase 2 implementation closure for this scope is complete and validated end-to-end against the targeted regression and build gates.
