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

### Publish (When Authorized)

```bash
python -m twine upload --repository pypi sdk/dist/*
```

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
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/agora/${SERVICE}:$(git rev-parse --short HEAD)"

gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet
gcloud builds submit --config api/cloudbuild.yaml --substitutions "_IMAGE=${IMAGE}" .
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --platform managed \
  --update-env-vars "AUTH_REQUIRED=true,AGORA_API_KEY_PEPPER=<secret>,AUTH_ISSUER=<issuer>,AUTH_AUDIENCE=<audience>,AUTH_JWKS_URL=<jwks-url>" \
  --allow-unauthenticated
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
