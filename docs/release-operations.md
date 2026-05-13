# Release and Deploy Operations

## Decisions (2026-04-21)

- SDK release mode: hybrid.
- Preferred SDK publish path: GitHub trusted publishing via `.github/workflows/deploy-sdk.yml`.
- Production deploy path: Artifact Registry via Cloud Build, then Cloud Run deploy.
- GHCR role: CI/reference image mirror only, not canonical production source.

## SDK Release Runbook (Trusted Publishing, Current Cycle)

Target package: `agora-arbitrator-sdk==0.1.0a18`

Version discipline:

- `agora/version.py` is the canonical backend/SDK runtime version source.
- Repo-root `pyproject.toml` and `sdk/pyproject.toml` must be bumped in the same change.
- Do not cut an `sdk-v*` tag unless the built wheel passes an isolated install/import smoke.

### Prerequisites

- Python 3.11+
- PyPI project configured with the GitHub trusted publisher
- GitHub Actions access to run `.github/workflows/deploy-sdk.yml`

### Build and Validate

```bash
python -m pip install --upgrade pip build twine
python -m build sdk
python -m twine check sdk/dist/*
```

The public SDK package is `agora-arbitrator-sdk`. Source code lives in the
repo-root `agora/` tree; the `sdk/` directory is metadata-only and remains the
canonical build entrypoint for release operations.

The SDK now resolves the canonical hosted Cloud Run backend by default, so release smoke
and install checks do not need a manual hosted API URL.

### Publish (Preferred)

```bash
git tag sdk-v0.1.0a18
git push origin sdk-v0.1.0a18
```

Trusted publishing is wired for the repository in `.github/workflows/deploy-sdk.yml`
using the PyPI project settings for `agora-arbitrator-sdk` / `zahemen9900` / `agora` / `pypi`.
Tag pushes matching `sdk-v*` publish automatically. Manual `workflow_dispatch`
is still available as fallback. Local `twine upload` is fallback-only for emergency recovery.

### Post-Publish Verification

```bash
python -m venv /tmp/agora-arbitrator-sdk-verify
source /tmp/agora-arbitrator-sdk-verify/bin/activate
python -m pip install --upgrade pip
python -m pip install agora-arbitrator-sdk==0.1.0a18
python - <<'PY'
from agora.sdk import AgoraArbitrator, AgoraNode, ReceiptVerificationError
print("sdk-import-ok")
PY
```

### Notes

- Build and import checks were completed in-repo during this cycle.
- Preferred publish path is GitHub OIDC trusted publishing, not a local API token.

## Future Automation Plan (Next Cycle)

Planned CI shape:

1. Trigger on signed tag pattern (example: `sdk-v*`).
2. Build and validate artifacts (`python -m build sdk`, `twine check`).
3. Publish with PyPI OIDC trusted publishing or repository secret fallback.
4. Attach artifacts to GitHub release.
5. Run install/import smoke gate after publish.

## Deploy Runbook (Artifact Registry Canonical)

Production deploy workflow is defined in `.github/workflows/deploy.yml` and uses `api/cloudbuild.yaml`.

### CI-Driven Deploy (Canonical)

- Trigger: push to `main` or manual `workflow_dispatch`
- Build: Cloud Build builds `api/Dockerfile`
- Registry: `us-central1-docker.pkg.dev/<project>/agora/agora-api:<sha>`
- Deploy target: Cloud Run service `agora-api` in `us-central1`
- Verification: workflow checks `GET /health` after deployment

### Manual Equivalent (Ops)

