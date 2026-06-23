# Agora AI 1199 Restore Runbook

This runbook captures the concrete fast-parity restore path for the active GCP target:

- Project name: `agora-ai`
- Project id: `agora-ai-1199`
- Region: `us-central1`
- Zone: `us-central1-a`

## Current external blocker

As of 2026-06-23, the account `david@maigreeks.com` has `roles/owner` on the project, but:

- billing is **not** attached to `agora-ai-1199`
- the visible billing account `01E5D5-10A0BB-CAFD30` fails project linking with
  `Cloud billing quota exceeded`

That means the repo-side restore work can be prepared now, but these Google APIs cannot be enabled until billing is fixed:

- `run.googleapis.com`
- `artifactregistry.googleapis.com`
- `secretmanager.googleapis.com`
- `redis.googleapis.com`
- `compute.googleapis.com`
- `cloudbuild.googleapis.com`
- `iamcredentials.googleapis.com`
- `vpcaccess.googleapis.com`

## What the restore should recreate

Fast-parity target shape:

- Cloud Run service `agora-api`
- Artifact Registry repo `agora`
- GCS bucket `${PROJECT_ID}-agora-data`
- Redis instance `agora-redis-prod`
- runtime service account `agora-api-runtime@agora-ai-1199.iam.gserviceaccount.com`
- deploy service account `github-deploy@agora-ai-1199.iam.gserviceaccount.com`
- sandbox-runner VM `agora-sandbox-runner`
- Secret Manager entries required by `.github/workflows/deploy.yml`

Primary durable state remains GCS-backed object storage, not Postgres.

## Repo automation

Use [`/home/zahemen/projects/dl-lib/agora.worktrees/main-sync/scripts/restore_agora_project.sh`](/home/zahemen/projects/dl-lib/agora.worktrees/main-sync/scripts/restore_agora_project.sh:1).

Typical flow once billing is fixed:

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

## GitHub Actions variables/secrets to set

Secrets:

- `GCP_PROJECT_ID=agora-ai-1199`
- `GCP_SERVICE_ACCOUNT=github-deploy@agora-ai-1199.iam.gserviceaccount.com`
- `GCP_WORKLOAD_IDENTITY_PROVIDER=<new provider resource>`

Variables:

- `GCP_RUNTIME_SERVICE_ACCOUNT=agora-api-runtime@agora-ai-1199.iam.gserviceaccount.com`
- `AGORA_GCS_BUCKET=agora-ai-1199-agora-data`
- `AGORA_COORDINATION_NAMESPACE=agora-prod`
- `WORKOS_CLIENT_ID=<from local env / WorkOS>`
- `WORKOS_AUTHKIT_DOMAIN=<from local env / WorkOS>`
- `AUTH_ISSUER=<from local env / WorkOS>`
- `AUTH_AUDIENCE=<from local env / WorkOS>`
- `AUTH_JWKS_URL=<from local env / WorkOS>`
- `SOLANA_NETWORK=devnet`
- `PROGRAM_ID=82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd`
- `SOLANA_KEYPAIR_SECRET_NAME=agora-solana-devnet-keypair`
- `SOLANA_KEYPAIR_SECRET_PROJECT=agora-ai-1199`
- `AGORA_SANDBOX_RUNNER_URL=<private runner URL once VM is live>`

Local values confirmed present during restore prep:

- `WORKOS_CLIENT_ID=client_01KNVQVZ4B193J74RHVJF3AKVF`
- `WORKOS_AUTHKIT_DOMAIN=https://healthy-flare-22-staging.authkit.app`
- `AUTH_ISSUER=https://api.workos.com`
- `AUTH_AUDIENCE=client_01KNVQVZ4B193J74RHVJF3AKVF`
- `AUTH_JWKS_URL=https://api.workos.com/sso/jwks/client_01KNVQVZ4B193J74RHVJF3AKVF`

CLI update commands once a token with GitHub Actions admin permissions is available:

```bash
gh variable set GCP_RUNTIME_SERVICE_ACCOUNT --repo zahemen9900/agora --body 'agora-api-runtime@agora-ai-1199.iam.gserviceaccount.com'
gh variable set AGORA_GCS_BUCKET --repo zahemen9900/agora --body 'agora-ai-1199-agora-data'
gh variable set AGORA_COORDINATION_NAMESPACE --repo zahemen9900/agora --body 'agora-prod'
gh variable set WORKOS_CLIENT_ID --repo zahemen9900/agora --body 'client_01KNVQVZ4B193J74RHVJF3AKVF'
gh variable set WORKOS_AUTHKIT_DOMAIN --repo zahemen9900/agora --body 'https://healthy-flare-22-staging.authkit.app'
gh variable set AUTH_ISSUER --repo zahemen9900/agora --body 'https://api.workos.com'
gh variable set AUTH_AUDIENCE --repo zahemen9900/agora --body 'client_01KNVQVZ4B193J74RHVJF3AKVF'
gh variable set AUTH_JWKS_URL --repo zahemen9900/agora --body 'https://api.workos.com/sso/jwks/client_01KNVQVZ4B193J74RHVJF3AKVF'
gh variable set SOLANA_NETWORK --repo zahemen9900/agora --body 'devnet'
gh variable set PROGRAM_ID --repo zahemen9900/agora --body '82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd'
gh variable set SOLANA_KEYPAIR_SECRET_NAME --repo zahemen9900/agora --body 'agora-solana-devnet-keypair'
gh variable set SOLANA_KEYPAIR_SECRET_PROJECT --repo zahemen9900/agora --body 'agora-ai-1199'
```

At restore time, also set these secrets with an Actions-admin-capable token:

```bash
gh secret set GCP_PROJECT_ID --repo zahemen9900/agora --body 'agora-ai-1199'
gh secret set GCP_SERVICE_ACCOUNT --repo zahemen9900/agora --body 'github-deploy@agora-ai-1199.iam.gserviceaccount.com'
gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER --repo zahemen9900/agora --body '<provider-resource-name>'
```

## Verification checklist

- `gcloud services list --enabled --project agora-ai-1199`
- `gcloud artifacts repositories list --project agora-ai-1199 --location us-central1`
- `gcloud storage buckets list --project agora-ai-1199`
- `gcloud redis instances list --project agora-ai-1199 --region us-central1`
- `gcloud secrets list --project agora-ai-1199`
- `gcloud run services list --project agora-ai-1199 --region us-central1`
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
