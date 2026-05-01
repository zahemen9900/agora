# agora-arbitrator-sdk

On-chain multi-agent arbitration for LangGraph, CrewAI, and Python agent systems.

Agora decides whether a task should be resolved by structured debate or confidence-weighted voting, executes the selected mechanism, and returns a verifiable deliberation receipt.

Hosted and local results both expose the same Phase 2 telemetry contract: per-model tokens, input/output/thinking token splits when available, latency, and estimated USD cost.

Maintainer note: the canonical Python source tree lives in `agora/` at the repo
root. The `sdk/` directory exists only as the SDK release wrapper for PyPI
metadata, README content, and build entrypoints.

## Quickstart

```bash
pip install agora-arbitrator-sdk
```

Use the examples that match your runtime:

- Notebook / Colab: use top-level `await`, but do not use top-level `async with`
  or `async for`
- Plain `.py` script: wrap the async body in `main()` and call `asyncio.run(main())`

### Hosted API mode (notebook / Colab)

```python
from agora.sdk import AgoraArbitrator


arbitrator = AgoraArbitrator(auth_token="agora_live_your_public_id.your_secret")
result = await arbitrator.arbitrate("Should we use microservices or a monolith?")

print(result.mechanism_used.value)
print(result.final_answer)
print(result.merkle_root)
await arbitrator.aclose()
```

### Hosted streaming mode (notebook / Colab)

```python
from agora.sdk import AgoraArbitrator


async def stream_events(arbitrator: AgoraArbitrator, task_id: str) -> None:
    async for event in arbitrator.stream_task_events(task_id):
        print(event)


arbitrator = AgoraArbitrator(auth_token="agora_live_your_public_id.your_secret")
created = await arbitrator.create_task(
    "Should we use microservices or a monolith?",
    mechanism="vote",
)
await arbitrator.start_task_run(created.task_id)
await stream_events(arbitrator, created.task_id)
result = await arbitrator.wait_for_task_result(created.task_id)

print(result.model_dump_json(indent=2))
await arbitrator.aclose()
```

Use `wait_for_task_result()` after streaming. It gives you the final result on
success and raises a structured SDK exception if the hosted task fails.

### Hosted task with per-tier model overrides

If you want the hosted runtime to keep the same 4-tier structure but swap the
actual models used for this run, pass `tier_model_overrides` directly:

```python
from agora.sdk import AgoraArbitrator, HostedTierModelOverrides


arbitrator = AgoraArbitrator(auth_token="agora_live_your_public_id.your_secret")
created = await arbitrator.create_task(
    "Should we move this service to async I/O?",
    mechanism="debate",
    tier_model_overrides=HostedTierModelOverrides(
        pro="gemini-2.5-pro",
        flash="gemini-2.5-flash",
        openrouter="openai/gpt-oss-120b",
        claude="claude-haiku-4-5",
    ),
)
await arbitrator.start_task_run(created.task_id)
result = await arbitrator.wait_for_task_result(created.task_id)

print(result.agent_models_used)
await arbitrator.aclose()
```

### Hosted API mode (plain Python script)

```python
import asyncio

from agora.sdk import AgoraArbitrator


async def main() -> None:
    async with AgoraArbitrator(auth_token="agora_live_your_public_id.your_secret") as arbitrator:
        result = await arbitrator.arbitrate("Should we use microservices or a monolith?")
        print(result.mechanism_used.value)
        print(result.final_answer)
        print(result.merkle_root)


if __name__ == "__main__":
    asyncio.run(main())
```

### Local callable mode

```python
from agora.sdk import AgoraArbitrator


async def agent_a(user_prompt: str) -> dict:
    return {
        "answer": "Modular monolith",
        "confidence": 0.78,
        "predicted_group_answer": "Modular monolith",
        "reasoning": "Lower coordination overhead."
    }


arbitrator = AgoraArbitrator(mechanism="vote", agent_count=3)
result = await arbitrator.arbitrate(
    "What architecture should a three-engineer startup use?",
    agents=[agent_a, agent_a, agent_a],
)
print(result.final_answer)
```

### Local explicit model roster

