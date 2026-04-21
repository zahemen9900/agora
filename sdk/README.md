# agora-arbitrator-sdk

On-chain multi-agent arbitration for LangGraph, CrewAI, and Python agent systems.

Agora decides whether a task should be resolved by structured debate or confidence-weighted voting, executes the selected mechanism, and returns a verifiable deliberation receipt.

Hosted and local results both expose the same Phase 2 telemetry contract: per-model tokens, input/output/thinking token splits when available, latency, and estimated USD cost.

## Quickstart

```bash
pip install agora-arbitrator-sdk
```

### Hosted API mode

```python
import asyncio

from agora.sdk import AgoraArbitrator


async def main() -> None:
    async with AgoraArbitrator(auth_token="agora_live_your_public_id.your_secret") as arbitrator:
        result = await arbitrator.arbitrate("Should we use microservices or a monolith?")
    print(result.mechanism_used.value)
    print(result.final_answer)
    print(result.merkle_root)


asyncio.run(main())
```

### Hosted streaming mode

```python
import asyncio

from agora.sdk import AgoraArbitrator


async def main() -> None:
    async with AgoraArbitrator(auth_token="agora_live_your_public_id.your_secret") as arbitrator:
        created = await arbitrator.create_task(
            "Should we use microservices or a monolith?",
            mechanism="vote",
        )
        await arbitrator.start_task_run(created.task_id)

        async for event in arbitrator.stream_task_events(created.task_id):
            print(event)

        result = await arbitrator.get_task_result(created.task_id)
    print(result.model_dump_json(indent=2))


asyncio.run(main())
```

### Local callable mode

```python
import asyncio

from agora.sdk import AgoraArbitrator


async def agent_a(user_prompt: str) -> dict:
    return {
        "answer": "Modular monolith",
        "confidence": 0.78,
        "predicted_group_answer": "Modular monolith",
        "reasoning": "Lower coordination overhead."
    }


async def main() -> None:
    arbitrator = AgoraArbitrator(mechanism="vote", agent_count=3)
    result = await arbitrator.arbitrate(
        "What architecture should a three-engineer startup use?",
        agents=[agent_a, agent_a, agent_a],
    )
    print(result.final_answer)


asyncio.run(main())
```

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
- Optional hosted API mode and local callable mode

## Authentication

- Dashboard users authenticate with WorkOS-issued bearer tokens.
- SDK, CI, notebooks, and server-side callers should use first-party Agora API keys.
- Hosted mode keeps the same `auth_token=` interface, but the token should be an Agora API key such as `agora_live_<public_id>.<secret>` or `agora_test_<public_id>.<secret>` in non-production environments.
- Strict hosted E2E should use a real staging API key, not a fabricated JWT.

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
- Current package target is `agora-arbitrator-sdk==0.1.0a1`.
- This cycle keeps PyPI publish manual while documenting the next-cycle automation plan.
