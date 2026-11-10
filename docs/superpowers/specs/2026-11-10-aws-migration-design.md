# Agora Backend AWS Migration — Design

**Date:** 2026-11-10
**Status:** Proposed
**Owner:** David Zahemen Yeboah
**AWS account:** `866160682016` (us-east-1), reached through the existing `gsl-admin` SSO profile

## Intent

The hosted Agora backend is down because the GCP project `agora-ai-1190` is suspended:

```text
Consumer 'projects/641336811134' has been suspended.
```

The hosted Cloud Run URL returns `404`, and the last Deploy workflow fails at Google authentication for that reason. GCP billing is enabled, so this is a project-level suspension rather than a simple billing lapse. The product should move to AWS as its permanent production home.

The monthly budget is **under $30**. That constraint rules out the usual managed stack (ALB + ECS Fargate + NAT Gateway + ElastiCache), which would cost roughly $60–80/month before compute.

## Goals

- Restore hosted Agora on AWS at a stable HTTPS API URL.
- Preserve existing tasks, workspaces, API keys, benchmark artifacts, and uploaded source files.
- Keep the existing product behavior, auth, model providers, tools, and Solana integration.
- Make deployments repeatable from GitHub Actions.
- Keep the total AWS bill below **$30/month** at expected traffic.
- Remove runtime dependence on GCP.

## Non-goals

- Multi-AZ high availability, autoscaling, or zero-downtime deploys.
- Migrating the frontend off Vercel.
- Migrating historical GCP infrastructure or the suspended Cloud Run service.
- Changing product semantics, API shapes, or auth flows.
- Building a general-purpose multi-tenant infrastructure platform.

## Anti-goals

- Exposing Redis or the sandbox runner to the public internet.
- Using root AWS credentials for programmatic access.
- Losing or silently rewriting historical data.
- Invalidating existing `agora_live_` / `agora_test_` API keys.
- Exceeding the monthly budget after the migration.
- Leaving the old GCP project as a hidden runtime dependency.

## Current State

| Component | Current implementation |
|---|---|
| API | FastAPI in `api/`, container port 8080 on GCP Cloud Run |
| Durable state | GCS bucket `agora-ai-1190-agora-data` (83 objects, ~2.3 MB) |
| Coordination | GCP Memorystore Redis `agora-redis-prod` |
| Sandbox | FastAPI runner on a GCE VM, launches sibling Docker containers |
| Images | GCP Artifact Registry |
| Secrets | GCP Secret Manager (14 secrets) |
| Deploy | GitHub Actions → GCP Workload Identity → Cloud Run |
| Frontend | Vercel, rewrites `/api/*` to the Cloud Run URL |
| External | WorkOS, Brave, Gemini/Anthropic/OpenRouter, Axiom, Solana/Helius |

GCS data is still readable while the project is suspended. gcloud is authenticated locally. This makes a data-preserving migration possible.

## Target Architecture

```text
Vercel frontend
      |
      | HTTPS  /api/*  rewrite
      v
Caddy (EC2, 80/443, Let's Encrypt)
      |
      v
api:8080 (FastAPI)
  |         |              |
  |         |              +--> sandbox-runner:8090 --> Docker socket --> runtime image
  |         +-----------------> redis:6379 (private Docker network)
  +---------------------------> S3 (tasks, users, workspaces, API keys, sources, benchmarks)

EC2 instance role --> S3, ECR pull, SSM Parameter Store read, CloudWatch Logs
GitHub Actions OIDC --> ECR push + SSM SendCommand
```

### Host

- One EC2 `t3a.small` (2 vCPU, 2 GB) running Amazon Linux 2023 in `us-east-1`.
- 2 GB swap file to absorb short spikes.
- Concurrency is capped to fit 2 GB: `AGORA_WORKSPACE_CONCURRENT_TASK_RUNS=2`, `AGORA_SANDBOX_MAX_CONCURRENT_RUNS=1`, sandbox CPU `0.5`, memory `512m`. If real load needs 4 GB, the host can be resized to `t3a.medium`; that adds ~$13.72/month and is a deliberate budget decision, not an automatic scaling path.
- 30 GB gp3 EBS volume.
- Elastic IP so the API hostname is stable.
- Instance profile with least-privilege access to S3, ECR, SSM Parameter Store, CloudWatch Logs, and SSM Session Manager.
- No inbound SSH. Administrative shell access is through SSM Session Manager.
- Security group inbound: TCP 80 and 443 from the internet only. No inbound Redis or runner ports.

### Containers (Docker Compose)

