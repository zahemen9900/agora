# AGENTS: Release Discipline

Use this repo rule for every public release:

- Backend and SDK versions must stay identical.
- Canonical runtime version lives in `/home/zahemen/projects/dl-lib/agora/agora/version.py`.
- Every release bump must update all of:
  - `agora/version.py`
  - repo-root `pyproject.toml`
  - `sdk/pyproject.toml`
  - `docs/release-operations.md`
- Never cut an `sdk-v*` tag without:
  - `python -m build sdk`
  - `python -m twine check sdk/dist/*`
  - isolated wheel install/import smoke

If backend metadata, `/health`, or SDK package metadata show different versions, treat that as a release blocker.
