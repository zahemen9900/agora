# Phase 2 E2E Validation - 2026-04-17

## Executive Summary

Phase 2 local E2E is confirmed end-to-end.

The validated path was:

1. Build the alpha SDK wheel from the current workspace.
2. Start the local API in strict devnet mode.
3. Create a real workspace API key through `/api-keys/`.
4. Use that API key from the installed wheel, not the source tree.
5. Create and run an arbitration task through the SDK.
6. Commit initialize, receipt, and payment transactions on Solana devnet.
7. Verify the receipt locally and against hosted task metadata.
8. Release payment.
9. Revoke the API key and prove reuse fails with `401`.

Anchor/localnet validation was delegated to RWX CI and passed. This is the safer validation path for Anchor because it avoids relying on this local machine's validator/toolchain state.

Hosted Phase 2 E2E is not blocked by Redis or Cloud Run health anymore. It is blocked by missing hosted auth material: either a human WorkOS/AuthKit JWT for one-time bootstrap, or an already-created hosted test API key.

## Code Changes Made Today

### SDK long-run timeout

File: `agora/sdk/arbitrator.py`

Changed the SDK HTTP timeout from a hard-coded `120s` client timeout to a configurable public SDK setting:

- `DEFAULT_HTTP_TIMEOUT_SECONDS = 300.0`
- `ArbitratorConfig.http_timeout_seconds`
- `AgoraArbitrator(..., http_timeout_seconds=...)`
- `AgoraNode(..., http_timeout_seconds=...)`

Why this is safe:

- It does not change API semantics.
- It only prevents the SDK client from giving up early on legitimate long-running deliberation calls.
- The default now matches the production-ish shape of model-backed arbitration and Cloud Run timeout expectations better than `120s`.
- Invalid non-positive timeout values fail fast through Pydantic validation.

### Anchor CI hardening

Files:

- `.rwx/ci.yml`
- `contract/Anchor.toml`

Changes:

- Added `[programs.localnet]` with the same program id as devnet.
- Installed `rustup` in the RWX Anchor toolchain task because `cargo-build-sbf` requires it.
- Recreated the deterministic Anchor program keypair in RWX from the secret `AGORA_ANCHOR_PROGRAM_KEYPAIR`.
- Generated an ephemeral Solana wallet inside RWX for localnet test execution.
- Ran Anchor build/test with `--provider.cluster localnet`.

Why this is safe:

- No production behavior changes.
- The program keypair is not committed to the repo.
- The CI path no longer depends on untracked local `contract/target` artifacts.
- Anchor validation now runs in a clean remote environment.

## Infrastructure Confirmed Today

### GCP / Cloud Run

Project:

- `even-ally-480821-f3`

Cloud Run API:

- Service: `agora-api`
- Region: `us-central1`
- URL: `https://agora-api-rztfxer7ra-uc.a.run.app`
- Latest ready revision observed: `agora-api-00025-9zs`
- Health check result: `{"status":"ok","service":"agora-api","version":"0.1.0","solana_network":"devnet"}`

### Redis / Memorystore

Memorystore Redis was configured for hosted coordination:

- Instance: `agora-redis-prod`
- Region: `us-central1`
- Tier: `STANDARD_HA`
- Redis version: `REDIS_7_2`
- Network: `default`
- Connect mode: direct peering
- Auth: enabled
- Secret Manager secret: `agora-redis-url`
- Cloud Run env: `AGORA_COORDINATION_BACKEND=redis`
- Cloud Run env: `AGORA_COORDINATION_NAMESPACE=agora-prod`
- Cloud Run VPC egress: private ranges only through the default VPC

Redis smoke validation:

- Cloud Run job: `agora-redis-smoke`
- Execution observed: `agora-redis-smoke-qs9xq`
- Result: completed successfully in `1m34.21s`

Important note:

