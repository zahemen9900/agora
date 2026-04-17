# AGORA

On-chain debate-or-vote arbitration for multi-agent LLM systems.

AGORA takes a task, chooses a deliberation mechanism (Debate or Vote), runs multi-agent reasoning, computes convergence and quorum signals, and produces cryptographic transcript artifacts (hashes + Merkle root) that are ready for on-chain receipt submission.

## Current Implementation Status

Detailed implementation tracking lives in:

- `.codex/Progress-update-phase2.md`

### Week 1 Foundation

Implemented:

- Core typed models for task features, mechanism selection, agent outputs, convergence metrics, and final deliberation results.
- Hybrid mechanism selector:
  - Feature extraction
  - Contextual Thompson sampling bandit
  - LLM reasoning wrapper for explainable overrides
- Debate engine with:
  - Faction assignment
  - Devil's advocate cross-exam
  - Rebuttal rounds
  - Claim locking (basic arithmetic verification)
  - Adaptive early termination and switch-to-vote signaling
- Vote engine with:
  - Independent agent votes
  - Confidence calibration (temperature scaling)
  - ISP-weighted aggregation
  - Switch-to-debate signaling when quorum is not reached
- Orchestrator that runs selector -> mechanism -> receipt generation and optional online learning updates.
- Deterministic transcript hashing and Merkle root generation with fallback when merkletools is unavailable.
- CI + lint + test setup.

Current execution note:

- The engines retain LangGraph-compatible graph scaffolding for future integration, but the active Week 1 runtime path is still imperative Python orchestration rather than full StateGraph execution.

### Phase 2 Additions

Implemented on top of the Week 1 foundation:

- Real task lifecycle API:
  - `POST /tasks/`
  - `POST /tasks/{id}/run`
  - `GET /tasks/`
  - `GET /tasks/{id}`
  - `GET /tasks/{id}/stream`
  - `POST /tasks/{id}/pay`
- Persisted selector decisions and replay-safe execution through stored task state.
- Canonical SSE event envelopes with replay + live streaming:
  - `event`
  - `data`
  - `timestamp`
- Benchmark runner, curated datasets, and validation artifact generation under `benchmarks/`.
- SDK surface for local and hosted execution, plus strict receipt verification.
- Dual auth for hosted usage:
  - WorkOS JWTs for dashboard users
  - first-party Agora API keys for SDK, CI, and server-to-server callers
- Provider hardening for dotenv, Secret Manager fallback, and late-bound credential resolution.
- 4-model ensemble support in hosted/demo flows with explicit `agent_models_used` reporting.
- Kimi K2 Thinking integrated as an active ensemble participant:
  - vote diversity tier for 4-agent runs
  - debate cross-exam / devil's-advocate role
  - exposed in runtime/API result metadata
- Hosted mechanism forcing supports either:
  - request payload `mechanism_override=vote|debate`
  - env fallback `AGORA_API_FORCE_MECHANISM=vote|debate`

### Still Deferred / Not Implemented Yet

- SDK-side `agora/solana/client.py` remains a stub; the API-side Solana bridge and contract flow are active.
- Full Delphi and MoA engines (currently stubs for later phases).
- Full LangGraph StateGraph execution as the primary runtime path.
- Final production packaging/publication work for the SDK release channel.

## End-to-End Runtime Flow

1. Input task enters the orchestrator.
2. Selector extracts task features (complexity, topic, disagreement expectation, stakes).
3. Thompson bandit proposes a mechanism and confidence.
4. Reasoning selector produces final mechanism choice + human-readable reasoning + reasoning hash.
5. Orchestrator executes chosen mechanism:
   - Debate path: multi-round adversarial deliberation with convergence checks and optional switch to vote.
   - Vote path: one-round independent voting with calibrated confidence and ISP aggregation, optional switch to debate.
6. Engine returns a DeliberationResult:
   - Final answer
   - Confidence and quorum status
   - Round/mechanism metadata
   - Transcript hashes + Merkle root
   - Token and latency accounting
7. Orchestrator builds a receipt payload from transcript hashes for chain submission.
8. Optional run_and_learn path updates bandit posteriors from supervised (ground truth) or proxy reward.

## Cloud/Model Behavior

Model calls route through the shared AgentCaller abstraction with provider-specific backends.

