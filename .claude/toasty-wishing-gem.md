# Josh Week 1 Infra Completion Report

Date: 2026-04-12
Branch: codex/week1-infra
Latest commit at time of report: b6d32b7
Program ID: 82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd

## 1. Scope Completed

This report covers the Week 1 infra scope for Josh:
- Anchor contract and tests
- Solana devnet deploy/test flow
- FastAPI scaffold + persistence/auth/webhooks
- Solana bridge integration
- Docker/CI/deploy workflow hardening
- Plan cross-check and gap closure

## 2. Attached Plan Cross-Check (PLAN.md)

### Summary Goal
Harden scaffold-level infra to verifiable Week 1 end-to-end path.

Status: Completed with one operational environment caveat documented in Section 8.

### Key Changes from PLAN.md

1. Preserve contract shape, avoid rewrites unless needed
- Implemented: yes.
- Existing Anchor program was retained and validated rather than rewritten.

2. Replace memo-based bridge with real program calls
- Implemented: yes.
- `api/solana_bridge.py` now builds real Anchor instruction payloads and submits signed transactions for:
  - `initialize_task`
  - `record_selection`
  - `submit_receipt`
  - `record_mechanism_switch`
  - `release_payment`

3. Standardize task IDs to full SHA-256 internally
- Implemented: yes.
- API now uses full 64-char hex SHA-256 task IDs, converted to 32 bytes for instruction payloads.

4. Route behavior split and aligned
- Implemented: yes.
- `POST /tasks/`:
  - creates persisted task state
  - initializes on-chain task when Solana bridge is configured
- `POST /tasks/{task_id}/run`:
  - records selection on-chain (if pending)
  - submits real receipt on-chain
  - persists response and events
- `POST /tasks/{task_id}/pay`:
  - validates status/quorum/release state
  - performs real on-chain `release_payment`

5. Keep persistence/auth/SSE/webhooks and fill verification gaps
- Implemented: yes.
- Existing scaffold retained; additional tests added and storage interface verified.

6. Fix config drift and preserve useful prior changes
- Implemented: yes.
- Existing branch history preserved; no destructive reverts.

## 3. Concrete Code Changes Delivered

### A) Real Solana Bridge
File: `api/solana_bridge.py`

Implemented:
- Helius endpoint validation (`helius-rpc.com`, no placeholder key).
- Deterministic task/vault/switch PDA derivation helpers.
- Anchor discriminator generation and instruction payload encoding.
- Methods for each Week 1 instruction with proper account metas.
- Signed instruction submission and confirmation via Solana RPC.
- `task_id` conversion/validation (`64 hex -> 32 bytes`).

### B) API Route Wiring
File: `api/routes/tasks.py`

Implemented:
- Full SHA-256 task IDs.
- On create: persisted task + optional on-chain initialize.
- On run: status gating, optional on-chain selection record + receipt submission.
- On pay: explicit validation and on-chain release payment.
- Event stream payload improvements and persisted transaction metadata.

### C) New Infra Tests
Files:
- `tests/test_solana_bridge.py`
- `tests/test_api_infra_routes.py`

Coverage added:
- health route
- JWT claim extraction (`sub`, email, display name)
- create/list/get task via local store
- run/pay behavior with mocked bridge + error paths
- task-id byte-length and deterministic hashing
- deterministic PDA derivation
- instruction payload discriminator construction
- placeholder Helius URL rejection
- missing keypair failure path

## 4. Existing Infra Pieces Verified as Part of Cross-Check

- Anchor instruction set and account model still aligned with Week 1 requirements.
- Extended TypeScript Anchor test suite still passing (12 cases).
- CI workflow includes Python + Anchor + Docker build checks.
- Deploy workflow includes Cloud Run deployment pipeline.

## 5. Validation Results

### Python
- `ruff check api tests`: passed
- `pytest -q tests/test_api_infra_routes.py tests/test_solana_bridge.py`: 14 passed
- `pytest -q` (full): 48 passed

### Anchor / Solana
- `anchor build`: passed
- `anchor test --provider.cluster localnet --validator legacy`: 12 passing
- `anchor test --provider.cluster devnet`: 12 passing

## 6. Devnet Deploy Evidence

Program deployment succeeded on devnet:
- Upgrade signature: `2gSezeyC4PBhjEHUzjBCFzVCAwvhXTbiHFg398oGTnf7bCwcuiLpF2CZozdM7TAEoakgsg1seRTF9a4Rf3wXBkFX`
- Program ID: `82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd`
- Program authority: `Bij9gHQ1YuZ169YAhJ7YdSzDJ7PMHXV5qzuYJrDrC3JG`
- IDL metadata write completed successfully.

## 7. Service Deployment Status

