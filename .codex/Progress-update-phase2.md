# Phase 2 Consolidated Progress Update (Canonical)

Date: 2026-04-15
Branch: codex/phase-2-completion

This is the single source-of-truth Phase 2 report.
It consolidates implementation and hardening status that previously lived across two documents.

## Consolidation Note

- Consolidated source docs:
  - `.codex/Progress-update-phase2.md` (previous mixed status draft)
  - `.codex/Progress-update-phase2-implementation.md` (implementation + hardening detail)
- Canonical target doc:
  - `.codex/Progress-update-phase2.md`
- Consolidation result:
  - one canonical file retained
  - implementation file removed from working tree as part of consolidation

## 1) Scope Implemented

### A. Core API and Runtime

1. Task lifecycle routes are operational for create, run, list/get status, stream, and pay.
2. Selector and orchestrator execution paths are wired through persisted task state.
3. SSE event flow supports persisted replay and live updates.
4. Solana bridge route flow remains integrated for initialize, selection, receipt submission, switch recording, and payment release.
5. Orchestrator override semantics are now pinned and deterministic:
   - `mechanism_override` bypasses selector choice
   - forced runs execute exactly one requested mechanism
   - automatic debate-to-vote or vote-to-debate switching is suppressed during forced runs
6. Persisted selector decisions can be replayed safely through the API execution path without re-running selector logic:
   - API create stores selector reasoning, confidence, and mechanism
   - API run reconstructs and executes the stored selection when no force override is configured
7. Deliberation results now expose `agent_models_used`, allowing downstream API, SDK, and demo consumers to inspect which model ensemble actually participated in a run.

### B. Benchmarks and Validation

1. Benchmark datasets are present for math, factual, reasoning, code, and creative categories.
2. Dataset aliasing supports both short and spec-style names.
3. `scripts/phase2_validation.py` is available and import-safe when run directly.
4. Validation artifact generation is in place at `benchmarks/results/phase2_validation.json`.

### C. Hardening Applied

1. Benchmark summary precedence was hardened to:
   - persisted summary
   - completed task aggregation
   - file artifact fallback
2. Deterministic offline validation checks were reinforced with seeded rerun checks.
3. SDK receipt verification is strict by default and no longer incorrectly depends on `solana_wallet` just to compare hosted receipt metadata when a known hosted task id exists.
4. `AgoraNode` strict verification and wallet pass-through behavior is aligned with arbitrator behavior.
5. SSE event envelopes are now consistent across persisted replay and live streaming:
   - `event`
   - `data`
   - `timestamp`
6. Provider key resolution was hardened so late-bound secrets from dotenv or Secret Manager are visible to the live orchestrator path, not only isolated smoke checks.

### D. Frontend Live Wiring

1. Frontend pages consume live API surfaces for tasks, deliberation, receipt, and benchmarks.
2. Production build succeeds.
3. Auth flow now uses WorkOS async access token retrieval per protected API request.

### E. Auth-First WorkOS Integration

1. Backend JWT verification is now signature-verified through JWKS.
2. Auth defaults to required (`AUTH_REQUIRED=true`).
3. Backend supports explicit and derived WorkOS verifier config:
   - `WORKOS_CLIENT_ID`
   - `WORKOS_AUTHKIT_DOMAIN`
   - `AUTH_ISSUER`
   - `AUTH_AUDIENCE`
   - `AUTH_JWKS_URL`
4. Frontend removed brittle synchronous token assumptions and now calls `getAccessToken()` before protected operations.

### F. Provider Key Resolution Hardening

1. Added `AGORA_ENV_FILE` support for explicit dotenv path loading.
2. Added Secret Manager fallback through `gcloud secrets versions access` when ADC is unavailable.
3. Added OpenRouter key normalization for duplicated-token corruption scenarios.
4. Paid integration key detection now uses full config resolution (env or secrets), not env-only checks.
5. Gemini direct SDK initialization now re-reads late-bound key configuration at caller construction time so password-manager or secret-injected credentials are visible to the main arbitration path.

### G. Kimi / All-Model Ensemble Integration

1. Kimi K2 Thinking is now a first-class participant in the runtime ensemble, not just a provider smoke target.
2. Vote runs with 4 agents surface the active model lineup in stable first-seen order through `agent_models_used`.
3. Debate runs also surface participating model lineage, including the Kimi cross-exam role and the final synthesis model.
4. API task responses now serialize:
   - `agent_count`
   - `agent_models_used`
5. Hosted task execution now defaults public entry points to `agent_count=4`; smaller ensembles remain available by passing an explicit `agent_count`.
6. Hosted forcing now supports both request-level and env-level controls for strict demo validation:
   - request payload: `mechanism_override=vote|debate`
   - env fallback: `AGORA_API_FORCE_MECHANISM=vote|debate`
7. Kimi-specific work was forward-ported selectively into Phase 2 without reviving:
   - old Week 1 mock route behavior
   - `api_use_real_orchestrator`
   - stale duplicated SDK implementation paths