- Memorystore's private IP is not directly reachable from this WSL environment without VPN, bastion, or an IAP tunnel.
- Hosted Redis validation should be done from Cloud Run jobs/services on the same VPC path.
- Local Redis tests should use Docker/local Redis, not the Memorystore private endpoint.

## Validation Results

### Focused SDK checks

Command:

```bash
agora-env/bin/python -m ruff check agora/sdk/arbitrator.py tests/test_phase2_features.py tests/test_localnet_receipt_validation.py
```

Result:

- Passed.

Command:

```bash
agora-env/bin/python -m pytest -q -s tests/test_phase2_features.py -k 'arbitrator or node or receipt'
```

Result:

- `9 passed, 13 deselected`

Note:

- The first pytest attempt without `-s` hit a pytest capture cleanup issue before collection completed.
- Rerunning with capture disabled passed; no product failure was observed.

### Local Phase 2 E2E

Command:

```bash
agora-env/bin/python scripts/phase2_demo.py \
  --target local \
  --output benchmarks/results/phase2_demo_local_2026-04-17.json \
  --verbose
```

Result:

- Passed.

Artifact:

- `benchmarks/results/phase2_demo_local_2026-04-17.json`
- Secret-bearing RPC URL fields were redacted after validation.

SDK wheel:

- `sdk/dist/agora_sdk-0.1.0a1-py3-none-any.whl`
- SHA256 after final rebuild: `1044b52d997c11a4e290759b167dddd622a2617d04d0661869be4a951b35c474`

Observed run:

- Task id: `5873c526329627c501a0c0ff79c87d03c32cd408b351bff215989116b24f20ab`
- Mechanism: `vote`
- Final status: `paid`
- Payment status: `released`
- Total tokens: `1274`
- Latency: `38187.8919ms`
- Revoked API key reuse status: `401`

Models used:

- `gemini-3.1-pro-preview`
- `moonshotai/kimi-k2-thinking`
- `gemini-3-flash-preview`
- `claude-sonnet-4-6`

Acceptance checks:

- `initialize_tx_present`: true
- `receipt_tx_present`: true
- `payment_tx_present`: true
- `final_status_paid`: true
- `payment_status_released`: true
- `receipt_merkle_match`: true
- `receipt_hosted_metadata_match`: true

Event types observed:

- `mechanism_selected`
- `agent_output`
- `quorum_reached`
- `receipt_committed`
- `complete`
- `payment_released`

### Anchor / Localnet via RWX

Command:

```bash
~/.local/bin/rwx run .rwx/ci.yml \
  --target anchor-ci \
  --wait \
  --title "anchor localnet validation 2026-04-17"
```

Result:

- Passed.

Run:

- `https://cloud.rwx.com/mint/agora/runs/0c32a76c3bc5437a9b4964cb6b2064ab`

What this validates:

- Clean remote toolchain can install required Anchor/Solana tooling.
- Anchor program builds in CI.
- Anchor localnet tests run under `--provider.cluster localnet --validator legacy`.
- CI no longer depends on this machine's local `target/deploy` state.

### SDK package metadata

Command:

```bash
agora-env/bin/python -m twine check sdk/dist/*
```

Result:

- `sdk/dist/agora_sdk-0.1.0a1-py3-none-any.whl`: passed
- `sdk/dist/agora_sdk-0.1.0a1.tar.gz`: passed

### Broader branch checks attempted

Command:

```bash
agora-env/bin/python -m ruff check agora/ api/ benchmarks/ tests/ scripts/
```

Result:

- Failed on pre-existing branch issues outside today's Phase 2 E2E changes.

Observed categories:

- `api/auth.py`: long line.
- `api/routes/benchmarks.py`: FastAPI `Depends(...)` in argument defaults flagged by `B008`.
- `api/routes/webhooks.py`: import ordering and unnecessary UTF-8 encode argument.
- `api/store_errors.py`: exception class names missing `Error` suffix.
- `api/store_local.py`: raise chaining / long line.
- `tests/test_agent.py`: duplicate OpenRouter test definitions.
- `tests/test_store_semantics.py`: quoted type annotation.

