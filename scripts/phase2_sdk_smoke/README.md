# Phase 2 SDK Smoke

This folder contains a small hosted smoke test for the real `agora-sdk` package.

The wrapper script does two things in order:

1. Creates a fresh virtualenv and installs `agora-sdk` from `../sdk`.
2. Loads `AGORA_API_KEY` from `../../.env` and runs a simple hosted vote prompt.

The smoke test streams hosted task events into the terminal first, then prints a JSON report
with the installed package version, request settings, receipt verification status, and the full
deliberation result.

## Run

```bash
./scripts/phase2_sdk_smoke/run.sh
```

You can override the prompt or API URL with:

```bash
AGORA_PHASE2_SMOKE_PROMPT="Should we use a monolith or microservices?" \
AGORA_API_URL="https://your-api.example.com" \
./scripts/phase2_sdk_smoke/run.sh
```

Set `AGORA_PHASE2_SMOKE_MECHANISM=debate` if you want to force the other hosted mechanism.
