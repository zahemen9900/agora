# Phase 2 SDK Smoke

This folder contains a small hosted smoke test for the real `agora-arbitrator-sdk` package.

The wrapper script does two things in order:

1. Creates a fresh virtualenv and installs `agora-arbitrator-sdk` from `../sdk`.
2. Loads `AGORA_API_KEY` from `../../.env` and runs a simple hosted vote prompt.

The smoke test starts the hosted task asynchronously, streams live task events into the terminal,
waits for terminal success with `wait_for_task_result()`, and then prints a JSON report with the
installed package version, request settings, receipt verification status, and the full
deliberation result.

## Run

```bash
./scripts/phase2_sdk_smoke/run.sh
```

You can override the prompt or mechanism with:

```bash
AGORA_PHASE2_SMOKE_PROMPT="Should we use a monolith or microservices?" \
./scripts/phase2_sdk_smoke/run.sh
```

Set `AGORA_PHASE2_SMOKE_MECHANISM=debate` if you want to force the other hosted mechanism.

The smoke wrapper itself always targets the canonical hosted Cloud Run backend through the SDK
default. For internal testing only, set `AGORA_ALLOW_API_URL_OVERRIDE=1` and use the SDK
directly with a manual `AGORA_API_URL`.