Cloud Run deployment completed:
- Service: `agora-api`
- Region: `us-central1`
- URL: `https://agora-api-202872251304.us-central1.run.app`
- Ready revision: `agora-api-00007-b5v`
- Traffic: 100%

Artifact Registry repo `agora` was created in `us-central1` to unblock image push.

### Secret Manager Runtime Keypair Loading (Update)

Implemented on 2026-04-12:

- `api/solana_bridge.py` now supports signer loading from either:
  - local file (`SOLANA_KEYPAIR_PATH`), or
  - Google Secret Manager (`SOLANA_KEYPAIR_SECRET_NAME` + project/version)
- Secret payload parsing supports:
  - JSON byte array (recommended),
  - JSON object with `secret_key` / `keypair` / `bytes`,
  - hex or base64 string payloads.
- Loaded signer is cached in-process to avoid repeated secret fetches.
- Configuration is considered valid when Helius is configured and at least one keypair source is available.

Cloud wiring completed:

- Secret created: `agora-solana-devnet-keypair`
- Secret version added from `~/.config/solana/devnet-keypair.json`
- IAM binding added:
  - member: `serviceAccount:202872251304-compute@developer.gserviceaccount.com`
  - role: `roles/secretmanager.secretAccessor`

Cloud Run env now includes:

- `SOLANA_KEYPAIR_SECRET_NAME=agora-solana-devnet-keypair`
- `SOLANA_KEYPAIR_SECRET_PROJECT=even-ally-480821-f3`
- `SOLANA_KEYPAIR_SECRET_VERSION=latest`
- `PROGRAM_ID=82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd`
- `SOLANA_NETWORK=devnet`
- `HELIUS_RPC_URL` from Secret Manager secret `agora-helius-rpc-url`

Hosted E2E verification completed via Cloud Run API:

- `POST /tasks/` -> 200
- `POST /tasks/{task_id}/run` -> 200
- `POST /tasks/{task_id}/pay` -> 200
- final status transitioned to `paid`
- run tx hash: `5SZRCsymSgwvbnqC2b8TY2WqhomUPkmy8PdiQ9DiZHAGKAiJv4g5mmJVgMfBBBa8DZjcjnVuxoHY3C6m94Y2GUy4`
- pay tx hash: `21DAs52BH4X22BiUxtaJo2jm3a7PJdw95nHgDzkjDB81XBNbV3ErG7W2rWFrn7b6kRuDLXHoqXFGsmaGdP8c2Fps`

## 8. Remaining Operational Caveat

No open runtime blockers remain for hosted Week 1 writes.

Operational note:

- Min instances is intentionally set to 0 for cost control (cold starts).
- If faster startup is desired later, set `min-instances=1`.

## 9. Week 1 Checklist Verdict

Overall: Week 1 infra implementation is complete and validated end-to-end for code + contract + devnet testing + Cloud Run hosted writes.

Key acceptance points met:
- Anchor build/test/deploy on devnet
- API scaffold and route contract
- Real instruction bridge path implemented
- Persistence/auth/SSE/webhook scaffold retained and validated
- Docker/CI/deploy pipeline in place and working
- Plan gaps closed and tested

## 10. Gemini GenAI Migration Update (2026-04-13)

Scope:

- Migrated Gemini model calls from Vertex/LangChain path to direct `google-genai` SDK path.
- Added Gemini API key Secret Manager fallback in runtime config.
- Preserved Anthropic direct SDK behavior and existing throttling.

Code/Config updates:

- `agora/agent.py`: Gemini provider now initializes `google.genai.Client` and calls `generate_content` / `generate_content_stream`.
- `agora/config.py`: Gemini key resolution now supports:
  - explicit env (`AGORA_GEMINI_API_KEY`, `GEMINI_API_KEY`, `AGORA_GOOGLE_API_KEY`, `GOOGLE_API_KEY`)
  - Secret Manager fallback (`AGORA_GEMINI_SECRET_NAME`, `AGORA_GEMINI_SECRET_PROJECT`, `AGORA_GEMINI_SECRET_VERSION`)
- `pyproject.toml`: Gemini dependency stack moved to `google-genai`.
- `tests/test_agent.py`, `tests/test_config.py`: Added Gemini migration-specific coverage.

Model defaults updated:

- `AGORA_FLASH_MODEL` default: `gemini-3-flash-preview`
- `AGORA_PRO_MODEL` default: `gemini-3.1-pro-preview`

Cloud deployment and runtime evidence:

- Branch deployed: `codex/gemini-genai-migration`
- Service: `agora-api`
- Ready revision: `agora-api-00009-fqs`
- URL: `https://agora-api-rztfxer7ra-uc.a.run.app`
- Runtime env includes:
  - `AGORA_FLASH_MODEL=gemini-3-flash-preview`
  - `AGORA_PRO_MODEL=gemini-3.1-pro-preview`
  - `AGORA_GEMINI_SECRET_NAME=agora-gemini-api-key`
  - `AGORA_GEMINI_SECRET_PROJECT=even-ally-480821-f3`
  - `AGORA_GEMINI_SECRET_VERSION=latest`

