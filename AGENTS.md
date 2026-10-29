# Agora agent instructions

These rules apply across the repository. Keep instructions short, honor the
existing release safeguards, and prefer validated results over agent activity.

## Execution strategy and Superpowers

Default to one main agent for routine fixes, debugging with a shared context,
and long or multi-step changes with tightly coupled components. A large plan
is not itself grounds to spawn one implementer and reviewer per task. Use
`superpowers:executing-plans` for inline, plan-based work when available.
Reserve `superpowers:subagent-driven-development` for substantial independent
tasks where separate contexts and review gates justify their extra cost; use
parallel investigators only for genuinely independent hypotheses or domains.

Do not dispatch agents to repeat basic repository exploration, mechanical
edits, or routine tests. For architectural changes, cross-component contracts,
financial transactions, authorization, and security-sensitive logic, use a
focused independent review of the original requirements, diff, and test
evidence. Keep at most two concurrent workers by default; avoid overlapping
file ownership, shared mutable state, and recursive delegation. Provide each
worker with known file paths, interfaces, acceptance criteria, and a narrow
deliverable. The main agent owns integration and final verification.

For long sessions, checkpoint the plan, completed steps, files/commits,
verified tests, decisions, blockers, and next action. After compaction,
resume from those artifacts rather than rediscovering the repository. Run
relevant tests per milestone and at completion; do not weaken verification
for token savings. Once a Superpowers skill is invoked, follow its required
procedure; explicit user instructions and release safeguards remain binding.

## Python environment

Use a repository-appropriate Python environment, not unrelated global
interpreters. Prefer an existing repo-local virtual environment (if present)
and invoke tests and tooling as `python -m pytest`, `python -m ruff`, etc.
Do not hardcode a developer-specific absolute path to an environment; resolve
its active interpreter before running commands.

## Release discipline

- Backend and SDK versions must stay aligned. The runtime version is in
  `agora/version.py`; release metadata also lives in root `pyproject.toml`,
  `sdk/pyproject.toml`, and `docs/release-operations.md`.
- Before a public release, inspect and reconcile the versions across all
  four places. A mismatch in backend metadata, `/health`, or SDK package
  metadata blocks release; never guess the intended version.
- Do not create an `sdk-v*` tag until `python -m build sdk`,
  `python -m twine check sdk/dist/*`, and an isolated wheel install/import
  smoke test all pass.
- Preserve existing deployment checks and obtain authorization for public
  releases or other irreversible external side effects.
