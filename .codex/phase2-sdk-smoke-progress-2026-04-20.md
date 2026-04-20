# Phase 2 SDK Smoke Progress Update

Date: 2026-04-20
Scope: SDK installation smoke path, hosted API exercise, receipt verification, and Phase 2 deployment readiness.

## What Landed

1. Added a dedicated Phase 2 smoke harness in `scripts/phase2_sdk_smoke/`:
   - `run.sh`
   - `run_phase2_sdk_smoke.py`
   - `README.md`
2. Added test coverage in `tests/test_phase2_sdk_smoke_script.py` for:
   - `AGORA_API_KEY` parsing from `.env`
   - report formatting
   - install-before-run ordering
   - opt-in live smoke execution
3. Hardened live provider behavior in the debate and vote engines so structured-output mismatches fall through to the live Kimi path instead of collapsing into offline fallback too early.

## Smoke Harness Behavior

The smoke script is intentionally install-first:

1. create a fresh venv
2. install `agora-sdk` from `./sdk`
3. source `/home/zahemen/projects/dl-lib/agora/.env`
4. require `AGORA_API_KEY`
5. run a simple hosted task
6. print the structured result JSON to the terminal

The default hosted smoke prompt is:

`Should we use a monolith or microservices for a small internal tool?`

The default smoke mechanism is `vote`, because that is the stable live path for a quick end-to-end check.

## Verification Results

Validated locally:

1. Python syntax check passed for the smoke harness and the updated engine tests.
2. Unit tests for smoke parsing and report generation passed.
3. Live hosted smoke run completed successfully against the Cloud Run API.

Observed live output included:

1. `receipt_verification.valid: true`
2. `mechanism_used: vote`
3. `final_answer: monolith`
4. non-zero `model_telemetry`
5. estimated cost payload in the returned result

## Readiness Call

My call: the SDK is ready for a controlled deployment.

That means:

1. it is good enough to ship into the current hosted Phase 2 path
2. the smoke path is real, not simulated
3. the hosted receipt verification and telemetry contract are functioning end to end

What I would still want before calling it a broad public release:

1. a versioned distribution sanity check against the exact built artifact, not just `./sdk`
2. one more certification-style benchmark regeneration if you want the validation artifact to be treated as final evidence rather than smoke evidence

## Current State

Phase 2 SDK deployment readiness: green for controlled/internal rollout, not yet a blanket public-release signoff.