- Gemini models use the direct Google GenAI SDK (`google-genai`) against Gemini Developer API (ai.google.dev).
- Claude models use Anthropic's direct Python SDK (AsyncAnthropic).
- Kimi models use OpenRouter via OpenAI-compatible AsyncOpenAI client.

- If `AGORA_GEMINI_API_KEY` (or `GEMINI_API_KEY` / `GOOGLE_API_KEY`) is configured, AGORA attempts live Gemini calls.
- If ANTHROPIC_API_KEY is configured, AGORA attempts live Claude calls through Anthropic API.
- If `AGORA_OPENROUTER_API_KEY` (or `OPENROUTER_API_KEY`) is configured, AGORA attempts live Kimi calls through OpenRouter.
- If calls fail at runtime, engines fall back to deterministic local responses where implemented, so tests and local smoke paths remain reliable.
- If AgentCaller cannot initialize due to missing credentials, that is surfaced clearly in model-layer errors.

## Project Structure

```text
agora/
  agent.py               # Unified caller (Gemini + Claude + OpenRouter/Kimi)
  config.py              # Runtime config (models, thresholds, GCP project)
  types.py               # Shared pydantic models and enums
  selector/
    features.py          # Task feature extraction
    bandit.py            # Contextual Thompson sampling
    reasoning.py         # LLM reasoning wrapper
    selector.py          # Combined selection pipeline
  engines/
    debate.py            # Debate mechanism
    vote.py              # Vote mechanism
    delphi.py            # Stub (future)
    moa.py               # Stub (future)
  runtime/
    monitor.py           # Convergence + switch logic
    hasher.py            # Transcript hashing + Merkle root/receipt
    orchestrator.py      # End-to-end execution pipeline
  sdk/
    arbitrator.py        # Public SDK facade (Phase 2 target)
  solana/
    client.py            # Stubbed on-chain client (Josh track)

tests/
  test_bandit.py
  test_agent.py
  test_hasher.py
  test_debate.py
  test_vote.py
  test_orchestrator.py
```

## Local Setup

### Requirements

- Python 3.11+

### Install

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

### Auth configuration

Hosted deployments now use two credential types behind one bearer-token interface:

- Dashboard/browser auth: WorkOS-issued JWTs
- Programmatic auth: Agora API keys in the form `agora_live_<public_id>.<secret>` or `agora_test_<public_id>.<secret>`

Backend auth env:

```bash
export AUTH_REQUIRED=true
export WORKOS_CLIENT_ID="..."
export WORKOS_AUTHKIT_DOMAIN="..."
export AUTH_AUDIENCE="..."
export AUTH_ISSUER="https://your-authkit-domain"
export AUTH_JWKS_URL="https://your-authkit-domain/oauth2/jwks"
export AGORA_API_KEY_PEPPER="replace-with-a-long-random-secret"
```

Optional API key policy env:

```bash
export AGORA_API_KEY_DEFAULT_TTL_DAYS=90
```

### Lint and test

```bash
ruff check .
pytest -s -q
```

### Paid-Provider Integration Tests (Opt-In)

Some vote/debate tests are marked as paid-provider integration checks and require explicit opt-in:

```bash
export RUN_PAID_PROVIDER_TESTS=1
export AGORA_OPENROUTER_API_KEY="..."
pytest -s -q -m paid_integration
```

By default, these tests are skipped to avoid accidental provider spend in routine local and CI runs.

### One-Command Week 1 Demo (Core + Josh Infra)

Use this script to validate Week 1 end-to-end without requiring local Solana tooling:

```bash
./scripts/week1_demo.sh
```

What it covers:

- Runs lint checks for `agora`, `api`, and `tests`
- Runs all Python tests (core modules + API/infra tests)
- Runs a local orchestrator smoke task (your side)
- Runs direct Gemini GenAI SDK smoke checks on configured Flash/Pro models
- Runs direct Kimi/OpenRouter SDK smoke checks on configured Kimi model
- Runs a strict all-model 4-agent vote smoke when `RUN_ALL_MODELS_E2E=always`
- Verifies Kimi appears as an active vote tier and debate challenger, not just a fallback
- Prints `agent_models_used` so the participating ensemble is visible in demo output
- Runs hosted API smoke flow `create -> run -> pay` against Cloud Run (Josh infra side)
- Automatically skips local Anchor/Solana checks when `anchor` or `solana` CLI is missing
- Isolates Gemini API keys from the test phase so `pytest` stays deterministic and fast