Secret Manager evidence:

- Gemini secret: `agora-gemini-api-key`
- Version: `1` enabled
- Cloud Run service account has `roles/secretmanager.secretAccessor` on this secret.

Validation evidence:

- `ruff check agora api tests`: passed
- `pytest -s -q`: 58 passed
- Hosted API E2E (`create -> run -> pay`): passed against deployed revision
- Direct Gemini SDK checks:
  - `gemini-3-flash-preview`: success (with retry handling observed on transient 503)
  - `gemini-3.1-pro-preview`: success

Demo script updates:

- `scripts/week1_demo.sh` now includes:
  - explicit Gemini 3-series model defaults
  - direct Gemini GenAI SDK smoke validation section
  - `RUN_GEMINI_SMOKE=always|auto|never` control
  - transport retry handling for hosted API smoke calls (to tolerate transient TLS/network EOFs)
  - Gemini key isolation during test phase so pytest remains deterministic
  - summary line for Gemini SDK validation status

Earlier script run evidence (`RUN_GEMINI_SMOKE=always RUN_ANCHOR_CHECKS=never`):

- `Python lint/tests`: PASS
- `Gemini 3 SDK smoke`: PASS
  - flash model: `gemini-3-flash-preview`
  - pro model: `gemini-3.1-pro-preview`
- `Hosted API E2E`: PASS
  - create task: 200
  - run task: 200
  - pay task: 200
  - final status: `paid`
  - pay tx hash: `2rKkkzqVWdra8gwDLnSeVpngg9RCRnLJFijVr2PrgwjeeVTYyryTpJtWKo3Sj9HYUhFAkimTd15iGEmQcCEVkcnR`

Week 1 verification mapping (concrete):

- Core selector/debate/vote/orchestrator path: covered by full Python test suite + orchestrator smoke in script.
- API + Solana bridge path: covered by hosted `POST /tasks`, `/run`, `/pay` E2E and persisted tx hashes.
- Deployment/runtime hardening: confirmed via Cloud Run revision/env/secret bindings.

## 11. GenAI Migration Hardening Follow-Up (2026-04-13)

Scope:

- Preserved the deployed Week 1 Solana program ID as `82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd`; `7XyyHB6ih5MxStBkyYWjbfKUXJTv2sSiecM5XR3ftP3f` was not found on devnet.
- Re-applied fail-closed payment release semantics so short escrow vault balances return `InsufficientVaultBalance` instead of underpaying and marking paid.
- Re-applied lazy FastAPI task-store initialization so route imports do not require ADC/GCS credentials.
- Tightened Gemini Flash caller behavior so Gemini 3 Flash uses explicit minimal thinking rather than falling through to dynamic thinking defaults.
- Hardened the demo script strict mode so Anchor failures stay fatal under `RUN_ANCHOR_CHECKS=always`, local Node/Solana tool paths are discovered, hosted HTTP 5xx responses are retried, and hosted demo tasks include a run nonce to avoid deterministic task-PDA collisions.

Validation evidence:

- `bash -n scripts/week1_demo.sh`: passed
- `git diff --check`: passed
- `python -m ruff check agora api tests`: passed
- `python -m pytest -s -q`: 58 passed
- `cargo test --manifest-path contract/programs/agora/Cargo.toml --release`: 4 passed
- `anchor build && anchor test --provider.cluster localnet --validator legacy`: 12 passed
- Exact strict demo command passed: `RUN_GEMINI_SMOKE=always RUN_CLAUDE_SMOKE=always RUN_ANCHOR_CHECKS=always AGORA_API_URL="https://agora-api-rztfxer7ra-uc.a.run.app" ./scripts/week1_demo.sh --query="Should I buy Solana or BTC?"`
  - Python lint/tests: passed
  - Gemini 3 SDK smoke: passed
  - Claude Sonnet SDK smoke: passed
  - Anchor TS/localnet integration: 12 passed
  - Hosted API E2E (`create -> run -> pay -> paid`): passed
  - Hosted receipt tx: `2p64ddV9hCxkUGx2eS3jMEghJ4NqkhdZddieZHW6zBk7pb7nvsuRJDjKoh1rfAjwLqq5QQRqA5DCGTvu7YwqZAQD`
  - Hosted payment tx: `4Sb2VjXHN7QLaVQjsRVVx2xBzjo5udBFiLmz1khDi1q9jWAifxFxBevFQCzj2ZZoaPRgRVimrVQRW48MN4vhZT7i`
