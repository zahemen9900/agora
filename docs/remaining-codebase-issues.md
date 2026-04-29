# Remaining Codebase Issues

This report captures the unresolved issues identified during the low-risk cleanup pass on 2026-04-15.

Scope notes:

- This is ordered by priority, not by subsystem.
- This excludes the already-known frontend build blocker in the current mixed WSL/Windows Node environment.
- These are issues I intentionally did not auto-fix because they were medium/high risk, architectural, or required a product decision.

## Dispatch Guidance Relative to API Key + Auth E2E Work

Unlike the technical-security backlog, almost everything in this document is independent of WorkOS completion and independent of a first-party API key system. In other words: another agent can start on these immediately.

### Can be fixed immediately with no auth dependency

- `#2` stale `in_progress` recovery follow-through and broader multi-worker hardening
- `#4` remaining Solana reconciliation gaps
- `#6` remaining benchmark payload typing cleanup
- `#7` placeholder public surfaces
- `#9` environment-fragile validation/tooling

None of these require WorkOS to be finished. None require API keys to exist first.

### Strongest candidates to do before machine-auth rollout

- `#2` stale `in_progress` recovery follow-through and broader multi-worker hardening
- `#4` Solana write-flow reconciliation and idempotency

Why these first:

- `#2` is still the biggest hosted-execution correctness problem once more workers exist.
- `#4` determines whether hosted side effects are recoverable once more real users and credentials exist.

### Does not need to block auth work

- `#6`, `#7`, and `#9` can run in parallel and should not hold up the API key design.

## Priority 0

### 1. Resolved: public mechanism contract now exposes the supported execution surface cleanly

**Dispatch status**

- Resolved on 2026-04-21/2026-04-22

What changed:

- Public API and SDK request/response types now expose `debate|vote|delphi`.
- Task creation and execution reject unsupported mechanisms instead of silently rerouting them.
- Selector/runtime execution paths no longer advertise unsupported execution coverage.
- Delphi is now a real executable mechanism across runtime, API, SDK, and frontend contracts.

What remains:

- The roadmap placeholder modules still exist as internal scaffolds. That is tracked under `#7`, not here.

### 2. Task execution coordination still needs broader hardening, but stale-run recovery landed

**Dispatch status**

- Start now
- Still the highest-priority remaining hosted correctness item

What changed already:

- Distributed coordination, stream tickets, lease refresh, workspace concurrency slots, and Redis-backed fan-out are now present.
- As of 2026-04-22, a persisted `in_progress` task is no longer treated as permanently stuck. If no live run lease exists, the API recovers the task, emits `task_recovered`, and continues execution.

What still remains:

- Full multi-worker guarantees still depend on the coordination backend and deployment topology.
- We still need broader operational policy around lease expiry, operator resets, and replay behavior after more complex partial failures.

Evidence for the remaining work:

- `api/routes/tasks.py`
- `api/coordination.py`
- `api/streaming.py`

Why this remains open:

- The stale-run bug is fixed, but the subsystem is still a deployment architecture concern, not just a local code-path concern.

## Priority 1

### 3. Resolved: GCS storage now distinguishes missing, invalid, and unavailable

**Dispatch status**

- Resolved on 2026-04-21

What changed:

- The storage layer now raises typed `TaskStoreNotFound`, `TaskStorePayloadError`, and `TaskStoreUnavailable` instead of broadly collapsing infrastructure failures into normal control flow.

### 4. Resolved: Solana write flow now reconciles every current chain side effect

**Dispatch status**

- Start now
- Still recommended before higher-volume authenticated usage

What changed:

- Chain operations persist pending/succeeded/failed state as a write-ahead log.
- Retry paths now reconcile `initialize_task`, `record_selection`, `record_switch:*`, `submit_receipt`, and `release_payment` from deterministic on-chain state instead of blindly replaying writes.
- `TaskAccount` decoding plus vault existence checks now provide recovery signals for selection, receipt, and payment release, not just task/switch PDA existence.

What still exists but is no longer treated as a blocking gap:

- There is still no full cross-operation transaction manager. That is longer-horizon hardening, not an unresolved hole in the current write flow.

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

### 6. Generated frontend API types landed, but benchmark payloads are still only partially normalized

**Dispatch status**

- Start now
- Independent of WorkOS and API key design

What changed already:

- `agora-web/src/lib/api.generated.ts` is now generated from the backend schema.
- The frontend API layer now aliases most benchmark catalog/detail/run types to generated contracts instead of hand-maintaining shadow interfaces.

What still remains:

- The `/benchmarks` summary payload is still intentionally loose and frontend-only helper shapes remain for that endpoint.
- Some backend benchmark fields still use `dict[str, Any]`, which limits how precise the generated TypeScript can become.

### 7. Remaining placeholder/stub surfaces should stay clearly unsupported

**Dispatch status**

- Start now
- Independent of WorkOS and API key design

Some modules are still explicit placeholders. They are now documented more clearly as internal, but they still exist and still enlarge the apparent supported surface area.

Evidence:

- `agora/solana/client.py:21`
- `agora/engines/moa.py:8`

Why this matters:

- New engineers and SDK consumers can infer support that does not exist.
- Placeholder interfaces tend to calcify into accidental compatibility promises.

Current status:

- README and module docstrings now mark the remaining placeholders as internal/unsupported.
- `agora/engines/delphi.py` is no longer a placeholder; MoA and the SDK-side Solana client remain the meaningful stubs.

### 8. Resolved: selector package import cycle is gone

**Dispatch status**

- Resolved on 2026-04-21

What changed:

- `agora.selector.__init__` now uses lazy exports and `TYPE_CHECKING` imports, so the old package-level cycle is gone.

## Priority 3

### 9. The current validation/tooling setup is narrower now, but still not fully bootstrap-free

**Dispatch status**

- Start now if someone can own dev-experience/tooling
- Do not let this block API key/auth implementation

This is not the same as the already-known frontend build blocker, but it is adjacent: validation still depends on a mixed toolchain and some checks need non-default invocation to work reliably.

Evidence:

- `./.venv/bin/python -m pytest -q -s` is still the reliable Python entrypoint in this environment.
- The Windows `npm` wrapper still fails under WSL UNC paths.
- As of 2026-04-22, the repo has a working WSL-native Node path and a helper wrapper: `./scripts/with_wsl_node.sh npm --prefix agora-web run build` now succeeds from this checkout.

Why this matters:

- Quality gates are harder to trust when they are shell/environment sensitive.
- Reproducibility is worse than it should be.

Recommended fix:

1. Keep standardizing on WSL-native Node and Python entrypoints for local dev.
2. If this still causes confusion for contributors, add bootstrap automation that exports the WSL Node path automatically instead of relying on the helper wrapper.

What changed already:

- README now documents the working Python test command and calls out the WSL/Windows npm trap explicitly.
- `scripts/with_wsl_node.sh` now codifies the WSL-native Node workaround instead of relying on shell-specific tribal knowledge.

Why I did not auto-fix it:

- This is environment setup, not a code-only patch.
