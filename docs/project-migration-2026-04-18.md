# Agora Project Migration - 2026-04-18

This document records the `signify-ai` remediation work and the production cutover to
`agora-ai-493714`.

## Completed

- Revoked the remaining user-managed key on
  `ghsl-storage-accessor@even-ally-480821-f3.iam.gserviceaccount.com`.
- Removed `roles/editor` from the old project's default compute service account.
- Removed the stray human Gmail principals from the old project's `roles/editor` binding.
- Removed `ghsl-storage-accessor` project roles that enabled token creation, Run invocation,
  and bucket reads.
- Deleted the duplicated local JSON key files from:
  - `/home/zahemen/projects/dl-lib/agora/.credentials/`
  - `/home/zahemen/projects/dl-lib/gsl-tests/.credentials/`
- Created the new production project baseline in `agora-ai-493714`:
  - Artifact Registry repo: `agora`
  - GCS bucket: `agora-ai-493714-agora-data`
  - Redis instance: `agora-redis-prod`
  - Runtime service account: `agora-api-runtime@agora-ai-493714.iam.gserviceaccount.com`
  - Deploy service account: `github-deploy@agora-ai-493714.iam.gserviceaccount.com`
  - GitHub OIDC provider:
    `projects/641336811134/locations/global/workloadIdentityPools/github-actions/providers/github`
- Created and granted runtime access to the new secrets:
  - `agora-gemini-api-key`
  - `agora-anthropic-api-key`
  - `agora-openrouter-api-key`
  - `agora-helius-rpc-url`
  - `agora-solana-devnet-keypair`
  - `agora-api-key-pepper`
  - `agora-benchmark-admin-token`
  - `agora-redis-url`
  - `agora-test-api-key`
- Deployed Cloud Run service `agora-api` in `us-central1`.
- Enabled direct VPC egress and public access via `--no-invoker-iam-check`.
- Updated repo deploy defaults and frontend rewrite targets to the new backend URL.
- Published a Vercel production deployment after adding `.vercelignore` to exclude local
  ledger and virtualenv artifacts.
- During the follow-up pass, disabled Vercel Authentication for the production project and
  published a fresh production frontend deployment.
- Updated repo defaults so the Gemini "pro" tier uses `gemini-3-flash-preview` and the
  Gemini "flash" tier uses `gemini-3.1-flash-lite-preview`.
- Updated task storage code so new tasks write under `agora/users/{workspaceId}/tasks/`
  while retaining read/append/list fallback for the previous `users/{workspaceId}/tasks/`
  prefix.
- Updated local benchmark backfill to upload all `benchmarks/results/*.json` files into
  `agora/benchmarks/` with `source: "local_backfill"`.
- Redeployed Cloud Run revision `agora-api-00003-bxb` after the model downgrade and
  fresh storage-prefix changes.
- Backfilled six local benchmark artifacts into:
  `gs://agora-ai-493714-agora-data/agora/benchmarks/`.

## Current Production Endpoints

- Cloud Run: `https://agora-api-dcro4pg6ca-uc.a.run.app`
- Alternate Cloud Run URL: `https://agora-api-641336811134.us-central1.run.app`
- Vercel deployment:
  `https://agora-jnrqxnbw1-david-yeboahs-projects-f7fd8878.vercel.app`
- Vercel production aliases:
  - `https://agora-bay-seven.vercel.app`
  - `https://agora-david-yeboahs-projects-f7fd8878.vercel.app`
  - `https://agora-zahemen9900-david-yeboahs-projects-f7fd8878.vercel.app`

## Validated

- `/health` on the new Cloud Run service returns `200 OK`.
- `/auth/config` returns the expected WorkOS/AuthKit config.
- `/auth/me` succeeds with the seeded bootstrap API key stored in Secret Manager.
- `/benchmarks/catalog?include_demo=true` returns the backfilled global benchmark catalog.
- Hosted task creation succeeds with a seeded workspace API key.
- Hosted task execution completes for a forced `vote` run.
- Secret Manager, GCS, Redis, Artifact Registry, and Cloud Run wiring all function in the
  new project.
- Vercel production no longer returns Vercel Authentication / SSO protection and `/api/health`
  works through the Vercel rewrite.
- Focused backend tests pass with dummy provider credentials:
  `67 passed, 2 skipped`.
- Frontend production build passes with the existing large bundle warning.

## Not Yet Migrated

- Historical GCS data from `signify-ai` is intentionally no longer a launch blocker.
- Existing API keys from the old project are intentionally discarded; fresh API keys should
  be issued from the new project.
- Human-authenticated benchmark runs were not validated in the new project because no live
  human WorkOS JWT was available during automation.
- Project IAM could not add `user:jkdodofoli@gmail.com` because the inherited
  `constraints/iam.allowedPolicyMemberDomains` policy only permits the organization
  customer ID `C00hb9234`.
- A temporary project-level Domain Restricted Sharing override was attempted, but the
  active account lacks `orgpolicy.policies.create` on `projects/641336811134`. An
  organization/folder admin or principal with Org Policy Administrator must apply the
  temporary override before a personal Gmail can be granted.
- Granting `roles/orgpolicy.policyAdmin` at the project level was also attempted, but GCP
  rejects that role on project resources; this must be handled at the organization or
  folder level.

## Follow-up

- To temporarily allow the teammate's Gmail, an org-policy-capable admin should apply a
  project-level override, grant Editor, then remove the override if policy validation permits
  it:
  - `constraints/iam.allowedPolicyMemberDomains` on project `641336811134`
  - temporary rule: `allowAll: true`, `inheritFromParent: false`
  - grant: `gcloud projects add-iam-policy-binding agora-ai-493714 --member=user:jkdodofoli@gmail.com --role=roles/editor --condition=None`
  - preferred long-term fix: issue a managed `@signify-ai.org` account and grant that
    instead, so the org policy remains intact.
- After a real human WorkOS JWT is available, run one minimal benchmark:
  `agent_count=4`, `training_per_category=1`, `holdout_per_category=1`, `live_agents=true`.
- GitHub Actions repository secrets and variables now point at the new project:
  - secrets: `GCP_PROJECT_ID`, `GCP_SERVICE_ACCOUNT`, `GCP_WORKLOAD_IDENTITY_PROVIDER`
  - variables: `AGORA_COORDINATION_NAMESPACE`, `AGORA_GCS_BUCKET`,
    `AUTH_AUDIENCE`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `GCP_RUNTIME_SERVICE_ACCOUNT`,
    `PROGRAM_ID`, `SOLANA_KEYPAIR_SECRET_NAME`, `SOLANA_KEYPAIR_SECRET_PROJECT`,
    `SOLANA_NETWORK`, `WORKOS_AUTHKIT_DOMAIN`, `WORKOS_CLIENT_ID`
