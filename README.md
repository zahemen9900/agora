# <p align="center"><img src="agora-web/public/agora-logo.png" alt="Agora logo" width="140" /></p>

<p align="center">
  <strong>Tool-augmented multi-agent deliberation with auditable receipts.</strong>
</p>

<p align="center">
  <a href="https://pypi.org/project/agora-arbitrator-sdk/"><img src="https://img.shields.io/pypi/v/agora-arbitrator-sdk?label=PyPI&color=14b8a6" alt="PyPI version" /></a>
  <img src="https://img.shields.io/pypi/pyversions/agora-arbitrator-sdk?color=0ea5e9" alt="Python versions" />
  <img src="https://img.shields.io/badge/mechanisms-debate%20%7C%20vote%20%7C%20delphi-8b5cf6" alt="Mechanisms" />
  <img src="https://img.shields.io/badge/license-MIT-f59e0b" alt="MIT license" />
</p>

Agora is an arbitration and deliberation runtime for LLM systems. It can:

- select a mechanism per task: `debate`, `vote`, or `delphi`
- ground reasoning with Brave search, attached URLs, and uploaded sources
- run sandboxed Python for tabular analysis and verification
- emit live event streams, citations, evidence, and telemetry
- produce Merkle-rooted receipts and optional Solana settlement metadata

This repo contains the backend, the Python SDK, the hosted dashboard, the benchmark runner, and the on-chain integration surface.

## What is live right now

Agora is no longer just a bare orchestrator. The current system includes:

- **Hosted deliberation** on the canonical backend: [https://agora-api-b4auawqzbq-uc.a.run.app](https://agora-api-b4auawqzbq-uc.a.run.app)
- **Local BYOK execution** through the Python SDK with explicit provider rosters
- **Three deliberation mechanisms**:
  - `debate` for adversarial multi-factor tradeoffs
  - `vote` for independent answer aggregation
  - `delphi` for revision-driven convergence
- **Tool-augmented reasoning**:
  - Brave web search and URL grounding
  - OpenRouter-backed PDF and image analysis
  - sandboxed Python with `pandas`, `polars`, `duckdb`, `pyarrow`, spreadsheet readers, and standard data tooling
- **Sources and attachments**:
  - `source_urls`
  - hosted uploaded files via `source_file_ids`
- **Auditable outputs**:
  - Merkle-rooted transcript receipts
  - evidence items
  - citation items
  - per-model token, latency, and cost telemetry
- **Hosted API keys** for SDK and server-to-server access
- **Benchmarks** for domain-specific evaluation and artifact generation

## Install

The published package is:

```bash
pip install agora-arbitrator-sdk
```

Optional companion installs:

```bash
# LangGraph is already a core dependency of the SDK.
# For CrewAI workflows, install CrewAI separately.
pip install crewai
```

Python `3.11+` is required.

## Fast start: hosted mode

Hosted mode is the simplest production path. You authenticate with an Agora API key such as:

- `agora_live_<public_id>.<secret>`
- `agora_test_<public_id>.<secret>`

```python
import asyncio
from agora.sdk import AgoraArbitrator


async def main() -> None:
    async with AgoraArbitrator(
        auth_token="agora_live_xxxxx.yyyyy",
    ) as arbitrator:
        created = await arbitrator.create_task(
            task="Should we expand to APAC next quarter?",
            agent_count=4,
            source_urls=[
                "https://www.imf.org/",
            ],
        )

        result = await arbitrator.run_task(created.task_id)
        print(result.mechanism)
        print(result.final_answer)
        print(result.confidence)
        print(result.merkle_root)
        print(result.tool_usage_summary)
        print(result.citation_items[:3])


asyncio.run(main())
```

Important hosted defaults:

- `agent_count = 4`
- `quorum_threshold = 0.6`
- `enable_tools = True`
- `max_tool_calls_per_agent = 4`
- `max_urls_per_call = 5`
- `max_files_per_call = 3`
- `execution_timeout_seconds = 20`

## Fast start: local BYOK mode

Local mode runs the orchestrator in-process and uses your own provider credentials and roster.

```python
import asyncio

from agora.sdk import AgoraArbitrator
from agora.types import LocalModelSpec, LocalProviderKeys


async def main() -> None:
    async with AgoraArbitrator(
        local_models=[
            LocalModelSpec(provider="gemini", model="gemini-3.1-flash-lite-preview"),
            LocalModelSpec(provider="anthropic", model="claude-sonnet-4-6"),
            LocalModelSpec(provider="openrouter", model="qwen/qwen3.5-flash-02-23"),
            LocalModelSpec(provider="gemini", model="gemini-3-flash-preview"),
        ],
        local_provider_keys=LocalProviderKeys(
            gemini_api_key="...",
            anthropic_api_key="...",
            openrouter_api_key="...",
        ),
        agent_count=4,
    ) as arbitrator:
        result = await arbitrator.arbitrate(
            "Should a regulated fintech choose a monolith or microservices for its next 12 months?"
        )
        print(result.mechanism_used)
        print(result.final_answer)
        print(result.total_latency_ms)
        print(result.citation_items)


asyncio.run(main())
```

Use local mode when you want:

- direct provider control
- custom participant rosters
- no dependency on the hosted task lifecycle
- in-process integration with LangGraph or a custom CrewAI workflow

## Auth model

There are two distinct auth paths:

- **Dashboard / browser flows** use WorkOS-issued JWTs
- **SDK / programmatic hosted flows** should use Agora API keys

If you are building against the hosted REST API directly, both patterns exist in the system, but the SDK is built around Agora API keys for machine callers.

## Sources, tools, and files

Hosted tasks can include:

- `source_urls`: public URLs
- `source_file_ids`: files already registered through the hosted sources flow

Current tool stack:

- `search_online` via Brave
- `analyze_urls` for URL-grounded synthesis
- `analyze_file` for PDFs and images
- `execute_python` for tabular/code analysis in a sandbox

Current sandbox data stack includes:

- `pandas`
- `numpy`
- `polars`
- `duckdb`
- `pyarrow`
- `openpyxl`
- `xlrd`
- `pyxlsb`
- `scipy`
- `matplotlib`
- `seaborn`

Supported high-value analysis formats today:

- `.csv`
- `.tsv`
- `.xlsx`
- `.xls`
- `.xlsb`
- `.parquet`
- `.pdf`
- images
- plain text and code files

Not first-class today:

- `.docx`
- `.ods`
- archives
- arbitrary binaries

## Hosted result surface

The hosted API returns task lifecycle payloads and final results with:

- `mechanism`
- `final_answer`
- `confidence`
- `quorum_reached`
- `merkle_root`
- `decision_hash`
- `latency_ms`
- `sources`
- `tool_usage_summary`
- `evidence_items`
- `citation_items`
- `payment_status`
- `chain_operations`
- `selector_source`
- `selector_fallback_path`
- `mechanism_override_source`

Local `DeliberationResult` objects are slightly different and still expose fields such as:

- `mechanism_used`
- `total_latency_ms`
- `tool_usage_summary`
- `citation_items`

That distinction matters. Hosted and local surfaces are deliberately close, but not identical.

## Benchmarks

The SDK also supports hosted benchmark execution and artifact retrieval. That includes:

- running benchmarks with tier overrides and reasoning presets
- polling benchmark status
- streaming benchmark events
- retrieving benchmark item details and artifact-backed results

If you care about model routing quality or provider cost/performance tradeoffs, use the benchmark layer instead of guessing.

## Repo layout

```text
agora/
  agent.py
  config.py
  selector/
  engines/
  runtime/
  tools/
  sdk/
  solana/

api/
  main.py
  routes/
  models.py
  source_storage.py

agora-web/
  src/
  public/

sandbox_runner_service/
  app.py
  runtime-image.Dockerfile

benchmarks/
tests/
docs/
```

## Local development

Backend:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
ruff check .
pytest -q -s
```

Frontend:

```bash
./scripts/with_wsl_node.sh npm --prefix agora-web run build
```

## Docs

Primary docs live in the dashboard docs surface and source files under:

- [/home/zahemen/projects/dl-lib/agora.worktrees/main-sync/agora-web/src/docs](/home/zahemen/projects/dl-lib/agora.worktrees/main-sync/agora-web/src/docs)

Key entry points:

- `/docs`
- `/docs/installation`
- `/docs/quickstart`
- `/docs/sdk/python`
- `/docs/sdk/api`

## Opinionated notes

- Use **hosted mode** if you want sources, uploads, task lifecycle, streaming, API keys, benchmarks, and the full product surface.
- Use **local mode** if you want deterministic provider control and tighter in-process integration.
- Do not treat multi-agent reasoning as enough by itself. The tool stack is the difference between eloquent guessing and grounded synthesis.
- If you are not using citations, evidence items, and receipts for critical paths, you are leaving most of Agora’s value on the table.