Command:

```bash
agora-env/bin/python -m pytest -q -s -m 'not paid_integration and not localnet_integration'
```

Result:

- Interrupted manually after it started making unmarked live Gemini calls.

Reason:

- The suite still contains live-provider behavior that is not consistently protected by `paid_integration`.
- Continuing would have burned unnecessary provider calls and produced a noisy integration result, not a clean unit-test signal.

Follow-up:

- Tighten pytest markers so all live LLM/provider tests are gated.
- Then rerun the broad non-paid test suite.

### Hosted Phase 2 E2E

Command:

```bash
GOOGLE_CLOUD_PROJECT=even-ally-480821-f3 \
agora-env/bin/python scripts/phase2_demo.py \
  --target hosted \
  --api-url https://agora-api-rztfxer7ra-uc.a.run.app \
  --output benchmarks/results/phase2_demo_hosted_2026-04-17.json \
  --verbose
```

Result:

- Failed fast as expected.

Artifact:

- `benchmarks/results/phase2_demo_hosted_2026-04-17.json`

Blocker:

- No hosted test API key was available.
- Secret Manager does not currently have `agora-test-api-key`.
- No `AGORA_PHASE2_BOOTSTRAP_JWT`, `AGORA_WORKOS_JWT`, or `WORKOS_JWT` was present in the local environment.

Exact required credential to continue hosted E2E:

- Preferred: provide a human WorkOS/AuthKit JWT as `AGORA_PHASE2_BOOTSTRAP_JWT`.
- Alternative: provide a valid hosted API key as `AGORA_TEST_API_KEY`.
- Alternative: create Secret Manager secret `agora-test-api-key` containing a valid hosted API key and run with `GOOGLE_CLOUD_PROJECT=even-ally-480821-f3`.

Why a human JWT is needed:

- Hosted mode cannot create a new API key from API-key auth alone.
- `/api-keys/` intentionally requires a human JWT principal.
- That is the correct security boundary.

## Stable Alpha SDK Status

Confirmed:

- The alpha wheel builds: `agora_sdk-0.1.0a1-py3-none-any.whl`.
- The local E2E installs the wheel into a throwaway venv.
- The SDK imports resolve from the throwaway venv, not the source tree.
- The installed SDK can use a workspace API key to create/run/fetch/verify/pay/revoke through the API.
- Package metadata passes `twine check`.

Not done:

- The wheel has not been published to PyPI or another package registry from this machine.

Recommended next step:

- Publish `0.1.0a1` only after hosted E2E passes with a real hosted API key/JWT.
- Publishing still requires registry credentials and an explicit release decision.

## Remaining Blockers

### Hosted API-key bootstrap

Needed from a human:

- `AGORA_PHASE2_BOOTSTRAP_JWT`, or
- a valid `AGORA_TEST_API_KEY`, or
- Secret Manager secret `agora-test-api-key` with a valid hosted API key.

Once provided, rerun:

```bash
GOOGLE_CLOUD_PROJECT=even-ally-480821-f3 \
AGORA_PHASE2_BOOTSTRAP_JWT="<human-workos-jwt>" \
agora-env/bin/python scripts/phase2_demo.py \
  --target hosted \
  --api-url https://agora-api-rztfxer7ra-uc.a.run.app \
  --output benchmarks/results/phase2_demo_hosted_2026-04-17.json \
  --verbose
```

Expected behavior:

- The script calls `/auth/me` with the human JWT.
- The script creates a hosted API key through `/api-keys/`.
- The script stores it in Secret Manager as `agora-test-api-key`.
- The installed SDK uses that API key against Cloud Run.
- The hosted run should exercise Redis-backed coordination.

### Frontend build

Frontend build failures were already known and remain outside this pass.

This document only covers:

- Redis/Cloud Run readiness.
- Local Phase 2 E2E.
- SDK alpha wheel validation.
- Anchor/localnet validation via RWX.
- Hosted E2E auth blocker.
