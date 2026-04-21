# Remaining Codebase Issues

This report captures the unresolved issues identified during the low-risk cleanup pass on 2026-04-15.

Scope notes:

- This is ordered by priority, not by subsystem.
- This excludes the already-known frontend build blocker in the current mixed WSL/Windows Node environment.
- These are issues I intentionally did not auto-fix because they were medium/high risk, architectural, or required a product decision.

## Dispatch Guidance Relative to API Key + Auth E2E Work

Unlike the technical-security backlog, almost everything in this document is independent of WorkOS completion and independent of a first-party API key system. In other words: another agent can start on these immediately.

### Can be fixed immediately with no auth dependency

- `#1` false public mechanism contract for `delphi` and `moa`
- `#2` multi-worker / crash-unsafe task execution coordination
- `#3` GCS store swallowing infrastructure errors
- `#4` non-transactional Solana write flow
- `#6` manually duplicated backend/frontend schemas
- `#7` placeholder public surfaces
- `#8` selector import cycle
- `#9` environment-fragile validation/tooling

None of these require WorkOS to be finished. None require API keys to exist first.

### Strongest candidates to do before machine-auth rollout

- `#1` false public mechanism contract
- `#2` multi-worker / crash-unsafe execution coordination
- `#4` Solana write-flow reconciliation and idempotency

Why these four first:

- `#1` keeps the public API/SDK contract honest before external users depend on it.
- `#2` is the biggest correctness problem in hosted execution.
- `#4` determines whether hosted side effects are recoverable once more real users and credentials exist.

### Does not need to block auth work

- `#3`, `#6`, `#7`, `#8`, and `#9` can run in parallel and should not hold up the API key design.

## Priority 0

### 1. Public mechanism contract is false for `delphi` and `moa`

**Dispatch status**

- Start now
- Strongly recommended before external/authenticated hosted usage expands

The public API, selector, and model schema all advertise `delphi` and `moa` as supported mechanisms, but the runtime does not implement them. Worse, the orchestrator silently falls back to debate instead of rejecting the request or surfacing a capability error.

Why this matters:

- The API contract is lying to callers.
- Forced overrides can claim one mechanism at task creation and execute another at runtime.
- Selector outputs can imply coverage that does not exist.

Evidence:

- `api/models.py:21`, `api/models.py:28`, `agora/types.py:16`
- `agora/selector/reasoning.py:82`
- `agora/runtime/orchestrator.py:221`, `agora/runtime/orchestrator.py:319`
- `agora/engines/delphi.py:8`
- `agora/engines/moa.py:8`

Concrete failure mode:

- A caller can request `mechanism_override="delphi"` or `mechanism_override="moa"`.
- Task creation accepts it and persists that mechanism.
- Runtime execution silently routes to debate in `AgoraOrchestrator._execute_mechanism`.

Recommended fix:

1. Pick one contract and enforce it.
2. Either remove `delphi`/`moa` from public schemas and selector prompts until implemented, or implement them for real.
3. If unsupported mechanisms remain in the enum for roadmap reasons, reject them explicitly at API/runtime boundaries with a 4xx/clear SDK error. Do not silently reroute.

Why I did not auto-fix it:

- This changes public behavior and API compatibility.
- It requires a product decision: hide roadmap mechanisms vs keep them visible but unsupported.

### 2. Task execution coordination is not safe in multi-worker or crash scenarios

**Dispatch status**

- Start now
- Treat as a blocker before full machine-auth rollout

Task exclusivity, stream tickets, and live event fan-out are enforced with in-memory process-local state. That is fine for a single dev process, but it is not correct for a real deployment.

Why this matters:

- Duplicate task execution can still happen across workers/replicas.
- Stream tickets are only valid in the process that minted them.
- SSE subscriptions only receive events emitted by the same process.
- A worker crash can leave a task stuck in `in_progress` forever with no lease recovery path.

Evidence:

- `api/routes/tasks.py:36`
- `api/routes/tasks.py:47`
- `api/routes/tasks.py:107`
- `api/routes/tasks.py:420`
- `api/routes/tasks.py:425`
- `api/routes/tasks.py:628`
- `api/streaming.py:10`
- `api/streaming.py:50`

Concrete failure modes:

- Two workers can both observe the same persisted task as `pending` and race into execution.
- A task marked `in_progress` is unrecoverable after process death because there is no run lease, heartbeat, or stale-run timeout.
- Browser SSE may fail or go silent when requests are load-balanced across processes.

Recommended fix:

1. Replace `_running_task_keys` with a persistent lease or compare-and-set transition in the task store.
2. Store stream tickets in shared storage or sign them statelessly.
3. Replace in-memory SSE fan-out with a distributed event channel if multi-instance support matters.
4. Add stuck-task recovery: lease expiry, heartbeat, or operator reset path.

Why I did not auto-fix it:

- This is not a cleanup patch. It is a concurrency and deployment architecture change.
- The right fix depends on the intended runtime model: single process, GCS-backed API, Redis, queue worker, etc.

## Priority 1

### 3. GCS storage layer swallows infrastructure failures as missing data

**Dispatch status**

- Start now
- Independent of WorkOS and API key design

`TaskStore` catches broad `Exception` in read paths and converts many failures into `None`, empty lists, or silent skips.

Why this matters:

- Credential failures, RPC/GCS outages, malformed JSON, and permission errors become indistinguishable from “not found”.
- Incident diagnosis gets harder because real infra failures are downgraded into normal control flow.
- Partial data corruption can be hidden instead of surfaced.

Evidence:

- `api/store.py:41`
- `api/store.py:65`
- `api/store.py:81`
- `api/store.py:124`
- `api/store.py:140`

