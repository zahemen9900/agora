# Agora `agora-ai-1199` Restore Runbook

This runbook captures the active parity-restore path for the current GCP target:

- Project name: `agora-ai`
- Project id: `agora-ai-1199`
- Region: `us-central1`
- Zone: `us-central1-a`

## Current restore state

As of June 27, 2026, the project is partially restored already:

- billing is enabled
- required runtime APIs are enabled
- Artifact Registry repo `agora` exists
- bucket `agora-ai-1199-agora-data` exists and is empty
- Redis `agora-redis-prod` is `READY`
- runtime and deploy service accounts exist
- the expected secret names exist

The missing parity pieces are the serving layer and runtime verification:

- Cloud Run service `agora-api` is not deployed yet
- sandbox runner VM `agora-sandbox-runner` is not live yet
- `agora-test-api-key` still has no enabled secret version

Durable backend state is `GCS + Secret Manager + Redis`, not a separate app database.

## Restore entrypoints

Primary restore script:

- [`scripts/restore_agora_project.sh`](/home/zahemen/projects/dl-lib/agora/scripts/restore_agora_project.sh:1)

RWX validation wrapper:

- [`scripts/run_rwx_restore_validation.sh`](/home/zahemen/projects/dl-lib/agora/scripts/run_rwx_restore_validation.sh:1)

RWX task definition:

- [`.rwx/ci.yml`](/home/zahemen/projects/dl-lib/agora/.rwx/ci.yml:1)

## Typical restore flow

Preflight and provisioning:

```bash
./scripts/restore_agora_project.sh preflight
./scripts/restore_agora_project.sh enable-services
./scripts/restore_agora_project.sh create-core
./scripts/restore_agora_project.sh create-secrets
./scripts/restore_agora_project.sh seed-secrets
```

Build and deploy:

```bash
./scripts/restore_agora_project.sh build-images
./scripts/restore_agora_project.sh deploy-runner
./scripts/restore_agora_project.sh deploy-api
./scripts/restore_agora_project.sh verify-hosted
```

Full end-to-end path:

```bash
./scripts/restore_agora_project.sh full-restore
```

## Secret expectations

Base secret seed reads from local env material when present and only generates new values where that is acceptable:

- `agora-gemini-api-key`
- `agora-anthropic-api-key`
- `agora-openrouter-api-key`
- `agora-helius-rpc-url`
- `agora-solana-devnet-keypair`
- `agora-api-key-pepper`
- `agora-benchmark-admin-token`
- `agora-axiom-token`
- `agora-brave-api-key`
- `agora-brave-api-key-2`
- `agora-brave-api-key-3`
- `agora-sandbox-runner-bearer-token`
- `agora-redis-url`

`agora-test-api-key` is intentionally different:

- do not seed it blindly during the base restore
- verify a real hosted API key against `/auth/me`
- only then persist it to Secret Manager as `agora-test-api-key`

Known local sources during restore prep:

- provider/API keys in `.env`
- WorkOS/AuthKit config in `.env`
- Solana devnet keypair at `/home/zahemen/.config/solana/devnet-keypair.json`

## Auth config contract

The restore script accepts both the current `AGORA_*` env names and the legacy bare names:

- `AGORA_WORKOS_CLIENT_ID` or `WORKOS_CLIENT_ID`
- `AGORA_WORKOS_AUTHKIT_DOMAIN` or `WORKOS_AUTHKIT_DOMAIN`
- `AGORA_AUTH_ISSUER` or `AUTH_ISSUER`
- `AGORA_AUTH_AUDIENCE` or `AUTH_AUDIENCE`
- `AGORA_AUTH_JWKS_URL` or `AUTH_JWKS_URL`

The deploy step fails early if the resolved auth config is incomplete.

## RWX validation

This restore does not use GitHub Actions bootstrap or GitHub OIDC.

Validation is local-CLI-driven through RWX:

```bash
./scripts/run_rwx_restore_validation.sh
```

The wrapper:

- loads local env files
- maps `RWX_TOKEN` into `RWX_ACCESS_TOKEN` when needed
- requires a working `rwx` CLI install
- runs the repo validation task in `.rwx/ci.yml`

Optional local hosted smoke after RWX validation:

```bash
RUN_LOCAL_HOSTED_SMOKE=1 ./scripts/run_rwx_restore_validation.sh
```

## Verification checklist

Infra parity:

- `gcloud services list --enabled --project agora-ai-1199`
- `gcloud artifacts repositories list --project agora-ai-1199 --location us-central1`
- `gcloud storage buckets list --project agora-ai-1199`
- `gcloud redis instances list --project agora-ai-1199 --region us-central1`
- `gcloud secrets list --project agora-ai-1199`
- `gcloud run services list --project agora-ai-1199 --region us-central1`
- `gcloud compute instances list --project agora-ai-1199`

Runtime:

- `curl https://<cloud-run-url>/health`
- `curl https://<cloud-run-url>/auth/config`
- `curl -H "Authorization: Bearer <api-key>" https://<cloud-run-url>/auth/me`

SDK smoke once a valid hosted key exists:

```bash
./scripts/phase2_sdk_smoke/run.sh
```

## Repo follow-up after live deploy

Once the new Cloud Run URL exists, update the stale hosted defaults in:

- `README.md`
- `agora/sdk/config.py`
- `scripts/phase2_demo.py`
- `scripts/week1_demo.sh`
- `agora-web/vercel.json`
- `agora-web/vite.config.ts`
- `agora-web/README.md`
- `agora-web/src/docs/content/sdk/APIReference.tsx`
