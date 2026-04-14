# agora-sdk

On-chain multi-agent arbitration for LangGraph, CrewAI, and Python agent systems.

Agora decides whether a task should be resolved by structured debate or confidence-weighted voting, executes the selected mechanism, and returns a verifiable deliberation receipt.

## Quickstart

```bash
pip install agora-sdk
```

### Hosted API mode

```python
import asyncio

from agora.sdk import AgoraArbitrator


async def main() -> None:
    arbitrator = AgoraArbitrator(
        api_url="https://your-agora-api.example.com",
        auth_token="your-demo-or-api-token",
    )
    result = await arbitrator.arbitrate("Should we use microservices or a monolith?")
    print(result.mechanism_used.value)
    print(result.final_answer)
    print(result.merkle_root)


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
graph.add_node("deliberate", AgoraNode(api_url="https://your-agora-api.example.com"))
```

## Features

- Thompson Sampling mechanism selection with explainable reasoning
- Factional debate with Devil's Advocate cross-examination
- Confidence-calibrated vote aggregation with ISP weighting
- Merkle-verifiable transcript receipts
- Optional hosted API mode and local callable mode