| Service | Purpose | Exposure |
|---|---|---|
| `caddy` | TLS termination, reverse proxy to `api` | public 80/443 |
| `api` | existing FastAPI app | internal 8080 |
| `redis` | coordination backend, AOF persistence, password auth | internal 6379 |
| `sandbox-runner` | existing runner from `sandbox_runner_service/Dockerfile`, mounts `/var/run/docker.sock` | internal 8090 |

Redis uses a named volume and `appendonly yes`. It stores coordination locks, stream tickets, and rate-limit counters, not durable product state.

### Storage

- One private S3 bucket, e.g. `agora-866160682016-data`.
- Block Public Access enabled, SSE-S3 encryption, versioning enabled.
- Object key layout is preserved exactly from GCS (`agora/...`, `users/...`, `workspaces/...`, `api_keys/...`).
- `storage_uri` values in stored JSON records are rewritten from `gs://agora-ai-1190-agora-data/...` to `s3://agora-866160682016-data/...`.
- Existing API keys continue to work because the same `AGORA_API_KEY_PEPPER` is copied and key records are preserved.

### Secrets

Use **SSM Parameter Store SecureString** rather than Secrets Manager. Standard parameters are free; Secrets Manager would cost about $5.60/month for 14 secrets, which is a meaningful share of a $30 budget.

Parameters live under `/agora/prod/`. At boot, a small systemd oneshot reads them with the instance role and writes `/opt/agora/.env` with mode `0600`. Docker Compose reads that file.

Secret inventory to copy (names only; values never printed):

- `AGORA_GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `AGORA_OPENROUTER_API_KEY`
- `HELIUS_RPC_URL`
- `AGORA_API_KEY_PEPPER`
- `BENCHMARK_ADMIN_TOKEN`
- `AGORA_AXIOM_TOKEN`
- `AGORA_BRAVE_API_KEY`, `AGORA_BRAVE_API_KEY_2`, `AGORA_BRAVE_API_KEY_3`
- `AGORA_SANDBOX_RUNNER_BEARER_TOKEN`
- `AGORA_REDIS_PASSWORD`
- Solana devnet keypair JSON

WorkOS/AuthKit issuer, audience, JWKS URL, and client ID are configuration, not secrets; they are stored as normal environment values.

### Images and deploys

- Three ECR repositories: `agora-api`, `agora-sandbox-runner`, and `agora-sandbox-runtime`.
- `agora-api` is built from `api/Dockerfile`.
- `agora-sandbox-runner` is built from `sandbox_runner_service/Dockerfile`; this is the FastAPI runner image and includes the Docker CLI.
- `agora-sandbox-runtime` is built from `sandbox_runner_service/runtime-image.Dockerfile`; this is the image the runner launches for user code.
- GitHub Actions builds all three, pushes immutable SHA tags, then uses AWS OIDC to call SSM SendCommand on the instance.
- The instance runs `docker compose pull api sandbox-runner && docker compose up -d api sandbox-runner`; Caddy and Redis stay running.
- Runtime image updates are pulled explicitly on the host and injected through `AGORA_SANDBOX_IMAGE` before the runner is restarted, so the runner never executes a stale cached tag.
- An ECR credential helper plus a systemd timer keeps Docker authenticated for pulls after reboot.

### TLS and URL

- Caddy obtains a Let's Encrypt certificate for a hostname that resolves to the Elastic IP.
- Default hostname: `<elastic-ip>.nip.io` (for example `agora-api.54.1.2.3.nip.io`). This avoids buying or delegating a domain for the first cutover.
- If the user supplies a real subdomain, Caddy and the Vercel rewrite only need the hostname changed. No application code changes.

### Frontend and SDK

- `agora-web/vercel.json` rewrite target changes to the new API URL.
- `agora/sdk/config.py` canonical hosted URL changes to the new API URL.
- README and demo scripts are updated in the same change.
- CORS already allows the Vercel production domains; no API CORS change is needed.
- The SDK version is bumped and a patch release is published after cutover, so installed SDK users stop pointing at the dead Cloud Run URL. The existing `deploy-sdk.yml` workflow handles the publish; it already supports a version-already-published guard.

## Data Migration

1. Create the S3 bucket and IAM roles.
2. `gcloud storage rsync --recursive gs://agora-ai-1190-agora-data /tmp/agora-gcs-export`
3. Rewrite only JSON values whose key is exactly `storage_uri` and whose value starts with `gs://agora-ai-1190-agora-data/`, replacing the prefix with `s3://agora-866160682016-data/`. User-uploaded `.json` content and unrelated `gs://` strings are left untouched.
4. `aws s3 sync /tmp/agora-gcs-export s3://agora-866160682016-data` (first run; no `--delete`, so concurrent new writes are not destroyed).
5. Verify object count, SHA-256 for non-JSON objects, and a semantic JSON diff for rewritten records that ignores only the `storage_uri` prefix change. Confirm every rewritten file still parses as JSON.
6. Keep the local export until the user confirms the AWS data is correct.