Optional controls:

- `AGORA_API_URL`: override hosted API base URL
- `AGORA_TEST_API_KEY`: real staging API key used for hosted smoke and E2E against authenticated deployments
- `--query "text"`: pass the exact deliberation prompt used in orchestrator + hosted API task
- `--api-url "url"`: override hosted API base URL via CLI (same effect as `AGORA_API_URL`)
- `RUN_ANCHOR_CHECKS=always|auto|never`: force or skip local Anchor checks
- `RUN_GEMINI_SMOKE=always|auto|never`: force or skip Gemini SDK smoke checks
- `RUN_CLAUDE_SMOKE=always|auto|never`: force or skip Claude SDK smoke checks
- `RUN_KIMI_SMOKE=always|auto|never`: force or skip Kimi/OpenRouter SDK smoke checks
- `RUN_ALL_MODELS_E2E=always|auto|never`: force or skip one local 4-provider vote ensemble run
- `RUN_HOSTED_API_E2E=always|auto|never`: require hosted `/tasks` flow or downgrade hosted failures to a warning in auto mode
- `RUN_HOSTED_ALL_MODELS_E2E=always|never`: require hosted API to report the full 4-model vote ensemble
- `AGORA_API_FORCE_MECHANISM=vote|debate`: fallback mechanism pin for hosted strict demo validation
- Task create payload field `mechanism_override=vote|debate`: request-level mechanism pin for hosted runs
- `RUN_ORCHESTRATOR_SMOKE=always|auto|never`: control the natural selector-driven local orchestrator smoke
- `DEMO_AGENT_COUNT`: orchestrator/hosted smoke agent count (defaults to 4 unless both Kimi and all-model smokes are disabled)
- `DEMO_ORCHESTRATOR_TIMEOUT_SECONDS`, `DEMO_MODEL_TIMEOUT_SECONDS`, `DEMO_ALL_MODELS_TIMEOUT_SECONDS`: cap live provider waits so demo failures are clean
- `DEMO_ALL_MODELS_MAX_ATTEMPTS`: retry the strict 4-provider vote smoke on transient provider failures
- `DEMO_FLASH_MODEL`: default flash model used by script (defaults to `gemini-3-flash-preview`)
- `DEMO_PRO_MODEL`: default pro model used by script (defaults to `gemini-3.1-pro-preview`)
- `DEMO_CLAUDE_MODEL`: default Claude model used by script (defaults to `claude-sonnet-4-6`)
- `DEMO_KIMI_MODEL`: default Kimi model used by script (defaults to `moonshotai/kimi-k2-thinking`)
- `PYTHON_BIN`: custom Python executable path

Examples:

```bash
# Use default hosted URL, auto-detect local Solana tools
./scripts/week1_demo.sh

# Force local contract checks if you installed Anchor/Solana
RUN_ANCHOR_CHECKS=always ./scripts/week1_demo.sh

# Point to a different deployed API
AGORA_API_URL="https://your-service-url" ./scripts/week1_demo.sh

# Run hosted smoke against an authenticated deployment
AGORA_TEST_API_KEY="agora_test_your_public_id.your_secret" ./scripts/week1_demo.sh

# Enforce direct Gemini 3-series validation in demo
RUN_GEMINI_SMOKE=always ./scripts/week1_demo.sh

# Enforce Kimi via OpenRouter validation in demo
RUN_KIMI_SMOKE=always ./scripts/week1_demo.sh

# Prove Gemini Pro, Kimi, Gemini Flash, and Claude all run in one local vote ensemble
RUN_GEMINI_SMOKE=never RUN_CLAUDE_SMOKE=never RUN_KIMI_SMOKE=never RUN_ALL_MODELS_E2E=always ./scripts/week1_demo.sh

# Keep the demo local-only if hosted auth/runtime is drifting
RUN_GEMINI_SMOKE=never RUN_CLAUDE_SMOKE=never RUN_KIMI_SMOKE=never RUN_ALL_MODELS_E2E=always RUN_HOSTED_API_E2E=never ./scripts/week1_demo.sh

# Pass custom deliberation query from CLI
./scripts/week1_demo.sh --query "Should our team choose debate or vote for incident response decisions?"
```

### Validation Runbook (Recommended)

Use this sequence to verify the migrated stack concretely:

