# AGORA

On-chain debate-or-vote arbitration for multi-agent LLM systems.

AGORA takes a task, chooses a deliberation mechanism (Debate or Vote), runs multi-agent reasoning, computes convergence and quorum signals, and produces cryptographic transcript artifacts (hashes + Merkle root) that are ready for on-chain receipt submission.

## Current Week 1 Status

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

Not implemented yet:

- Real Solana integration (currently stubbed).
- Full Delphi and MoA engines (currently stubs for later phases).

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
- Runs hosted API smoke flow `create -> run -> pay` against Cloud Run (Josh infra side)
- Automatically skips local Anchor/Solana checks when `anchor` or `solana` CLI is missing
- Isolates Gemini API keys from the test phase so `pytest` stays deterministic and fast

Optional controls:

- `AGORA_API_URL`: override hosted API base URL
- `--query "text"`: pass the exact deliberation prompt used in orchestrator + hosted API task
- `--api-url "url"`: override hosted API base URL via CLI (same effect as `AGORA_API_URL`)
- `RUN_ANCHOR_CHECKS=always|auto|never`: force or skip local Anchor checks
- `RUN_GEMINI_SMOKE=always|auto|never`: force or skip Gemini SDK smoke checks
- `RUN_CLAUDE_SMOKE=always|auto|never`: force or skip Claude SDK smoke checks
- `RUN_KIMI_SMOKE=always|auto|never`: force or skip Kimi/OpenRouter SDK smoke checks
- `DEMO_AGENT_COUNT`: orchestrator smoke agent count (defaults to 4 when Kimi smoke is enabled)
- `DEMO_FLASH_MODEL`: default flash model used by script (defaults to `gemini-3-flash-preview`)
- `DEMO_PRO_MODEL`: default pro model used by script (defaults to `gemini-3.1-pro-preview`)
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

# Enforce direct Gemini 3-series validation in demo
RUN_GEMINI_SMOKE=always ./scripts/week1_demo.sh

# Pass custom deliberation query from CLI
./scripts/week1_demo.sh --query "Should our team choose debate or vote for incident response decisions?"
```

### Validation Runbook (Recommended)

Use this sequence to verify the migrated stack concretely:

```bash
cd /home/zahemen/projects/dl-lib/agora.worktrees/codex-gemini-genai-migration

# 1) Code quality and tests
python -m ruff check agora api tests
python -m pytest -s -q

# 2) Strict model, Anchor, and hosted Week 1 E2E demo
export AGORA_API_URL="https://agora-api-rztfxer7ra-uc.a.run.app"
export AGORA_GEMINI_API_KEY="$(gcloud secrets versions access latest --secret agora-gemini-api-key --project even-ally-480821-f3)"
export AGORA_OPENROUTER_API_KEY="$(gcloud secrets versions access latest --secret agora-openrouter-api-key --project even-ally-480821-f3)"
RUN_GEMINI_SMOKE=always RUN_CLAUDE_SMOKE=always RUN_KIMI_SMOKE=always RUN_ANCHOR_CHECKS=always ./scripts/week1_demo.sh
```

Expected demo summary:

- `Python lint/tests`: `PASS`
- `Gemini 3 SDK smoke`: `PASS`
- `Claude SDK smoke`: `PASS`
- `Kimi K2 SDK smoke`: `PASS`
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

Optional model overrides:

- AGORA_FLASH_MODEL (default: gemini-3-flash-preview)
- AGORA_PRO_MODEL (default: gemini-3.1-pro-preview)
- AGORA_GEMINI_FLASH_THINKING_LEVEL (default: minimal; set empty to use the provider default)
- AGORA_CLAUDE_MODEL (default: claude-sonnet-4-6)
- AGORA_KIMI_MODEL (default: moonshotai/kimi-k2-thinking)
- AGORA_GOOGLE_CLOUD_LOCATION (default: us-central1)
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
  --update-env-vars "SOLANA_KEYPAIR_SECRET_NAME=${SECRET_NAME},SOLANA_KEYPAIR_SECRET_PROJECT=${PROJECT_ID},SOLANA_KEYPAIR_SECRET_VERSION=latest,PROGRAM_ID=82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd,SOLANA_NETWORK=devnet,HELIUS_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_REAL_KEY"
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
