# Joshua Briefing

Last updated: Saturday 11:49am, 04/11/2026

## What AGORA Actually Is

AGORA is a Python runtime for multi-agent task arbitration.
It decides whether a task should be resolved by structured debate or voting, runs that mechanism, hashes the transcript, and produces a receipt that is intended to be committed on-chain.

The important distinction is this:

| Layer | Reality today |
|---|---|
| Multi-agent runtime | Implemented in this repo |
| Cryptographic receipt generation | Implemented in this repo |
| Solana settlement | Not implemented in this repo |
| FastAPI bridge | Not implemented in this repo |
| Frontend dashboard | Not implemented in this repo |

So the repo is not the whole product. It is the deliberation core plus a placeholder for integration.

## What You Need To Know First

| Topic | What matters |
|---|---|
| Core value proposition | "Proof-of-Deliberation": not just an answer, but a verifiable reasoning trail with transcript hashes and Merkle root. |
| Main research claim | Naive debate is weak; the system tries to improve on that with mechanism selection, factional debate, adaptive termination, and ISP-weighted voting. |
| Current system truth | The runtime mostly matches the Week 1 core described in the PDFs. The larger product story does not yet match the codebase. |
| Highest-risk mismatch | The docs talk like AGORA is already on-chain end-to-end. The code does not yet deliver that. |
| Strategic priority | Freeze runtime-to-chain and runtime-to-API contracts before anyone builds more product surface area. |

## How The Current Runtime Works

| Step | Module | What it does |
|---|---|---|
| 1 | `agora/selector/features.py` | Extracts heuristics from task text. |
| 2 | `agora/selector/bandit.py` | Uses Thompson sampling to suggest a mechanism. |
| 3 | `agora/selector/reasoning.py` | Uses an LLM to justify or override the bandit recommendation. |
| 4 | `agora/runtime/orchestrator.py` | Selects mechanism, runs engine, and builds receipt metadata. |
| 5 | `agora/engines/debate.py` | Runs factional debate with devil's advocate, claim locking, and adaptive termination. |
| 6 | `agora/engines/vote.py` | Runs independent voting with confidence calibration and ISP aggregation. |
| 7 | `agora/runtime/hasher.py` | Hashes agent outputs and builds Merkle root and receipt. |
| 8 | `agora/solana/client.py` | HTTP-backed settlement boundary. |

## Your Learning Notes

### 1. The runtime is the strongest asset already present

It is not a toy scaffold.
The selector, engines, monitor, hasher, and orchestrator exist and pass tests.
That means the right move is not to restart the runtime, but to stabilize interfaces around it.

### 2. The orchestrator is the current leverage point

It touches selection, execution, switching, and receipt building.
That makes it the natural seam for deciding what stays in-process and what moves behind a service boundary.

### 3. The real missing capability is actual settlement, not reasoning depth

Delphi, MoA, quadratic voting, reputation weighting, and richer dashboards are all secondary.
The missing hard capability is: can a completed deliberation be settled, queried, and verified through a real backend contract?

### 4. There is role confusion in the planning docs

The PDFs distinguish:

| Role name in docs | Responsibility |
|---|---|
| Dave | Runtime / ML / LLM core |
| Josh | Contract, API, deployment |
| Joshua Ddf | Dashboard |

If you are acting as overall project owner, you need to govern all three tracks.
If you are acting as Josh's track owner, your critical path is the runtime-to-chain and runtime-to-API bridge.

### 5. The product claim needs discipline

Right now the strongest honest claim is:
"AGORA has a working multi-agent arbitration runtime that produces verifiable receipt artifacts."

The stronger claim:
"AGORA is an on-chain arbitration primitive"
only becomes true when the settlement and retrieval path is real.

## What To Watch Closely

| Risk | Why it is dangerous |
|---|---|
| Interface drift between runtime and contract | Breaks end-to-end integration late. |
| Building frontend before API contract freeze | Guarantees churn and duplicate work. |
| Treating PDFs as implementation truth | Creates plans around systems that do not yet exist. |
| Adding more mechanisms too early | Increases complexity before product closure. |
| Leaving receipt schema implicit | Causes chain, API, SDK, and dashboard incompatibility. |

## Recommended Owner Mindset

| Question | Correct stance |
|---|---|
| Should we add features first? | No. Close the runtime-to-chain path first. |
| Should we refactor the runtime broadly? | No. Only targeted changes that improve integration clarity. |
| Should we build the dashboard contract now? | Only after API payloads are frozen. |
| What is the smallest high-leverage move? | One canonical task and receipt contract shared by runtime, API, and chain. |

## Files You Should Read First

| File | Why |
|---|---|
| [README.md](C:/Users/Mecha%20Mino%205%20Outlook/Documents/Mino%20Health%20AI%20labs/justjosh/agora/README.md) | Current runtime narrative and gaps. |
| [agora/runtime/orchestrator.py](C:/Users/Mecha%20Mino%205%20Outlook/Documents/Mino%20Health%20AI%20labs/justjosh/agora/agora/runtime/orchestrator.py) | True control flow. |
| [agora/solana/client.py](C:/Users/Mecha%20Mino%205%20Outlook/Documents/Mino%20Health%20AI%20labs/justjosh/agora/agora/solana/client.py) | The most important missing boundary. |
| [docs/Architecture Map.md](C:/Users/Mecha%20Mino%205%20Outlook/Documents/Mino%20Health%20AI%20labs/justjosh/agora/docs/Architecture%20Map.md) | Working system map. |
| [docs/2026-04-11-agora-master-plan-design.md](C:/Users/Mecha%20Mino%205%20Outlook/Documents/Mino%20Health%20AI%20labs/justjosh/agora/docs/2026-04-11-agora-master-plan-design.md) | Proposed master plan for approval. |
