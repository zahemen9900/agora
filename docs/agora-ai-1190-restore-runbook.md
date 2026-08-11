# Agora AI 1190 Restore Runbook

This runbook captures the concrete fast-parity restore path for the active GCP target:

- Project name: `agora-ai`
- Project id: `agora-ai-1190`
- Region: `us-central1`
- Zone: `us-central1-a`

## Required Google APIs

As of 2026-08-11, billing is enabled on `agora-ai-1190`. A blank-project restore requires:

- `run.googleapis.com`
- `artifactregistry.googleapis.com`
- `aiplatform.googleapis.com`
- `secretmanager.googleapis.com`
- `redis.googleapis.com`
- `compute.googleapis.com`
- `cloudbuild.googleapis.com`
- `cloudbilling.googleapis.com`
- `cloudresourcemanager.googleapis.com`
- `iam.googleapis.com`
- `iamcredentials.googleapis.com`
- `vpcaccess.googleapis.com`

## What the restore should recreate

Fast-parity target shape:

- Cloud Run service `agora-api`
- Artifact Registry repo `agora`
- GCS bucket `${PROJECT_ID}-agora-data`
- Redis instance `agora-redis-prod`
- runtime service account `agora-api-runtime@agora-ai-1190.iam.gserviceaccount.com`
- deploy service account `github-deploy@agora-ai-1190.iam.gserviceaccount.com`
- sandbox-runner VM `agora-sandbox-runner`
- Secret Manager entries required by `.github/workflows/deploy.yml`

Primary durable state remains GCS-backed object storage, not Postgres.

## Repo automation

Use [`scripts/restore_agora_project.sh`](../scripts/restore_agora_project.sh).

Typical flow:

```bash
./scripts/restore_agora_project.sh preflight
./scripts/restore_agora_project.sh enable-services
./scripts/restore_agora_project.sh create-core
./scripts/restore_agora_project.sh create-secrets
./scripts/restore_agora_project.sh build-images
./scripts/restore_agora_project.sh deploy-runner
./scripts/restore_agora_project.sh deploy-api
```

Or run the full sequence:

```bash
./scripts/restore_agora_project.sh full-restore
```

## Secret reseed inventory

The old suspended project cannot be used as a source of truth. Seed from local env or rotate fresh values for:

- `agora-gemini-api-key`
- `agora-anthropic-api-key`
- `agora-openrouter-api-key`
- `agora-helius-rpc-url`
- `agora-solana-devnet-keypair`
- `agora-api-key-pepper`
- `agora-benchmark-admin-token`
- `agora-redis-url`
- `agora-test-api-key`
- `agora-axiom-token`
- `agora-brave-api-key`
- `agora-brave-api-key-2`
- `agora-brave-api-key-3`
- `agora-sandbox-runner-bearer-token`

## Known local secret sources

Present in local env material at inspection time:

- provider keys: Gemini, Anthropic, OpenRouter
- WorkOS/AuthKit config values
- Axiom token
- Brave API keys
- Helius URL

Also present locally:

- Solana devnet keypair at `/home/zahemen/.config/solana/devnet-keypair.json`

## Runtime values

- `GCP_PROJECT_ID=agora-ai-1190`
- `GCP_RUNTIME_SERVICE_ACCOUNT=agora-api-runtime@agora-ai-1190.iam.gserviceaccount.com`
- `AGORA_GCS_BUCKET=agora-ai-1190-agora-data`
- `AGORA_COORDINATION_NAMESPACE=agora-prod`
- `WORKOS_CLIENT_ID=<from local env / WorkOS>`
- `WORKOS_AUTHKIT_DOMAIN=<from local env / WorkOS>`
- `AUTH_ISSUER=<from local env / WorkOS>`
- `AUTH_AUDIENCE=<from local env / WorkOS>`
- `AUTH_JWKS_URL=<from local env / WorkOS>`
- `SOLANA_NETWORK=devnet`
- `PROGRAM_ID=82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd`
- `SOLANA_KEYPAIR_SECRET_NAME=agora-solana-devnet-keypair`
- `SOLANA_KEYPAIR_SECRET_PROJECT=agora-ai-1190`
- `AGORA_SANDBOX_RUNNER_URL=<private runner URL once VM is live>`

## Verification checklist

- `gcloud services list --enabled --project agora-ai-1190`
- `gcloud artifacts repositories list --project agora-ai-1190 --location us-central1`
- `gcloud storage buckets list --project agora-ai-1190`
- `gcloud redis instances list --project agora-ai-1190 --region us-central1`
- `gcloud secrets list --project agora-ai-1190`
- `gcloud run services list --project agora-ai-1190 --region us-central1`
- `curl https://<cloud-run-url>/health`
- `curl https://<cloud-run-url>/auth/config`

## Repo follow-up after live deploy

Once the new Cloud Run URL exists, replace the remaining stale old hosted URLs in:

- `README.md`
- `agora/sdk/config.py`
- `scripts/phase2_demo.py`
- `scripts/week1_demo.sh`
- `agora-web/vercel.json`
- `agora-web/vite.config.ts`
- `agora-web/README.md`
- `agora-web/src/docs/content/sdk/APIReference.tsx`
- tests or JSON fixtures that still assume old run.app endpoints