```python
from agora.sdk import (
    AgoraArbitrator,
    HostedBenchmarkRunRequest,
    LocalDebateConfig,
    LocalModelSpec,
    LocalProviderKeys,
)


arbitrator = AgoraArbitrator(
    mechanism="debate",
    local_models=[
        LocalModelSpec(provider="gemini", model="gemini-3-flash-preview"),
        LocalModelSpec(provider="gemini", model="gemini-3.1-flash-lite-preview"),
        LocalModelSpec(provider="anthropic", model="claude-sonnet-4-6"),
    ],
    local_provider_keys=LocalProviderKeys(
        gemini_api_key="your-gemini-key",
        anthropic_api_key="your-anthropic-key",
        openrouter_api_key="your-openrouter-key",
    ),
    local_debate_config=LocalDebateConfig(
        devils_advocate_model=LocalModelSpec(
            provider="openrouter",
            model="qwen/qwen3.5-flash-02-23",
        )
    ),
    allow_offline_fallback=False,
)

result = await arbitrator.arbitrate(
    "Should we start with a monolith or microservices?",
)
print(result.agent_models_used)
print(result.model_dump_json(indent=2))
```

Explicit local roster mode runs the exact model list you pass in roster order.
Do not combine `auth_token=` with `local_models=`. Every provider referenced in
`local_models` or `devils_advocate_model` must also have a key in
`LocalProviderKeys`.

### Local provider keys from environment

```python
import os

from agora.sdk import AgoraArbitrator, LocalProviderKeys


provider_keys = LocalProviderKeys(
    gemini_api_key=os.environ["GEMINI_API_KEY"],
    anthropic_api_key=os.environ["ANTHROPIC_API_KEY"],
    openrouter_api_key=os.environ["OPENROUTER_API_KEY"],
)

arbitrator = AgoraArbitrator(
    mechanism="vote",
    local_provider_keys=provider_keys,
)
```

Use `LocalProviderKeys` whenever you want explicit BYOK control in local mode.
You only need to provide keys for the providers you actually reference in
`local_models` or `local_debate_config`.

### Local 2-provider roster override

If you do not want the default 4-slot balanced preset, pass an explicit roster.
This example uses only Gemini + Claude.

```python
from agora.sdk import AgoraArbitrator, LocalModelSpec, LocalProviderKeys


arbitrator = AgoraArbitrator(
    mechanism="vote",
    agent_count=2,
    local_models=[
        LocalModelSpec(provider="gemini", model="gemini-2.5-pro"),
        LocalModelSpec(provider="anthropic", model="claude-sonnet-4-6"),
    ],
    local_provider_keys=LocalProviderKeys(
        gemini_api_key="your-gemini-key",
        anthropic_api_key="your-anthropic-key",
    ),
    allow_offline_fallback=False,
)
```

### Local 3-provider roster override

This is the cleanest way to mix Gemini, Claude, and one OpenRouter-family model
without carrying the full 4-provider preset.

```python
from agora.sdk import AgoraArbitrator, LocalDebateConfig, LocalModelSpec, LocalProviderKeys


arbitrator = AgoraArbitrator(
    mechanism="debate",
    agent_count=3,
    local_models=[
        LocalModelSpec(provider="gemini", model="gemini-2.5-flash"),
        LocalModelSpec(provider="anthropic", model="claude-haiku-4-5"),
        LocalModelSpec(provider="openrouter", model="qwen/qwen3.5-flash-02-23"),
    ],
    local_provider_keys=LocalProviderKeys(
        gemini_api_key="your-gemini-key",
        anthropic_api_key="your-anthropic-key",
        openrouter_api_key="your-openrouter-key",
    ),
    local_debate_config=LocalDebateConfig(
        devils_advocate_model=LocalModelSpec(
            provider="openrouter",
            model="openai/gpt-oss-120b",
        )
    ),
    allow_offline_fallback=False,
)
```

### Swapping OpenRouter-family models

The OpenRouter lane is model-configurable. These are valid examples for the
same `provider="openrouter"` slot:

- `qwen/qwen3.5-flash-02-23`
- `openai/gpt-oss-120b`
- `google/gemma-4-31b-it`
- `deepseek/deepseek-v3.2-exp`
- `moonshotai/kimi-k2-thinking`

Some OpenRouter models are slower or weaker on structured outputs than others.
If you care about benchmark reliability, prefer the cataloged stable lane first
and promote alternates only after smoke-testing them in your own environment.

### Hosted benchmark runs

Benchmarks use the same bearer-token flow as hosted tasks. Use an Agora API key
for SDK, CI, notebooks, and server-side jobs; the run is persisted under that
key's workspace, so it appears in the dashboard benchmark catalog for the same
workspace.