```bash
cd /home/zahemen/projects/dl-lib/agora.worktrees/codex-openrouter-kimi-integration

# 1) Code quality and tests
python -m ruff check agora api tests
python -m pytest -s -q

# Optional paid-provider Kimi/OpenRouter checks
./scripts/run_paid_provider_tests.sh

# 2) Strict local all-provider ensemble proof
RUN_GEMINI_SMOKE=never RUN_CLAUDE_SMOKE=never RUN_KIMI_SMOKE=never RUN_ALL_MODELS_E2E=always ./scripts/week1_demo.sh

# 3) Optional direct provider smokes if you want per-provider diagnostics too
RUN_GEMINI_SMOKE=always RUN_CLAUDE_SMOKE=always RUN_KIMI_SMOKE=always RUN_ALL_MODELS_E2E=never ./scripts/week1_demo.sh

# 4) Strict model, Anchor, and hosted Week 1 E2E demo
export AGORA_API_URL="https://agora-api-rztfxer7ra-uc.a.run.app"
export AGORA_GEMINI_API_KEY="$(gcloud secrets versions access latest --secret agora-gemini-api-key --project even-ally-480821-f3)"
export AGORA_OPENROUTER_API_KEY="$(gcloud secrets versions access latest --secret agora-openrouter-api-key --project even-ally-480821-f3)"
RUN_GEMINI_SMOKE=never RUN_CLAUDE_SMOKE=never RUN_KIMI_SMOKE=never RUN_ALL_MODELS_E2E=always RUN_ANCHOR_CHECKS=always ./scripts/week1_demo.sh

# Optional hosted strict all-model check after deploying the API with AGORA_API_FORCE_MECHANISM=vote
RUN_GEMINI_SMOKE=never RUN_CLAUDE_SMOKE=never RUN_KIMI_SMOKE=never RUN_ALL_MODELS_E2E=always RUN_HOSTED_ALL_MODELS_E2E=always RUN_ANCHOR_CHECKS=always ./scripts/week1_demo.sh
```

Expected demo summary:

- `Python lint/tests`: `PASS`
- `Orchestrator smoke`: `PASS` or `SKIPPED` in auto mode if a provider stalls
- `Gemini 3 SDK smoke`: `PASS`
- `Claude SDK smoke`: `PASS`
- `Kimi K2 SDK smoke`: `PASS`
- `All-model E2E smoke`: `PASS`
- `Local Anchor checks`: `PASS`
- `Hosted API E2E`: `PASS`

### Fixing IAM For Non-Interactive gcloud Auth

If you authenticate with a service-account key file (for example
`/home/zahemen/projects/dl-lib/agora/.credentials/even-ally-480821-f3-be2827895913.json`),
that identity must have Secret Manager access.

Run this once with a privileged principal (Owner or Secret Admin):

```bash
PROJECT_ID="even-ally-480821-f3"
SA_EMAIL="ghsl-storage-accessor@even-ally-480821-f3.iam.gserviceaccount.com"

for SECRET in agora-gemini-api-key agora-anthropic-api-key agora-openrouter-api-key; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --project "$PROJECT_ID" \
    --member "serviceAccount:${SA_EMAIL}" \
    --role "roles/secretmanager.secretAccessor"
done
```

Verification:

```bash
gcloud secrets versions access latest --secret agora-gemini-api-key --project even-ally-480821-f3 >/dev/null
gcloud secrets versions access latest --secret agora-anthropic-api-key --project even-ally-480821-f3 >/dev/null
gcloud secrets versions access latest --secret agora-openrouter-api-key --project even-ally-480821-f3 >/dev/null
```

## Quick Usage

```python
import asyncio

from agora.runtime.orchestrator import AgoraOrchestrator


async def main() -> None:
    orchestrator = AgoraOrchestrator(agent_count=3)
    result = await orchestrator.run("What is the capital of France?")
    print(result.final_answer)
    print(result.confidence, result.quorum_reached)
    print(result.merkle_root)


if __name__ == "__main__":
    asyncio.run(main())
```

### Strict Phase 2 Demo (Hosted Default + Local Strict Option + Devnet)

Use this script to prove the full Phase 2 path with installed SDK + devnet chain checks.
The default target is hosted (Cloud Run) and local strict mode remains available.

Hosted mode (default) validates:

- hosted API health + token auth
- installed-wheel SDK lifecycle (`create -> run -> pay`)
- 4-model ensemble reporting
- receipt verification signals
- initialize/receipt/payment tx confirmation on devnet via Helius