## 2) Latest Deployment State

Service: `agora-api`  
Project: `even-ally-480821-f3`  
Region: `us-central1`

Current service URL:

- `https://agora-api-rztfxer7ra-uc.a.run.app`

Latest deployed revision in this pass:

- `agora-api-00020-wml`

Image deployed in this pass:

- `us-central1-docker.pkg.dev/even-ally-480821-f3/agora/agora-api:phase2-auth-20260414121920`

Image digest from Cloud Build push:

- `sha256:6a7a36822be11978096a548780f929e5a3a75b23857edfb33bb2ebd04e9c761e`

Auth env confirmed on Cloud Run:

1. `AUTH_REQUIRED=true`
2. `WORKOS_CLIENT_ID=client_01KP5AV4GEG7YMKK1HHVWF6REP`
3. `WORKOS_AUTHKIT_DOMAIN=sparkling-edge-56-sandbox.authkit.app`
4. `AUTH_ISSUER=https://sparkling-edge-56-sandbox.authkit.app`
5. `AUTH_AUDIENCE=client_01KP5AV4GEG7YMKK1HHVWF6REP`
6. `AUTH_JWKS_URL=https://sparkling-edge-56-sandbox.authkit.app/oauth2/jwks`

## 3) Verification Evidence

### A. Quality Gates

1. Ruff checks on updated runtime/API/test/script files: pass.
2. Full backend test suite: pass (`105 passed, 3 skipped`).
3. Frontend build: pass.
4. Demo script shell syntax check: pass.

### B. Key Resolution Checks

1. External dotenv via `AGORA_ENV_FILE`: pass.
2. Secret Manager fallback path (including gcloud fallback): pass.
3. Late-bound orchestrator provider key propagation: pass.

### C. Paid Provider Integration Checks

Executed:

- `tests/test_vote.py::test_vote_paid_integration_hits_kimi_path`
- `tests/test_debate.py::test_debate_paid_integration_hits_kimi_cross_exam`

Result:

- pass (`2 passed`)
- logs confirmed live OpenRouter Kimi calls with non-zero tokens and realistic latency

### D. Kimi / All-Model Regression Coverage

Implemented and verified through tests:

1. 4-agent vote captures ordered `agent_models_used`.
2. Debate captures Kimi participation and final synthesis model lineage.
3. Forced `mechanism_override=vote` no longer switches back into debate.
4. API run responses preserve `agent_count` and `agent_models_used`.
5. Hosted receipt verification works from known hosted task ids without requiring `solana_wallet`.
6. SSE replay and live streams both preserve `timestamp` in the event envelope.

### E. Demo and Smoke Validation

1. `scripts/week1_demo.sh` now supports:
   - local orchestrator smoke
   - direct Gemini / Claude / Kimi provider smokes
   - strict local all-model vote validation
   - hosted API E2E flow
   - hosted strict all-model validation
2. Demo environment controls now include:
   - `RUN_ALL_MODELS_E2E`
   - `RUN_HOSTED_API_E2E`
   - `RUN_HOSTED_ALL_MODELS_E2E`
   - `RUN_ORCHESTRATOR_SMOKE`
   - timeout controls for orchestrator, model, and all-model paths
3. A local no-provider sanity run was executed successfully with all optional smokes disabled.

### F. Post-Deploy Auth and CORS Smoke Checks

Against `https://agora-api-rztfxer7ra-uc.a.run.app`:

1. `GET /health` -> `200` with expected service payload.
2. `POST /tasks/` without bearer token -> `401` (`Missing bearer token`).
3. `POST /tasks/` with invalid bearer token -> `401` (`Invalid bearer token`).
4. CORS preflight for `https://agora-bay-seven.vercel.app` -> `200` with `Access-Control-Allow-Origin` correctly set.

## 4) Recent Commit Traceability

Recent relevant commit anchors:

1. `8b833bd` - WorkOS AuthKit React integration baseline.
2. `daee6a9` - benchmark and SDK verification hardening.
3. `c2f3fd1` - phase 2 progress/report traceability update.
4. Current working tree also includes selective Kimi/all-model Phase 2 integration and documentation updates not yet captured in a dedicated commit anchor within this report.

Current pass also includes uncommitted working-tree updates for auth verification hardening, token flow fixes, docs updates, and the report consolidation captured in this document.

## 5) Residual Follow-Ups (Non-Blocking)

1. Frontend bundle-size warning is still present, but build succeeds.
2. Optional additional manual browser UX pass can be run for final callback and route polish checks.
3. Release/publish decisions (for example SDK publication timing) remain operational choices, not implementation blockers.

## 6) Final Status

Implementation: complete for the current Phase 2 backend/runtime/API hardening scope, including selective Kimi all-model integration.  
Deployment: latest documented auth-first deployed revision remains valid; any additional Kimi-specific hosted deployment proof should be tracked separately if a new revision is promoted.  
Documentation: consolidated into this canonical report and updated to reflect current runtime, API, demo, and ensemble behavior.
