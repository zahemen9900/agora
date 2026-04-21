# API/Auth Implementation Status

Date: 2026-04-15

## Summary

Dual Auth v1 is implemented in code:

- WorkOS JWT bearer tokens for dashboard users
- First-party opaque Agora API keys for SDK, CI, notebooks, and server-to-server callers

The backend now normalizes both credential types into a shared principal model and uses
`workspace_id` as the authoritative task tenant key. The dashboard now bootstraps from
`GET /auth/me` instead of assuming "AuthKit user exists" is enough.

## Plan Alignment

### Implemented

- Shared bearer transport for JWTs and API keys
- Normalized principal shape:
  - `auth_method`
  - `workspace_id`
  - `user_id`
  - `display_name`
  - `email`
  - `scopes`
  - `api_key_id`
- Personal-workspace-first account model with local persistence for:
  - `users`
  - `workspaces`
  - `api_keys`
- Workspace-based task tenancy:
  - `workspace_id` stored on tasks
  - `created_by` preserved for actor/audit purposes
  - ownership checks, list/load/run/stream/pay keyed by workspace
- API key lifecycle:
  - one-time reveal
  - HMAC-hashed secret storage
  - expiry support
  - soft revocation
  - `last_used_at` tracking
- New backend endpoints:
  - `GET /auth/me`
  - `GET /api-keys`
  - `POST /api-keys`
  - `POST /api-keys/{key_id}/revoke`
- Dashboard auth wiring:
  - explicit bootstrap through `/auth/me`
  - `authStatus`, `principal`, `workspace`, `featureFlags`
  - return-to redirect preservation
  - Benchmarks hidden from normal navigation
  - new `/api-keys` UI
- Docs and test-path updates:
  - API key env surfaced
  - hosted E2E and week1 demo now expect `AGORA_TEST_API_KEY`
  - SDK docs now describe Agora API keys explicitly

### Explicitly Not Implemented

These were intentionally outside the v1 plan:

- org/team auth model
- RBAC/admin roles
- service accounts
- cookie-backed backend sessions
- benchmark dashboard auth/RBAC

## Main Files Touched

### Backend

- `api/auth.py`
- `api/auth_keys.py`
- `api/config.py`
- `api/models.py`
- `api/routes/auth_session.py`
- `api/routes/api_keys.py`
- `api/routes/tasks.py`
- `api/routes/webhooks.py`
- `api/store.py`
- `api/store_local.py`
- `api/main.py`

### Frontend

- `agora-web/src/lib/auth.tsx`
- `agora-web/src/lib/api.ts`
- `agora-web/src/App.tsx`
- `agora-web/src/components/NavBar.tsx`
- `agora-web/src/pages/Callback.tsx`
- `agora-web/src/pages/ApiKeys.tsx`

### Tests and Docs

- `tests/test_api_infra_routes.py`
- `tests/test_e2e.py`
- `tests/test_phase2_features.py`
- `README.md`
- `sdk/README.md`
- `agora-web/README.md`
- `docs/release-operations.md`
- `scripts/week1_demo.sh`

## Verification Completed

Python/backend verification completed successfully in the repo virtualenv:

- `python -m py_compile ...`
- `ruff check api tests`
- `pytest -s tests/test_api_infra_routes.py -q`
- `pytest -s tests/test_api_infra_routes.py tests/test_e2e.py -q`
- `pytest -s tests/test_phase2_features.py -q`
- `pytest -s -q`
- `python -m build sdk`
- `git diff --check`

Latest known-good outcomes during this implementation:

- `tests/test_api_infra_routes.py`: 32 passed
- `tests/test_phase2_features.py`: 17 passed
- full Python suite: 127 passed, 3 skipped
- SDK build: wheel and sdist built successfully

Added regression coverage for:

- API key auth success path
- revoked API key rejection
- expired API key rejection
- malformed API key rejection
- `/auth/me` bootstrap payload
- API key create/list/revoke flow
- SDK hosted header continuity via `auth_token`

## Frontend Build Status

Frontend code was updated, but a real local build could not be completed in this shell.

Observed environment issue:

- `npm` exists
- `node` is not on PATH
- `npm run build` falls back into Windows `CMD.EXE` on the WSL UNC path
- that environment cannot resolve `tsc`

This is an environment/tooling problem, not a confirmed TypeScript compile error in the repo.

## Cloud Run Deployment Status

Deployment completed successfully after GCP auth was restored.

Live service:

- project: `even-ally-480821-f3`
- region: `us-central1`
- service: `agora-api`
- URL: `https://agora-api-rztfxer7ra-uc.a.run.app`
- latest ready revision: `agora-api-00023-pwz`

Production config added during deployment:

- Secret Manager secret `agora-api-key-pepper` was created
- the Cloud Run runtime service account was granted `roles/secretmanager.secretAccessor`
- deploy now injects `AGORA_API_KEY_PEPPER` from Secret Manager
- deploy also sets `AGORA_API_KEY_DEFAULT_TTL_DAYS=90`

### Production Issue Found During Deploy

The first Cloud Run rollout failed at container startup even though the local Python suite was green.
This exposed a real dependency-lock mismatch between local execution and the constrained deploy image.

Observed failure:

- `TypeError: Cannot create a consistent method resolution order (MRO) for bases ABC, Generic`

Root cause:

- `api/constraints.txt` pinned `langgraph==0.5.0`
- the validated local environment was using the newer `langgraph` family already
- importing `agora/engines/debate.py` under the older constrained image crashed the API process

Fix applied:

- updated `api/constraints.txt` to match the known-good local runtime:
  - `langgraph==1.1.6`
  - `langchain-core==1.2.28`
  - `langgraph-checkpoint==4.0.1`
  - `langgraph-prebuilt==1.0.9`
  - `langgraph-sdk==0.3.13`

This was the only deploy-time code issue uncovered after the auth/api-key implementation landed.

### Live Verification

Verified against the deployed Cloud Run service:

- `GET /health` returned `{"status":"ok","service":"agora-api","version":"0.1.0","solana_network":"devnet"}`
- `openapi.json` includes:
  - `/auth/me`
  - `/api-keys/`
  - `/tasks/{task_id}/stream-ticket`

## Remaining Limit

The only meaningful verification gap left in this turn is the frontend build environment inside this
shell. The dashboard auth and API-key UI code is implemented, but local `npm run build` is still blocked
here by the WSL/Windows Node toolchain mismatch described above.

## Next Recommended Action

From here, the next high-value steps are:

1. run a real dashboard login against WorkOS/AuthKit once the final frontend environment is in place
2. create a staging API key from the dashboard UI and run hosted E2E with `AGORA_TEST_API_KEY`
3. tackle the remaining multi-instance/runtime technical debt documented in `docs/remaining-technical-issues-report.md`