Local mode validates the above plus local bootstrap-only checks:

- local API starts in demo-human mode
- `/auth/me` bootstraps a real personal workspace
- `/api-keys/` creates a real workspace API key
- the API key is revoked and rejected afterward

Run it with:

```bash
python scripts/phase2_demo.py
```

Run strict local bootstrap mode explicitly:

```bash
python scripts/phase2_demo.py --target local
```

What it requires:

- real Gemini, Claude, and OpenRouter/Kimi credentials
- a real Helius devnet RPC URL
- a real Solana keypair source for the API bridge

Credential/bootstrap behavior:

- the script now bootstraps cloud credentials the same way as `week1_demo.sh`:
  - reuses `GOOGLE_APPLICATION_CREDENTIALS` when already set
  - otherwise auto-detects a JSON key under `.credentials/`
  - resolves `GOOGLE_CLOUD_PROJECT` from env, key file, or `gcloud config`
- if model keys are not already exported, it attempts Secret Manager fetch via `gcloud` using defaults:
  - `agora-gemini-api-key`
  - `agora-anthropic-api-key`
  - `agora-openrouter-api-key`
- if `HELIUS_RPC_URL` is missing/placeholder, it attempts Secret Manager fetch from `agora-helius-rpc-url`
- if no local Solana keypair file is present, it defaults to secret-backed keypair config using `agora-solana-devnet-keypair`

Optional secret bootstrap overrides:

- `AGORA_GCLOUD_CREDENTIALS_FILE`
- `AGORA_GEMINI_SECRET_NAME|PROJECT|VERSION`
- `AGORA_ANTHROPIC_SECRET_NAME|PROJECT|VERSION`
- `AGORA_OPENROUTER_SECRET_NAME|PROJECT|VERSION`
- `AGORA_HELIUS_RPC_SECRET_NAME|PROJECT` and `AGORA_HELIUS_RPC_VERSION`
- `AGORA_SOLANA_KEYPAIR_SECRET_NAME`

The strict harness fails closed if the configured Solana network is not `devnet`.

The script intentionally uses fake human auth only in `--target local` bootstrap before
WorkOS is wired. Hosted mode uses a real pre-issued API key.

It writes a machine-readable artifact to:

```bash
benchmarks/results/phase2_demo.json
```

The artifact includes normalized top-level acceptance fields for automation and auditing,
including:

- `workspace_id`
- `api_key_id` and `api_key_public_id`
- `task_id`
- `selected_mechanism`
- `agent_models_used`
- `initialize_tx_hash` / `receipt_tx_hash` / `payment_tx_hash`
- `initialize_explorer_url` / `receipt_explorer_url` / `payment_explorer_url`
- `receipt_verification`
- `final_status` and `payment_status`
- `revocation_proof` and `revoked_key_reuse_status`
- `run_summary` (compact operator-facing verdict)
- `event_timeline` (event counts, first/last timestamps, event excerpts)
- `status_snapshots` (create/run/pay status deltas)
- `acceptance_checks` (boolean checks for txs, status transitions, receipt signals)

Optional controls:

- `--target hosted|local` (default: hosted)
- `--api-url https://...` hosted API URL for `--target hosted`
- `--auth-token agora_test_<id>.<secret>` (or export `AGORA_TEST_API_KEY`) for hosted mode
- `--bootstrap-if-missing-token` / `--no-bootstrap-if-missing-token`
- `--bootstrap-jwt-token <human_jwt>` (or export `AGORA_PHASE2_BOOTSTRAP_JWT`)
- `--bootstrap-key-name <name>` API key name when bootstrap creates a key
- `--bootstrap-store-secret` / `--no-bootstrap-store-secret`
- `--bootstrap-secret-name <secret>` and `--bootstrap-secret-project <project>`
- `--http-timeout-seconds <seconds>` hosted preflight timeout (default: 30)
- `--http-retries <count>` hosted preflight retry attempts (default: 3)
- `--output /path/to/artifact.json`
- `--query "text"` to override the default deterministic quorum-friendly prompt
- strict defaults are enforced as `--stakes 0.01`, `--agent-count 4`, and `--mechanism vote`
- to override those for debugging, add `--allow-unsafe-overrides` together with:
  - `--stakes <value>`
  - `--agent-count <value>`
  - `--mechanism vote|debate`