```bash
PROJECT_ID="<gcp-project-id>"
REGION="us-central1"
SERVICE="agora-api"
RUNTIME_SA="<runtime-service-account-email>"
GCS_BUCKET="<durable-gcs-bucket>"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/agora/${SERVICE}:$(git rev-parse --short HEAD)"

gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet
gcloud builds submit --config api/cloudbuild.yaml \
  --substitutions "_REGION=${REGION},_REPOSITORY=agora,_SERVICE=${SERVICE},_TAG=$(git rev-parse --short HEAD)" .
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --platform managed \
  --memory 1Gi \
  --concurrency 16 \
  --service-account "${RUNTIME_SA}" \
  --network default \
  --subnet default \
  --vpc-egress private-ranges-only \
  --update-env-vars "AGORA_ENVIRONMENT=production,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GCS_BUCKET=${GCS_BUCKET},AUTH_REQUIRED=true,AGORA_COORDINATION_BACKEND=redis,AGORA_COORDINATION_NAMESPACE=agora-prod,AGORA_FLASH_MODEL=gemini-3.1-flash-lite-preview,AGORA_PRO_MODEL=gemini-3-flash-preview,AGORA_CLAUDE_MODEL=claude-sonnet-4-6,AGORA_OPENROUTER_MODEL=qwen/qwen3.5-flash-02-23,AGORA_OPENROUTER_ANALYSIS_MODEL=google/gemma-4-31b-it,AGORA_WORKOS_CLIENT_ID=<workos-client-id>,AGORA_WORKOS_AUTHKIT_DOMAIN=<authkit-domain>,AGORA_AUTH_ISSUER=<issuer>,AGORA_AUTH_AUDIENCE=<audience>,AGORA_AUTH_JWKS_URL=<jwks-url>,SOLANA_NETWORK=devnet,PROGRAM_ID=82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd,SOLANA_KEYPAIR_SECRET_NAME=agora-solana-devnet-keypair,SOLANA_KEYPAIR_SECRET_PROJECT=${PROJECT_ID},SOLANA_KEYPAIR_SECRET_VERSION=latest,AGORA_SANDBOX_RUNNER_URL=http://10.128.0.2:8080,AGORA_SANDBOX_EXECUTION_TIMEOUT_SECONDS=20,AGORA_SOURCE_MAX_FILE_BYTES=5242880,AGORA_SOURCE_MAX_ATTACHMENTS_PER_TASK=3,AGORA_BACKGROUND_RECOVERY_ENABLED=true,AGORA_BACKGROUND_RECOVERY_POLL_SECONDS=30,AGORA_BACKGROUND_RECOVERY_STALE_SECONDS=420,AGORA_BACKGROUND_RECOVERY_SCAN_LIMIT=500,AGORA_TASK_CREATE_RATE_LIMIT_PER_MINUTE=60,AGORA_TASK_RUN_RATE_LIMIT_PER_MINUTE=30,AGORA_WORKSPACE_CONCURRENT_TASK_RUNS=4,AGORA_AXIOM_ENABLED=true,AGORA_AXIOM_TRACES_DATASET=agora-traces,AGORA_AXIOM_BASE_URL=https://api.axiom.co,AGORA_AXIOM_CAPTURE_CONTENT=metadata_only" \
  --update-secrets "AGORA_GEMINI_API_KEY=agora-gemini-api-key:latest,ANTHROPIC_API_KEY=agora-anthropic-api-key:latest,AGORA_OPENROUTER_API_KEY=agora-openrouter-api-key:latest,HELIUS_RPC_URL=agora-helius-rpc-url:latest,AGORA_API_KEY_PEPPER=agora-api-key-pepper:latest,AGORA_REDIS_URL=agora-redis-url:latest,BENCHMARK_ADMIN_TOKEN=agora-benchmark-admin-token:latest,AGORA_AXIOM_TOKEN=agora-axiom-token:latest,AGORA_BRAVE_API_KEY=agora-brave-api-key:latest,AGORA_BRAVE_API_KEY_2=agora-brave-api-key-2:latest,AGORA_BRAVE_API_KEY_3=agora-brave-api-key-3:latest,AGORA_SANDBOX_RUNNER_BEARER_TOKEN=agora-sandbox-runner-bearer-token:latest" \
  --allow-unauthenticated \
  --no-invoker-iam-check
```

### Sandbox Runner Baseline

The hosted API now depends on the Docker sandbox runner. Production restore is not
complete unless the runner host is live and reachable from Cloud Run.

Current baseline:

- dedicated `e2-small` runner VM in `us-central1-a`
- authenticated HTTP runner on `http://10.128.0.2:8080`
- runtime image: `agora-sandbox-runtime`
- bearer secret: `agora-sandbox-runner-bearer-token`
- Cloud Run receives `AGORA_SANDBOX_RUNNER_URL` and `AGORA_SANDBOX_RUNNER_BEARER_TOKEN`

If API health is green but tool-backed runs fail with runner `500`s, verify the runner
container has both:

- `/var/run/docker.sock` mounted
- a visible `docker` client binary inside the runner container

### Post-Deploy Check

```bash
curl -sS "https://<cloud-run-url>/benchmarks" | head
```

Current service baseline:

- Memory: `1Gi`
- Container concurrency: `16`

## Container Registry Policy

Container image delivery is Artifact Registry only. CI no longer publishes GHCR images.

## Rollback

```bash
gcloud run revisions list --service agora-api --region us-central1 --project <gcp-project-id>
gcloud run services update-traffic agora-api --region us-central1 --project <gcp-project-id> --to-revisions <good-revision>=100
```