The export is ~2.3 MB, so there is no meaningful S3 ingress or GCS egress cost.

## Code Changes

### Storage adapter

Create `api/storage_backends.py` with a small S3 client adapter that implements the subset of the GCS API used by `TaskStore`:

- `bucket(name)` → bucket object
- `bucket.blob(name)` → blob object with `download_as_text()`, `download_as_bytes()`, `upload_from_string(...)`, `exists()`, `delete()`, `generate_signed_url(...)`, `.name`, `.updated`, `.generation`, `.reload()`
- `bucket.list_blobs(prefix=...)`
- Conditional writes using S3 `IfMatch` / `IfNoneMatch`
- Map S3 `NoSuchKey` to `google.api_core.exceptions.NotFound`
- Map failed conditional writes to `PreconditionFailed`

GCS exposes an integer `generation`, while S3 exposes an ETag. The adapter therefore returns the ETag as an opaque generation token, and `TaskStore` passes that token through without `int()` (the helper signature changes from `int | None` to `int | str | None`). This is the only change to the store's append logic; the rest of the ~850-line store stays intact and no interface is duplicated.

### Configuration

Add to `api/config.py`:

- `storage_backend: Literal["gcs", "s3"]` default `gcs`
- `s3_bucket: str` default `""`
- `aws_region: str` default `us-east-1`

`get_store()` accepts the resolved bucket and backend. A helper returns `(backend, bucket)` from settings, used by `api/auth.py`, `api/routes/tasks.py`, and `api/routes/sources.py`.

### Source storage and resolver

- `api/source_storage.py`: emit `s3://` URIs when the store is S3-backed; use the store's client for signed upload URLs and byte reads/writes. Keep `gs://` behavior for GCS.
- `agora/tools/source_resolver.py`: support `s3://` in addition to `gs://` and `file://`.
- `sandbox_runner_service/app.py`: support `s3://` source URIs via boto3.

### Solana keypair

No code change. Set `SOLANA_KEYPAIR_SECRET_NAME=""` and write the keypair JSON to `~/.config/solana/devnet-keypair.json` (or the path in `SOLANA_KEYPAIR_PATH`) at boot. `api/solana_bridge.py` already prefers the file when it exists.

### Provider credentials

Set provider API keys directly as environment variables and leave `GOOGLE_CLOUD_PROJECT` empty. This disables Vertex AI and the GCP Secret Manager fallback. Gemini uses the direct Gemini API key, matching the current deploy workflow.

### Dependencies

- Add `boto3` to `api/requirements.txt` / lock and `sandbox_runner_service/requirements.txt`.
- No new dependency for Redis; `redis` is already present.

### Tests

- S3 adapter unit tests with a fake/injected S3 client: read, write, list, missing key, conditional write success/failure, presigned URL.
- `get_store()` backend selection tests.
- `SourceStorageService` S3 URI and signed-upload tests.
- `SourceResolver` S3 read test.
- Existing test suite must stay green.

## Infrastructure as Code

Terraform under `deploy/aws/terraform/`:

- `providers.tf`, `variables.tf`, `outputs.tf`
- `network.tf`: default VPC/subnet lookup, security group, Elastic IP
- `storage.tf`: S3 bucket, public-access block, encryption, versioning
- `iam.tf`: EC2 instance role/profile, GitHub OIDC provider and deploy role
- `ecr.tf`: API and runtime repositories
- `ssm.tf`: parameter names (values seeded out-of-band)
- `compute.tf`: EC2 instance, user-data bootstrap, EBS
- `dns.tf` (optional): Route 53 record if a real domain is supplied
- `templates/user_data.sh.tftpl`: install Docker, Compose plugin, ECR credential helper, CloudWatch agent; fetch SSM parameters; write `.env`; start Compose

`deploy/aws/docker-compose.yml` and `deploy/aws/Caddyfile` hold the runtime definitions.

No NAT Gateway, ALB, or ElastiCache resources are created.

## Deployment Sequence