- `--verbose` to print detailed deliberation/result summaries in terminal
- `--keep-temp`

Hosted auth setup notes:

- Hosted mode first tries: `--auth-token` -> env token -> Secret Manager token lookup.
- If no hosted token is found and bootstrap is enabled (default), the script can now:
  - call `/auth/me` with a human JWT
  - create a new workspace API key via `/api-keys/`
  - store that key in Secret Manager
  - continue the same hosted demo run using the new key
- Bootstrap requires a human JWT because `/api-keys/*` is a human-authenticated surface.
- API-key tokens are accepted for task execution, but cannot mint additional API keys.

Hosted auth bootstrap example (fully automated key create + store + run):

```bash
export AGORA_API_URL="https://agora-api-rztfxer7ra-uc.a.run.app"
export GOOGLE_CLOUD_PROJECT="even-ally-480821-f3"
export AGORA_PHASE2_BOOTSTRAP_JWT="<human-workos-jwt>"

# This run auto-creates a workspace API key, persists it to Secret Manager,
# then uses it for the strict hosted flow.
python scripts/phase2_demo.py \
  --target hosted \
  --bootstrap-secret-name agora-test-api-key \
  --bootstrap-secret-project "$GOOGLE_CLOUD_PROJECT"
```

The SDK receipt check in this demo uses `verify_receipt(strict=False)` and requires:

- `merkle_match == true`
- `hosted_metadata_match == true`

Real chain proof verification is still not implemented inside the SDK, so the demo separately
confirms the initialize-task, receipt-submission, and release-payment transactions through Helius.

## Environment Variables

Required for live Claude calls (choose one):

- ANTHROPIC_API_KEY: your Anthropic API key
- Secret Manager access to the shared secret (default name: agora-anthropic-api-key)

Required for live Gemini Developer API calls:

- AGORA_GEMINI_API_KEY: preferred Gemini API key env var
- GEMINI_API_KEY: fallback key env var
- GOOGLE_API_KEY: fallback key env var

Required for live Kimi/OpenRouter calls:

- AGORA_OPENROUTER_API_KEY: preferred OpenRouter API key env var
- OPENROUTER_API_KEY: fallback key env var

AGORA loads `.env` from the current working directory or repository root if present,
without overriding environment variables already exported in your shell.

To load a dotenv file from another path (for example a sibling worktree), set:

- AGORA_ENV_FILE=/absolute/path/to/.env

If Secret Manager client credentials are not configured as ADC, AGORA also attempts
`gcloud secrets versions access ...` as a fallback for secret-backed key resolution.

API auth verification settings (WorkOS/AuthKit):

- AUTH_REQUIRED (default: true)
- WORKOS_CLIENT_ID (used as default audience when AUTH_AUDIENCE is unset)
- WORKOS_AUTHKIT_DOMAIN (for example your-subdomain.authkit.app)
- AUTH_ISSUER (optional explicit override)
- AUTH_AUDIENCE (optional explicit override)
- AUTH_JWKS_URL (optional explicit override; default: `${AUTH_ISSUER}/oauth2/jwks`)
- AGORA_LOCAL_DATA_DIR (optional local API persistence root; default: `api/data`)

Optional model overrides:

