# Release and Deploy Operations

## Decisions (2026-04-14)

- SDK release mode: hybrid.
- This cycle: document and verify release readiness, do not publish to PyPI yet.
- Production deploy path: Artifact Registry via Cloud Build, then Cloud Run deploy.
- GHCR role: CI/reference image mirror only, not canonical production source.

## SDK Release Runbook (Manual, Current Cycle)

Target package: `agora-sdk==0.1.0a1`

### Prerequisites

- Python 3.11+
- PyPI account with project access
- `TWINE_USERNAME` and `TWINE_PASSWORD` exported (or token-based equivalent)

### Build and Validate

```bash
python -m pip install --upgrade pip build twine
python -m build sdk
python -m twine check sdk/dist/*
```

The SDK now resolves the canonical hosted Cloud Run backend by default, so release smoke
and install checks do not need a manual hosted API URL.

### Publish (When Authorized)

```bash
python -m twine upload --repository pypi sdk/dist/*
```

Trusted publishing is wired for the repository in `.github/workflows/publish-sdk.yml`
using the PyPI project settings for `agora-sdk` / `zahemen9900` / `agora` / `pypi`.
This cycle keeps the publish step manual; the workflow is ready for the next authorization
without requiring a new setup pass.

### Post-Publish Verification

```bash
python -m venv /tmp/agora-sdk-verify
source /tmp/agora-sdk-verify/bin/activate
python -m pip install --upgrade pip
python -m pip install agora-sdk==0.1.0a1
python - <<'PY'
from agora.sdk import AgoraArbitrator, AgoraNode, ReceiptVerificationError
print("sdk-import-ok")
PY
```

### Notes

- Build and import checks were completed in-repo during this cycle.
- Live PyPI upload remains intentionally manual and pending maintainer approval.

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
  --service-account "${RUNTIME_SA}" \
  --network default \
  --subnet default \
  --vpc-egress private-ranges-only \
  --update-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GCS_BUCKET=${GCS_BUCKET},AUTH_REQUIRED=true,AGORA_COORDINATION_BACKEND=redis,AGORA_COORDINATION_NAMESPACE=agora-prod,AGORA_FLASH_MODEL=gemini-3.1-flash-lite-preview,AGORA_PRO_MODEL=gemini-3-flash-preview,AGORA_WORKOS_CLIENT_ID=<workos-client-id>,AGORA_WORKOS_AUTHKIT_DOMAIN=<authkit-domain>,AGORA_AUTH_ISSUER=<issuer>,AGORA_AUTH_AUDIENCE=<audience>,AGORA_AUTH_JWKS_URL=<jwks-url>,SOLANA_NETWORK=devnet,PROGRAM_ID=82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd,SOLANA_KEYPAIR_SECRET_NAME=agora-solana-devnet-keypair,SOLANA_KEYPAIR_SECRET_PROJECT=${PROJECT_ID},SOLANA_KEYPAIR_SECRET_VERSION=latest" \
  --update-secrets "AGORA_GEMINI_API_KEY=agora-gemini-api-key:latest,ANTHROPIC_API_KEY=agora-anthropic-api-key:latest,AGORA_OPENROUTER_API_KEY=agora-openrouter-api-key:latest,HELIUS_RPC_URL=agora-helius-rpc-url:latest,AGORA_API_KEY_PEPPER=agora-api-key-pepper:latest,AGORA_REDIS_URL=agora-redis-url:latest,BENCHMARK_ADMIN_TOKEN=agora-benchmark-admin-token:latest" \
  --allow-unauthenticated \
  --no-invoker-iam-check
```

### Post-Deploy Check

```bash
curl -sS "https://<cloud-run-url>/benchmarks" | head
```

## Container Registry Policy

Container image delivery is Artifact Registry only. CI no longer publishes GHCR images.

## Rollback

```bash
gcloud run revisions list --service agora-api --region us-central1 --project <gcp-project-id>
gcloud run services update-traffic agora-api --region us-central1 --project <gcp-project-id> --to-revisions <good-revision>=100
```
