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
            model="moonshotai/kimi-k2-thinking",
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

### Hosted benchmark runs

Benchmarks are available through the SDK, but they use the benchmark API
surface, which currently requires a human bearer token. Use a WorkOS-backed
human session token here, not an Agora API key.

```python
from agora.sdk import AgoraArbitrator, HostedBenchmarkRunRequest


arbitrator = AgoraArbitrator(auth_token="workos_or_human_bearer_token")
run = await arbitrator.run_benchmark(
    HostedBenchmarkRunRequest(
        agent_count=4,
        live_agents=True,
        training_per_category=1,
        holdout_per_category=1,
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
- Benchmark endpoints are the exception: they currently require a human bearer token and reject API-key principals.

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
- Current package target is `agora-arbitrator-sdk==0.1.0a5`.
- Preferred publish path is the trusted GitHub workflow in `.github/workflows/deploy-sdk.yml`.