- AGORA_FLASH_MODEL (default: gemini-3-flash-preview)
- AGORA_PRO_MODEL (default: gemini-3.1-pro-preview)
- DEMO_PRO_MODEL (default: gemini-2.5-pro for `week1_demo.sh`)
- AGORA_GEMINI_FLASH_THINKING_LEVEL (default: minimal; set empty to use the provider default)
- AGORA_CLAUDE_MODEL (default: claude-sonnet-4-6)
- AGORA_KIMI_MODEL (default: moonshotai/kimi-k2-thinking)
- AGORA_GOOGLE_CLOUD_LOCATION (default: us-central1)
- AGORA_OPENROUTER_BASE_URL (default: https://openrouter.ai/api/v1)
- AGORA_OPENROUTER_HTTP_REFERER (optional OpenRouter app attribution header)
- AGORA_OPENROUTER_APP_TITLE (default: Agora Protocol)
- AGORA_OPENROUTER_LEGACY_X_TITLE_ENABLED (default: true; also sends legacy `X-Title`)
- AGORA_KIMI_REASONING_EFFORT (default: low)
- AGORA_KIMI_REASONING_EXCLUDE (default: true)
- AGORA_KIMI_MAX_TOKENS (default: 512)
- AGORA_ANTHROPIC_MAX_TOKENS (default: 1024)
- AGORA_ANTHROPIC_THROTTLE_ENABLED (default: true)
- AGORA_ANTHROPIC_REQUESTS_PER_MINUTE (default: 5)
- AGORA_ANTHROPIC_THROTTLE_WINDOW_SECONDS (default: 60)
- AGORA_KIMI_MAX_TOKENS (default: 512)
- AGORA_KIMI_REASONING_EFFORT (default: low)
- AGORA_KIMI_REASONING_EXCLUDE (default: true)
- AGORA_OPENROUTER_HTTP_REFERER (optional attribution header)
- AGORA_OPENROUTER_APP_TITLE (default: Agora Protocol)
- AGORA_OPENROUTER_LEGACY_X_TITLE_ENABLED (default: true; keeps compatibility with legacy X-Title)
- AGORA_API_FORCE_MECHANISM (default: empty; set `vote` on the hosted API to pin the 4-model demo run)

Anthropic Secret Manager fetch controls:

- AGORA_ANTHROPIC_SECRET_NAME (default: agora-anthropic-api-key)
- AGORA_ANTHROPIC_SECRET_PROJECT (default: GOOGLE_CLOUD_PROJECT)
- AGORA_ANTHROPIC_SECRET_VERSION (default: latest)

OpenRouter Secret Manager fetch controls:

- AGORA_OPENROUTER_SECRET_NAME (default: agora-openrouter-api-key)
- AGORA_OPENROUTER_SECRET_PROJECT (default: GOOGLE_CLOUD_PROJECT)
- AGORA_OPENROUTER_SECRET_VERSION (default: latest)

Gemini Secret Manager fetch controls:

- AGORA_GEMINI_SECRET_NAME (default: agora-gemini-api-key)
- AGORA_GEMINI_SECRET_PROJECT (default: GOOGLE_CLOUD_PROJECT)
- AGORA_GEMINI_SECRET_VERSION (default: latest)

OpenRouter Secret Manager fetch controls:

- AGORA_OPENROUTER_SECRET_NAME (default: agora-openrouter-api-key)
- AGORA_OPENROUTER_SECRET_PROJECT (default: GOOGLE_CLOUD_PROJECT)
- AGORA_OPENROUTER_SECRET_VERSION (default: latest)

To let AGORA fetch Gemini key directly from Secret Manager (no local API key export):

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
export AGORA_GEMINI_SECRET_NAME="agora-gemini-api-key"
unset AGORA_GEMINI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY
```

Solana/Week 1 API runtime variables:

- HELIUS_RPC_URL: required real Helius endpoint for on-chain writes
- PROGRAM_ID: deployed Agora program id
- SOLANA_NETWORK: cluster name, default devnet
- SOLANA_KEYPAIR_PATH: local keypair file path (default ~/.config/solana/devnet-keypair.json)
- SOLANA_KEYPAIR_SECRET_NAME: optional Secret Manager secret containing keypair bytes/json
- SOLANA_KEYPAIR_SECRET_PROJECT: optional secret project, falls back to GOOGLE_CLOUD_PROJECT
- SOLANA_KEYPAIR_SECRET_VERSION: optional secret version, default latest
- STRICT_CHAIN_WRITES: set `true` to fail the request when chain writes fail

Secret-backed keypair payload formats accepted by the API bridge:

- JSON byte array (recommended): `[12,34,...]`
- JSON object with one of: `secret_key`, `keypair`, `bytes`
- raw hex string or base64 string

Week 1 bridge behavior:

- Local/dev shell uses SOLANA_KEYPAIR_PATH when the file exists.
- Cloud Run can omit local keypair files and load keypair material from Secret Manager.
- If neither source is configured, on-chain write endpoints fail closed with a clear runtime error.

Cloud Run keypair setup example:

```bash
PROJECT_ID="even-ally-480821-f3"
SERVICE_ACCOUNT="202872251304-compute@developer.gserviceaccount.com"
SECRET_NAME="agora-solana-devnet-keypair"

gcloud secrets create "$SECRET_NAME" --replication-policy=automatic --project "$PROJECT_ID"
gcloud secrets versions add "$SECRET_NAME" --data-file "$HOME/.config/solana/devnet-keypair.json" --project "$PROJECT_ID"
gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --member "serviceAccount:${SERVICE_ACCOUNT}" \
  --role "roles/secretmanager.secretAccessor" \
  --project "$PROJECT_ID"

gcloud run services update agora-api \
  --region us-central1 \
  --project "$PROJECT_ID" \
  --update-env-vars "SOLANA_KEYPAIR_SECRET_NAME=${SECRET_NAME},SOLANA_KEYPAIR_SECRET_PROJECT=${PROJECT_ID},SOLANA_KEYPAIR_SECRET_VERSION=latest,PROGRAM_ID=82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd,SOLANA_NETWORK=devnet,HELIUS_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_REAL_KEY,AGORA_API_USE_REAL_ORCHESTRATOR=true,AGORA_API_FORCE_MECHANISM=vote" \
  --update-secrets "AGORA_GEMINI_API_KEY=agora-gemini-api-key:latest,ANTHROPIC_API_KEY=agora-anthropic-api-key:latest,AGORA_OPENROUTER_API_KEY=agora-openrouter-api-key:latest"
```

The Claude caller uses a shared async sliding-window throttle to reduce Anthropic
429s in multi-agent runs. Tune the throttle variables above to match your org limits.

Not required in the current setup:

- GOOGLE_CLOUD_PROJECT for Gemini API calls (still useful for Secret Manager flows)

Set in shell before running:

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"

# Option A: fetch key into shell from Secret Manager
export SECRET_NAME="agora-anthropic-api-key"
export ANTHROPIC_API_KEY="$(gcloud secrets versions access latest \
  --project "$GOOGLE_CLOUD_PROJECT" \
  --secret "$SECRET_NAME")"
```

### Fetch Anthropic Key From Google Secret Manager

Teammate fetches key into shell before running AGORA:

```bash
PROJECT_ID="$(gcloud config get-value project)"
SECRET_NAME="agora-anthropic-api-key"

export ANTHROPIC_API_KEY="$(gcloud secrets versions access latest \
  --project "$PROJECT_ID" \
  --secret "$SECRET_NAME")"
```

Or let AGORA fetch directly from Secret Manager at runtime (no local `.env` key):

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
export AGORA_ANTHROPIC_SECRET_NAME="agora-anthropic-api-key"
unset ANTHROPIC_API_KEY
```

Note: if your organization enforces periodic reauthentication, run
`gcloud auth login` before fetching secrets.

If you enable Claude in vote routing, ensure your Anthropic account has access to the
selected Claude model configured in AGORA_CLAUDE_MODEL, or AGORA will log the model
error and fall back for that voter.

Gemini API keys are managed from ai.google.dev. If needed, you can keep the key in
Secret Manager and export it before running AGORA.

OpenRouter keys can be kept in Secret Manager with `agora-openrouter-api-key` and
fetched automatically at runtime, or exported directly as `AGORA_OPENROUTER_API_KEY`.
The local/service-account path has verified access to that secret; Cloud Run service
environment/IAM inspection may still require a privileged GCP identity.

## Next Tasks for Josh

The codebase already marks the Solana responsibilities as Josh-owned in the client stubs.

1. Implement solana/client.py methods:
   - submit_receipt
   - record_mechanism_switch
   - get_task_status
2. Define final on-chain receipt schema and mapping:
   - Align runtime receipt fields (merkle_root, final_answer_hash, mechanism, round metadata)
   - Ensure deterministic task_id/decision_hash conventions
3. Wire orchestrator -> Solana submission path:
   - Submit receipt after successful deliberation
   - Persist tx signature and status in returned metadata/logs
4. Add reliability and observability around chain writes:
   - Retry/backoff policy
   - Idempotency for duplicate submissions
   - Structured error codes
5. Add integration tests with a Solana test validator or RPC sandbox.
6. Expose API endpoints (if in Josh scope) for:
   - Submit task
   - Query task status
   - Fetch finalized receipt and tx signature

## Operations Runbooks

- Release and deploy operations: `docs/release-operations.md`
- Week 2 frontend acceptance report: `.codex/Week2-frontend-acceptance.md`
- Week 2 API acceptance trace artifact: `.codex/week2_acceptance_api_trace.json`

## Notes

- merkletools is optional for Python 3.11+; deterministic fallback Merkle construction is built in.
- Week 1 supports Debate and Vote only; Delphi and MoA are intentionally deferred.