Recommended fix:

1. Narrow exception handling to expected not-found and parse cases.
2. Log and re-raise infrastructure/auth errors.
3. Distinguish “missing object”, “invalid payload”, and “backend unavailable” in the task-store interface.

Why I did not auto-fix it:

- Tightening these catches changes API behavior during outages and could turn soft failures into hard errors.
- That is the correct long-term direction, but it needs an intentional reliability decision.

### 4. Solana write flow is not transactional and can leave local/chain state out of sync

**Dispatch status**

- Start now
- Strongly recommended before higher-volume authenticated usage

The task lifecycle performs multiple external side effects across chain writes and local persistence without a transactional model.

Why this matters:

- A later failure can occur after an earlier chain write already succeeded.
- Strict mode can return failure even though on-chain state was partially committed.
- Replay/recovery semantics are unclear.

Evidence:

- `api/routes/tasks.py:329`
- `api/routes/tasks.py:341`
- `api/routes/tasks.py:491`
- `api/routes/tasks.py:525`
- `api/routes/tasks.py:731`
- `api/solana_bridge.py:445`
- `api/solana_bridge.py:478`

Concrete failure modes:

- `initialize_task` can succeed and `record_selection` can fail, leaving chain state initialized without a consistent local record.
- Receipt submission can succeed while later local persistence or switch recording fails.
- Payment release can succeed on chain while the API crashes before fully persisting the final local state.

Recommended fix:

1. Define explicit idempotency keys and replay semantics for every chain write.
2. Persist a write-ahead intent or operation log before side effects.
3. Split local task state from chain operation state so partial completion is observable and recoverable.

Why I did not auto-fix it:

- This needs a full state machine design, not a cleanup edit.
- The safe version requires product decisions about retry, reconciliation, and eventual consistency.

### 5. Resolved: SDK packaging no longer mirrors the Python source tree

**Dispatch status**

Resolved on 2026-04-21

This issue is no longer open. The repo now uses `agora/` as the single source
tree, and `sdk/` is only the release wrapper for `agora-arbitrator-sdk`.

What changed:

- The `sdk/agora` symlinked mirror was removed.
- SDK builds package `agora*` directly from the repo-root source tree.
- The release path remains `python -m build sdk` and GitHub trusted publishing.

Why this note remains here:

- Historical references elsewhere in this document use the original numbering.
- The duplication risk that previously affected SDK/backend drift is gone.

## Priority 2

### 6. Backend and frontend API schemas are still manually duplicated

**Dispatch status**

- Start now
- Independent of WorkOS and API key design

I consolidated repeated unions inside each side, but the Python and TypeScript contracts are still hand-maintained in parallel.

Why this matters:

- Contract drift will keep happening.
- The recent `mechanism_override` frontend break was exactly this class of failure.

Evidence:

- `api/models.py:15`
- `api/models.py:64`
- `agora-web/src/lib/api.ts:9`
- `agora-web/src/lib/api.ts:43`

Recommended fix:

1. Generate TypeScript types from the backend schema, or
2. Move to an explicit shared schema source and generate both sides.

Why I did not auto-fix it:

- That is a tooling choice, not a cleanup edit.
- It affects the backend/frontend build pipeline.

### 7. Public placeholder/stub surfaces still exist outside the main runtime path

**Dispatch status**

- Start now
- Independent of WorkOS and API key design

Some exported modules are still explicit placeholders. They are not all harmful, but they enlarge the apparent supported surface area.

Evidence:

- `agora/solana/client.py:21`
- `agora/engines/delphi.py:8`
- `agora/engines/moa.py:8`

Why this matters:

- New engineers and SDK consumers can infer support that does not exist.
- Placeholder interfaces tend to calcify into accidental compatibility promises.

Recommended fix:

1. Either mark them clearly as internal roadmap placeholders and stop exporting them broadly, or
2. Implement them, or
3. Remove them from public-facing docs and package exports.

Why I did not auto-fix it:

- This touches package/API surface and roadmap signaling.

### 8. Selector package layout has a benign but unnecessary import cycle

**Dispatch status**

- Start now if someone is already in the selector package
- Otherwise keep behind the correctness work above

The selector package re-export pattern creates a package-level cycle between
`agora.selector` and `agora.selector.selector`.

Evidence:

- `agora/selector/__init__.py:3`
- `agora/selector/selector.py:9`

Why this matters:

- It is mostly tooling debt, not a production bug.
- It makes dependency graphs noisier and complicates cycle detection.

Recommended fix:

- Stop re-exporting `AgoraSelector` from `agora.selector.__init__`, or reduce imports to one direction.

Why I did not auto-fix it:

- Low payoff relative to the higher-priority correctness issues above.

## Priority 3

### 9. The current validation/tooling setup is still environment-fragile

**Dispatch status**

- Start now if someone can own dev-experience/tooling
- Do not let this block API key/auth implementation

This is not the same as the already-known frontend build blocker, but it is adjacent: validation depends on a mixed toolchain and some checks need non-default invocation to work reliably.

Evidence:

- `pytest` in this environment required `-s` to avoid a capture-path failure.
- `npm run lint` and `npm run build` fail under the Windows npm wrapper when launched from a WSL UNC path.
- Vite direct execution depends on Windows-native optional bindings in the installed `node_modules`.

Why this matters:

- Quality gates are harder to trust when they are shell/environment sensitive.
- Reproducibility is worse than it should be.

Recommended fix:

1. Standardize on WSL-native Node and Python entrypoints for local dev, or standardize on Windows-native paths and stop mixing.
2. Encode the expected dev environment in docs or bootstrap scripts.

Why I did not auto-fix it:

- This is environment setup, not a code-only patch.
