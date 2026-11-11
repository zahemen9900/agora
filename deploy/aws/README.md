# Agora AWS Migration Runbook

This directory holds the AWS deployment runbook, Terraform, Compose, Caddy, and host scripts for the migration described in:

- Design: `docs/superpowers/specs/2026-11-10-aws-migration-design.md`
- Plan: `docs/superpowers/plans/2026-11-10-aws-migration-plan.md`

## Fixed identifiers

| Item | Value |
|---|---|
| AWS account | `866160682016` |
| Region | `us-east-1` |
| AWS profile | `gsl-admin` (SSO) |
| Data bucket | `agora-866160682016-data` |
| API hostname default | `agora-api.<elastic-ip>.nip.io` |
| Repository | `https://github.com/zahemen9900/agora.git` |
| Deployment branch | `main` |

No credentials belong in this directory. Secret values live in SSM Parameter Store under `/agora/prod/`.

## Baseline test evidence

Recorded on 2026-11-10 from commit `4cdf9057bb26399a8b94444a7418293097c0608d` in the migration worktree, using Python 3.11 and `api/requirements.lock`:

```text
24 failed, 457 passed, 2 skipped, 4 deselected
```

The failures are pre-existing and unrelated to the AWS migration:

```text
tests/test_api_infra_routes.py  (15 failures)
tests/test_e2e.py::test_local_api_e2e_flow
tests/test_orchestrator.py      (5 failures: fake run signatures)
tests/test_restore_scripts.py::test_restore_script_builds_runner_service_image
tests/test_sdk_packaging_layout.py::test_runtime_and_package_versions_stay_in_sync
```

Do not claim the full suite is green until these are fixed or explicitly accepted. New AWS work must keep the existing 457 passing tests passing.

## Required local tools

- AWS CLI v2 with the `gsl-admin` SSO profile
- Terraform 1.13+
- Docker Engine/Compose v2.30+
- `gcloud` authenticated to `agora-ai-1190`
- Python 3.11 and `uv`

## Provisioning gates

Before creating compute:

1. `aws sso login --profile gsl-admin`
2. `aws sts get-caller-identity --profile gsl-admin` must report `866160682016`.
3. `pytest tests/ -q -m 'not paid_integration and not localnet_integration'` baseline is recorded above.
4. GCS export is re-inventoried: 34 objects expected before migration (verified 2,321,767 bytes).
5. AWS account spend is below the operational gate of $28 projected.

## Data export location

Use a protected local directory outside the repository:

```bash
export EXPORT_ROOT=/tmp/opencode/agora-aws-migration
```

The migration script keeps immutable `original/` and `rewritten/` trees plus a manifest outside the uploaded object directories. Keep the export until the user signs off on the AWS data.

## Secret seeding

Secrets are copied from GCP Secret Manager into SSM Parameter Store SecureString parameters under `/agora/prod/`. The seeder must never print values, write them to Terraform, or pass them as shell arguments. See `scripts/aws_seed_secrets.py` when it lands.

## Completed during migration

- 2026-11-11: Terraform foundation applied. Created the private S3 bucket, three ECR repositories, GitHub OIDC provider and deploy role, EC2 instance role/profile, security group, CloudWatch log groups, SSM deploy document, and IAM policies. No EC2 instance yet.
- 2026-11-11: 13 SSM SecureString parameters created under `/agora/prod/` from GCP Secret Manager. Pepper equality verified; Solana keypair bytes and public key equality verified. No secret values were printed.
- 2026-11-11: GCS export verified at 34 objects / 2,321,767 bytes. Two source records had `storage_uri` rewritten from `gs://agora-ai-1190-agora-data/` to `s3://agora-866160682016-data/`; all other objects were copied byte-for-byte, including both API-key records.
- 2026-11-11: S3 conditional-write smoke test passed against the real bucket: create-only, duplicate-create rejection, fresh ETag update, stale ETag rejection, read-back, and cleanup.
- 2026-11-11: Presigned browser-style PUT passed against the real bucket after forcing SigV4: first PUT 200, replay PUT 412 with `If-None-Match: *`.
- 2026-11-11: Host-wide task/benchmark admission and sandbox capability/output bounds added to the migration branch.
- The deployment workflow is `.github/workflows/deploy-aws.yml`; it builds all three linux/amd64 images and publishes `_deploy/releases/<sha>/bundle.tar.gz`.

## Cutover gates

Do not point Vercel or the SDK at AWS until these pass:

- Real S3 conditional-write and browser presigned-PUT tests
- Pepper/keypair equality and an existing API-key authentication test
- Trusted TLS on the API hostname
- 30-minute mixed load plus reboot at the 2-active-run cap
- Rollback rehearsal to the previous AWS release
- Data manifest verification and API-key/index byte equality
