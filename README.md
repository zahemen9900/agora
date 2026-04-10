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

- Gemini models use the latest langchain-google-genai client (ChatGoogleGenerativeAI) in Vertex mode.
- Claude models use Anthropic's direct Python SDK (AsyncAnthropic).

- If GOOGLE_CLOUD_PROJECT and credentials are configured, AGORA attempts live Gemini Vertex calls.
- If ANTHROPIC_API_KEY is configured, AGORA attempts live Claude calls through Anthropic API.
- If calls fail at runtime, engines fall back to deterministic local responses where implemented, so tests and local smoke paths remain reliable.
- If AgentCaller cannot initialize due to missing credentials, that is surfaced clearly in model-layer errors.

## Project Structure

```
agora/
  agent.py               # Unified caller (Gemini via Vertex + Claude via Anthropic SDK)
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
pytest -q
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

Required for live Claude calls:

- ANTHROPIC_API_KEY: your Anthropic API key

Required for live Gemini Vertex calls:

- GOOGLE_CLOUD_PROJECT: your Google Cloud Project ID (string project identifier)

AGORA loads `.env` from the current working directory or repository root if present,
without overriding environment variables already exported in your shell.

Optional model overrides:

- AGORA_FLASH_MODEL (default: gemini-2.5-flash)
- AGORA_PRO_MODEL (default: gemini-2.5-pro)
- AGORA_CLAUDE_MODEL (default: claude-sonnet-4-6)
- AGORA_GOOGLE_CLOUD_LOCATION (default: us-central1)
- AGORA_ANTHROPIC_MAX_TOKENS (default: 1024)
- AGORA_ANTHROPIC_THROTTLE_ENABLED (default: true)
- AGORA_ANTHROPIC_REQUESTS_PER_MINUTE (default: 5)
- AGORA_ANTHROPIC_THROTTLE_WINDOW_SECONDS (default: 60)

The Claude caller uses a shared async sliding-window throttle to reduce Anthropic
429s in multi-agent runs. Tune the throttle variables above to match your org limits.

Not required in the current setup:

- GOOGLE_API_KEY (only needed if you choose non-Vertex Gemini usage later)

Set in shell before running:

```bash
export ANTHROPIC_API_KEY="your-anthropic-api-key"
export GOOGLE_CLOUD_PROJECT="your-project-id"
```

If you enable Claude in vote routing, ensure your Anthropic account has access to the
selected Claude model configured in AGORA_CLAUDE_MODEL, or AGORA will log the model
error and fall back for that voter.

Current code defaults location to us-central1; set AGORA_GOOGLE_CLOUD_LOCATION to
route Gemini calls to a different Vertex region.

Also ensure ADC credentials are available, for example via:

```bash
gcloud auth application-default login
```

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

## Notes

- merkletools is optional for Python 3.11+; deterministic fallback Merkle construction is built in.
- Week 1 supports Debate and Vote only; Delphi and MoA are intentionally deferred.