```python
from agora.sdk import AgoraArbitrator, HostedBenchmarkRunRequest, HostedTierModelOverrides


arbitrator = AgoraArbitrator(auth_token="agora_live_or_test_api_key")
run = await arbitrator.run_benchmark(
    HostedBenchmarkRunRequest(
        agent_count=4,
        live_agents=True,
        training_per_category=1,
        holdout_per_category=1,
        tier_model_overrides=HostedTierModelOverrides(
            pro="gemini-2.5-pro",
            flash="gemini-2.5-flash-lite",
            openrouter="google/gemma-4-31b-it",
            claude="claude-sonnet-4-5",
        ),
    )
)

status = await arbitrator.wait_for_benchmark_run(
    run.run_id,
    timeout_seconds=900,
    poll_interval_seconds=2.0,
)
detail = await arbitrator.get_benchmark_detail(status.artifact_id or run.run_id)

print(status.status)
print(detail.summary)
await arbitrator.aclose()
```

If you want live progress, pair `stream_benchmark_run_events(run_id)` with
`wait_for_benchmark_run(run_id)`. The stream is the event feed; the wait helper
is the terminal-state contract.

### LangGraph integration

```python
from agora.sdk import AgoraNode
from langgraph.graph import StateGraph


graph = StateGraph(dict)
graph.add_node(
    "deliberate",
    AgoraNode(strict_verification=True),
)
```

For long-lived LangGraph workers or repeated node construction, close the wrapped
HTTP client explicitly:

```python
async with AgoraNode() as agora_node:
    state = await agora_node({"task": "Pick the safer deployment plan."})
```

## Features

- Thompson Sampling mechanism selection with explainable reasoning
- Factional debate with LangGraph execution and Devil's Advocate cross-examination
- Confidence-calibrated vote aggregation with ISP weighting
- Merkle-verifiable transcript receipts
- Per-model telemetry and estimated USD cost in hosted and local modes
- Optional hosted API mode, local callable mode, and explicit local model rosters
- Hosted benchmark execution helpers with polling, detail fetch, and SSE streaming

## Authentication

- Dashboard users authenticate with WorkOS-issued bearer tokens.
- SDK, CI, notebooks, and server-side callers should use first-party Agora API keys.
- Hosted mode keeps the same `auth_token=` interface, but the token should be an Agora API key such as `agora_live_<public_id>.<secret>` or `agora_test_<public_id>.<secret>` in non-production environments.
- Strict hosted E2E should use a real staging API key, not a fabricated JWT.
- Benchmark runs, status polling, detail fetches, and event streams accept the same API keys and workspace ownership model as tasks.

## Axiom Observability

The SDK now emits OpenTelemetry spans for hosted task helpers, hosted benchmark
helpers, event streams, and local `arbitrate()` runs. If you already configure
OpenTelemetry in your app, the SDK reuses the active provider. If you want the
SDK to export directly to Axiom, set the same env vars used by the API before
constructing `AgoraArbitrator`:

```bash
export AGORA_AXIOM_ENABLED=true
export AGORA_AXIOM_TOKEN=axiom_xxx
export AGORA_AXIOM_TRACES_DATASET=agora-traces
export AGORA_AXIOM_BASE_URL=https://AXIOM_ORG.axiom.co
export AGORA_AXIOM_CAPTURE_CONTENT=metadata_only
```

By default, capture mode should stay `metadata_only`. The SDK records operation
type, task or benchmark IDs, mechanism, latency, token counts, estimated cost,
and stream counts. It does not send prompts, model outputs, or tool payloads
unless you explicitly switch to `full`.

### Hosted API URL policy

Hosted SDK calls resolve the canonical Cloud Run backend automatically. Do not pass a manual
hosted URL in normal usage. For internal testing only, set `AGORA_ALLOW_API_URL_OVERRIDE=1`
and `AGORA_API_URL=https://your-dev-backend.example.com` before constructing the SDK.

## Verification Controls

- `AgoraArbitrator` defaults to 4-agent hosted execution, the canonical Cloud Run API URL,
  and strict receipt verification.
- `AgoraNode` supports `strict_verification`, `solana_wallet`, and async cleanup pass-through for parity with `AgoraArbitrator`.
- Set `strict_verification=False` only when intentionally opting into lenient verification behavior.

## Maintainer Release Notes

- Current release process is documented in `../docs/release-operations.md`.
- Current package target is `agora-arbitrator-sdk==0.1.0a16`.
- Preferred publish path is the trusted GitHub workflow in `.github/workflows/deploy-sdk.yml`.
