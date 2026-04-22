# Remaining Technical Issues Report

This report covers the highest-priority issues still present on the current branch after the recent security remediation work. The Python/API/SDK/contract test suites now pass in `agora-env`, but the items below remain open and should be treated as the next engineering backlog.

## Dispatch Guidance Relative to API Key + Auth E2E Work

This backlog should not be treated as one monolith. Some items are safe to dispatch immediately without waiting for WorkOS completion or a first-party API key system. A smaller set either materially should land before the machine-auth rollout, or depend on the auth model and should wait until that design exists.

### Can be fixed immediately with no auth dependency

- `#2` strict SDK receipt verification against real chain state
- `#3` webhook replay resistance
- `#6` fully locked deployment dependencies

These are independent engineering problems. They do not require a final browser-auth or machine-auth design.

### Should ideally be fixed before full API key + hosted auth E2E rollout

- `#1` process-local run locking and SSE ticketing

This is the main hosted-path correctness problem. Rolling out machine auth on top of a deployment model that still allows duplicate runs or cross-instance SSE breakage is backwards.

### Should wait until the auth / API key model exists

- `#4` benchmarks UI/backend auth mismatch
- `#5` API-level abuse controls, quotas, and rate limits
- `#7` benchmark access moving from static secret to real authorization

These need a real caller identity model. They can be discussed now, but the durable implementation wants the API key / principal model in place first.

## Priority 0

### 1. Task execution and SSE auth are still process-local, not deployment-safe

**Dispatch status**

- Start now
- Treat as a blocker before full machine-auth rollout

**Files**

- `api/routes/tasks.py:35-47`
- `api/routes/tasks.py:107-133`
- `api/routes/tasks.py:425-428`

**What remains**

Two critical control paths are stored only in memory:

- `_stream_tickets` for one-time SSE authentication
- `_running_task_keys` for duplicate-run suppression

That works in a single process, but it does not survive:

- multi-instance Cloud Run / horizontal scaling
- instance restarts
- requests landing on different instances between ticket creation and stream open

**Impact**

- SSE can fail nondeterministically in production because the `POST /stream-ticket` and `GET /stream` requests may hit different instances.
- Duplicate task execution is still possible across replicas because the in-memory run lock is not distributed.

**Why this matters**

This is the main remaining correctness/security gap in the hosted execution path. The current implementation is safe only under de facto single-process assumptions.

**Recommended fix**

Move both controls into shared storage:

- Persist stream tickets in Redis, Postgres, or GCS with TTL and one-time consume semantics.
- Replace `_running_task_keys` with a distributed lease or compare-and-swap state transition in persistent storage.

## Priority 1

### 2. Strict SDK receipt verification still cannot verify real on-chain state

**Dispatch status**

- Start now
- Independent of WorkOS and API key design

**Files**

- `agora/sdk/arbitrator.py:110-167`

**What remains**

`verify_receipt(..., strict=True)` intentionally fails closed because real chain-proof verification has not been implemented yet. The SDK currently supports:

- local Merkle recomputation
- hosted metadata comparison

It does **not** support:

- Solana RPC proof retrieval
- transaction/account proof verification
- trust-minimized confirmation that the hosted receipt matches chain state

**Impact**

Any workflow that claims “strict” cryptographic receipt verification is not available yet. Today, the SDK can prove internal consistency, but not independently prove on-chain finality.

**Recommended fix**

Implement strict verification against Solana state:

- fetch the task PDA and switch logs directly from RPC
- verify transaction signatures and program-owned account contents
- compare on-chain receipt fields to the local result

### 3. Webhook verification is replayable

**Dispatch status**

- Start now
- Independent of WorkOS and API key design

**Files**

- `api/routes/webhooks.py:17-76`

**What remains**

The webhook is now HMAC-signed, but the scheme has no replay defense:

- no timestamp header
- no nonce
- no deduplication on transaction signature