1. Bootstrap AWS credentials and Terraform state (local state for the first cutover; optional S3 backend later).
2. `terraform apply` for S3, ECR, IAM, SSM parameter names, security group, EC2, EIP.
3. Seed SSM SecureString values from GCP Secret Manager and local `.env`.
4. Build and push the API and sandbox runtime images.
5. Migrate GCS data to S3 and rewrite storage URIs.
6. Start the Compose stack; wait for Caddy certificate issuance.
7. Verify health, auth config, existing API key, task lifecycle, source upload, sandbox execution.
8. Update Vercel rewrite, SDK canonical URL, README, and demo scripts.
9. Redeploy the Vercel frontend.
10. Monitor for 24 hours; then remove the remaining GCP runtime dependencies.

## Cost Estimate (us-east-1, on-demand)

| Item | Estimated monthly |
|---|---:|
| EC2 `t3a.small` (730 h × $0.0188) | $13.72 |
| 30 GB gp3 EBS | $2.40 |
| Elastic IP (public IPv4) | $3.65 |
| ECR storage (~2 GB) | $0.20 |
| S3 storage/requests (~2.3 MB + growth) | $0.10 |
| CloudWatch Logs (~1 GB ingest) | $1.50 |
| Internet data transfer | $1.00 |
| **Total** | **~$22.57** |

Leaves roughly **$7.43/month** of headroom for traffic growth and incidental requests. If the instance needs 4 GB, `t3a.medium` adds ~$13.72 and breaks the target; the design therefore optimizes for 2 GB with a 2 GB swap file.

## Security

- TLS everywhere; HTTP redirects to HTTPS in Caddy.
- Redis and sandbox runner bind only to the Docker network, never the host's public interface.
- Sandbox runner keeps its bearer-token auth and Docker isolation flags (`--network none`, read-only root, CPU/memory/PID limits).
- S3 bucket is private, encrypted, versioned, and public-access-blocked.
- Instance role is scoped to the one bucket, the two ECR repos, the `/agora/prod/*` parameter path, and CloudWatch Logs.
- No long-lived AWS keys on the instance or on developer machines. Terraform uses the existing `gsl-admin` SSO profile; GitHub uses OIDC.
- Existing API key pepper is preserved, so no keys are invalidated.

## Acceptance Criteria

- `GET /health` returns `200` over HTTPS.
- `GET /auth/config` returns the expected WorkOS/AuthKit values.
- An existing `agora_live_` or `agora_test_` API key authenticates successfully.
- Task create → run → status → event stream completes.
- Source upload-init → upload-bytes → content read works over S3.
- Sandbox `execute_python` runs and returns output/artifacts.
- S3 object count and sample hashes match the GCS export.
- Redis coordination is active (`AGORA_COORDINATION_BACKEND=redis`).
- No public Redis or sandbox runner port.
- AWS Cost Explorer forecast for the account remains below $30/month at expected usage.
- Vercel production frontend can reach the new API through its rewrite.

## Risks and Tradeoffs

| Risk | Mitigation |
|---|---|
| Single EC2 instance means downtime on host failure | Accept for budget; EBS-backed, EIP retained, fast rebuild from Terraform |
| Self-hosted Redis loses data on volume loss | Redis is coordination-only; durable state is S3 |
| `nip.io` hostname availability | Swap to a real subdomain; only Caddy/env/vercel.json change |
| Docker-in-Docker on the host | Keep existing sandbox isolation; restrict runner to internal network; no public port |
| S3 conditional-write semantics differ from GCS | Adapter tests cover `IfMatch`/`IfNoneMatch`; fall back to retry-on-conflict if needed |
| GCS→S3 URI rewrite corrupts JSON | Work on an export copy, validate JSON parse and hashes, keep the export until sign-off |
| ECR pull auth expires after reboot | ECR credential helper + systemd timer refresh |
| SSO session expires during provisioning | Re-run `aws sso login --profile gsl-admin`; Terraform state makes the retry safe |
| Account has unrelated spend that eats the budget | Current month is $0.27; check Cost Explorer before and after provisioning |

## Decisions Made by the Builder

These are implementation calls, not user requirements:

- Single EC2 + Docker Compose instead of managed AWS services, forced by the $30 ceiling.
- SSM Parameter Store instead of Secrets Manager, for cost.
- Caddy + `nip.io` instead of ALB + ACM, for cost and simplicity.
- Self-hosted Redis instead of ElastiCache, for cost.
- `us-east-1` as the target region, matching the console session.
- Vercel remains the frontend host.

## Open Items for the User

1. **Domain:** use the default `nip.io` hostname for cutover, or provide a real subdomain? Default is `nip.io`.
2. **Isolated workspace:** create a git worktree for this migration, or work on `main` in place? Recommended: worktree.