If a valid signed payload is captured once, it can be replayed indefinitely.

**Impact**

An attacker with access to a previously valid webhook payload could inject repeated `receipt_confirmed` events or cause noisy/incorrect UI state transitions.

**Recommended fix**

Add replay resistance:

- require a signed timestamp header with a short skew window
- reject duplicate `(signature, timestamp)` tuples
- persist seen webhook IDs or tx signatures for a bounded TTL

## Priority 2

### 4. The benchmarks UI is now incompatible with the hardened backend

**Dispatch status**

- Defer durable implementation until auth/API key direction is chosen
- Short-term option remains: remove or hide the public Benchmarks route

**Files**

- `api/routes/benchmarks.py:21-30`
- `agora-web/src/lib/api.ts:162-163`
- `agora-web/src/pages/Benchmarks.tsx:23-29`

**What remains**

The backend now requires `x-agora-admin-token` for `/benchmarks`, but the frontend still calls `getBenchmarks()` with no header or auth flow.

**Impact**

The Benchmarks page will now degrade into an empty state after a `403`, even though the backend hardening itself is correct.

**Recommended fix**

Choose one of these paths:

- move benchmark access behind a server-side proxy that injects admin credentials
- add a proper admin session/RBAC layer
- remove the public frontend route if benchmarks are meant to stay internal-only

### 5. There is still no API-level abuse control on task creation/execution

**Dispatch status**

- Design now if useful
- Implement after caller identity is stable

**Files**

- `api/routes/tasks.py:293-403`
- `api/routes/tasks.py:406-520`

**What remains**

The API now validates task length and ownership, but it still has no:

- per-user rate limit
- quota / budget enforcement
- task creation throttling
- run concurrency cap beyond one in-memory key per process

**Impact**

Any authenticated user can still generate expensive orchestration load at effectively unbounded volume. The provider-side throttles only protect downstream model calls, not platform cost or API saturation.

**Recommended fix**

Add explicit service-side controls:

- per-user request and token budgets
- burst limits on `/tasks/` and `/tasks/{id}/run`
- server-enforced concurrent run caps

## Priority 3

### 6. Deployment reproducibility is only partially locked

**Dispatch status**

- Start now
- Independent of WorkOS and API key design

**Files**

- `api/Dockerfile:9-11`
- `api/constraints.txt:1-18`

**What remains**

The Docker build now uses a constraints file, which is better than open ranges, but it still does not fully lock the dependency graph:

- `api/requirements.txt` remains range-based
- `constraints.txt` pins only the named packages listed there
- transitive dependencies can still drift unless they are all explicitly locked

**Impact**

Two builds at different times can still resolve different transitive trees, which is a supply-chain and reproducibility gap.

**Recommended fix**

Promote this to a real lock:

- generate a fully pinned lockfile with all transitive versions
- ideally include hashes
- make CI and Docker install from that artifact only

### 7. Benchmark access uses a single shared static secret, not real authorization

**Dispatch status**

- Defer until the auth principal / RBAC model exists
- Keep the static secret only as a temporary internal control

**Files**

- `api/routes/benchmarks.py:21-30`

**What remains**

The benchmark route is protected, but only by a shared admin header token. There is no:

- user identity binding
- RBAC
- audit trail of who accessed benchmark data
- scoped secret rotation model

**Impact**

This is acceptable as a short-term internal control, but weak as a long-term admin boundary.

**Recommended fix**

Fold benchmark access into the normal auth model:

- require authenticated admins
- authorize via role/claim
- reserve the static header token for emergency/internal automation only

## Verification Status

These residual issues were identified after the current branch passed:

- `pytest -s -q` -> `117 passed, 3 skipped`
- `pytest -s tests/test_e2e.py -q` -> `1 passed, 1 skipped`
- `cargo test`
- `cargo fmt --check`
- `python -m build sdk`

The biggest remaining unsolved risks are architectural, not syntax/test failures.
