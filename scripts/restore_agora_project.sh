#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROJECT_ID="${PROJECT_ID:-agora-ai-1199}"
PROJECT_NAME="${PROJECT_NAME:-agora-ai}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-us-central1-a}"
REPOSITORY="${REPOSITORY:-agora}"
SERVICE_NAME="${SERVICE_NAME:-agora-api}"
RUNTIME_IMAGE_NAME="${RUNTIME_IMAGE_NAME:-agora-sandbox-runtime}"
REDIS_INSTANCE_NAME="${REDIS_INSTANCE_NAME:-agora-redis-prod}"
RUNTIME_SA_NAME="${RUNTIME_SA_NAME:-agora-api-runtime}"
DEPLOY_SA_NAME="${DEPLOY_SA_NAME:-github-deploy}"
RUNNER_VM_NAME="${RUNNER_VM_NAME:-agora-sandbox-runner}"
COORDINATION_NAMESPACE="${COORDINATION_NAMESPACE:-agora-prod}"
PROGRAM_ID="${PROGRAM_ID:-82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd}"
SOLANA_NETWORK="${SOLANA_NETWORK:-devnet}"
RUNNER_MACHINE_TYPE="${RUNNER_MACHINE_TYPE:-e2-small}"
RUNNER_IMAGE_FAMILY="${RUNNER_IMAGE_FAMILY:-ubuntu-2204-lts}"
RUNNER_IMAGE_PROJECT="${RUNNER_IMAGE_PROJECT:-ubuntu-os-cloud}"
RUNNER_TAG="${RUNNER_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD)}"

BUCKET_NAME="${BUCKET_NAME:-${PROJECT_ID}-agora-data}"
RUNTIME_SA_EMAIL="${RUNTIME_SA_EMAIL:-${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com}"
DEPLOY_SA_EMAIL="${DEPLOY_SA_EMAIL:-${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com}"

REQUIRED_SERVICES=(
  run.googleapis.com
  artifactregistry.googleapis.com
  secretmanager.googleapis.com
  redis.googleapis.com
  compute.googleapis.com
  cloudbuild.googleapis.com
  iamcredentials.googleapis.com
  vpcaccess.googleapis.com
  storage.googleapis.com
)

REQUIRED_SECRETS=(
  agora-gemini-api-key
  agora-anthropic-api-key
  agora-openrouter-api-key
  agora-helius-rpc-url
  agora-solana-devnet-keypair
  agora-api-key-pepper
  agora-benchmark-admin-token
  agora-redis-url
  agora-test-api-key
  agora-axiom-token
  agora-brave-api-key
  agora-brave-api-key-2
  agora-brave-api-key-3
  agora-sandbox-runner-bearer-token
)

usage() {
  cat <<'EOF'
Usage: ./scripts/restore_agora_project.sh <command>

Commands:
  preflight          Validate auth, project access, and billing
  enable-services    Enable required Google APIs
  create-core        Create Artifact Registry, bucket, service accounts, and Redis
  create-secrets     Create empty Secret Manager entries if missing
  build-images       Build API image and sandbox runtime image in Artifact Registry
  deploy-runner      Create/update the sandbox-runner VM bootstrap script
  deploy-api         Deploy Cloud Run using the current repo config
  full-restore       Run all of the above in order

Environment overrides:
  PROJECT_ID, PROJECT_NAME, REGION, ZONE, BUCKET_NAME, PROGRAM_ID, SOLANA_NETWORK
EOF
}

log() {
  printf '[info] %s\n' "$*"
}

die() {
  printf '[error] %s\n' "$*" >&2
  exit 1
}

require_gcloud() {
  command -v gcloud >/dev/null 2>&1 || die "gcloud is required"
}

require_billing() {
  local billing_state
  billing_state="$(gcloud beta billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || true)"
  [[ "$billing_state" == "True" || "$billing_state" == "true" ]] || die \
    "Billing is not enabled for $PROJECT_ID. Attach billing before provisioning."
}

preflight() {
  require_gcloud
  log "Project: $PROJECT_ID ($PROJECT_NAME)"
  gcloud projects describe "$PROJECT_ID" --format='yaml(projectId,name,projectNumber,lifecycleState,parent)'
  gcloud beta billing projects describe "$PROJECT_ID"
}

enable_services() {
  require_gcloud
  require_billing
  log "Enabling required services in $PROJECT_ID"
  gcloud services enable "${REQUIRED_SERVICES[@]}" --project "$PROJECT_ID"
}

create_core() {
  require_gcloud
  require_billing

  log "Ensuring Artifact Registry repository exists"
  gcloud artifacts repositories describe "$REPOSITORY" \
    --location "$REGION" \
    --project "$PROJECT_ID" >/dev/null 2>&1 || \
    gcloud artifacts repositories create "$REPOSITORY" \
      --repository-format=docker \
      --location "$REGION" \
      --description="Agora runtime images" \
      --project "$PROJECT_ID"

  log "Ensuring GCS bucket exists"
  gcloud storage buckets describe "gs://${BUCKET_NAME}" >/dev/null 2>&1 || \
    gcloud storage buckets create "gs://${BUCKET_NAME}" \
      --project "$PROJECT_ID" \
      --location "$REGION" \
      --uniform-bucket-level-access

  log "Ensuring service accounts exist"
  gcloud iam service-accounts describe "$RUNTIME_SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1 || \
    gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
      --display-name="Agora API runtime" \
      --project "$PROJECT_ID"
  gcloud iam service-accounts describe "$DEPLOY_SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1 || \
    gcloud iam service-accounts create "$DEPLOY_SA_NAME" \
      --display-name="Agora GitHub deploy" \
      --project "$PROJECT_ID"

  log "Granting runtime storage + secret access"
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role="roles/storage.objectAdmin" \
    --condition=None >/dev/null
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --condition=None >/dev/null

  log "Ensuring Redis instance exists"
  gcloud redis instances describe "$REDIS_INSTANCE_NAME" \
    --region "$REGION" \
    --project "$PROJECT_ID" >/dev/null 2>&1 || \
    gcloud redis instances create "$REDIS_INSTANCE_NAME" \
      --project "$PROJECT_ID" \
      --region "$REGION" \
      --size=1 \
      --redis-version=redis_7_2 \
      --network=default \
      --connect-mode=direct-peering
}

create_secrets() {
  require_gcloud
  require_billing
  for secret_name in "${REQUIRED_SECRETS[@]}"; do
    if gcloud secrets describe "$secret_name" --project "$PROJECT_ID" >/dev/null 2>&1; then
      log "Secret exists: $secret_name"
      continue
    fi
    log "Creating secret: $secret_name"
    gcloud secrets create "$secret_name" \
      --project "$PROJECT_ID" \
      --replication-policy=automatic
  done
}

build_images() {
  require_gcloud
  require_billing
  log "Configuring Artifact Registry Docker auth"
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

  log "Building API image"
  gcloud builds submit "$ROOT_DIR" \
    --project "$PROJECT_ID" \
    --config "$ROOT_DIR/api/cloudbuild.yaml" \
    --substitutions "_REGION=${REGION},_REPOSITORY=${REPOSITORY},_SERVICE=${SERVICE_NAME},_TAG=${RUNNER_TAG}"

  log "Building sandbox runtime image"
  gcloud builds submit "$ROOT_DIR" \
    --project "$PROJECT_ID" \
    --config "$ROOT_DIR/sandbox_runner_service/runtime-image.cloudbuild.yaml" \
    --substitutions "_REGION=${REGION},_REPOSITORY=${REPOSITORY},_IMAGE=${RUNTIME_IMAGE_NAME},_TAG=${RUNNER_TAG}"
}

deploy_runner() {
  require_gcloud
  require_billing
  local image_uri
  image_uri="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${RUNTIME_IMAGE_NAME}:${RUNNER_TAG}"

  log "Ensuring runner VM exists"
  gcloud compute instances describe "$RUNNER_VM_NAME" \
    --zone "$ZONE" \
    --project "$PROJECT_ID" >/dev/null 2>&1 || \
    gcloud compute instances create "$RUNNER_VM_NAME" \
      --project "$PROJECT_ID" \
      --zone "$ZONE" \
      --machine-type "$RUNNER_MACHINE_TYPE" \
      --service-account "$RUNTIME_SA_EMAIL" \
      --scopes=https://www.googleapis.com/auth/cloud-platform \
      --image-family "$RUNNER_IMAGE_FAMILY" \
      --image-project "$RUNNER_IMAGE_PROJECT" \
      --tags=agora-sandbox-runner

  cat <<EOF
[next-step] Runner VM created or already exists.
SSH in and launch the sandbox service with:

  gcloud compute ssh ${RUNNER_VM_NAME} --zone ${ZONE} --project ${PROJECT_ID}

Then on the VM:

  sudo apt-get update && sudo apt-get install -y docker.io
  sudo usermod -aG docker \$USER
  gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet
  docker pull ${image_uri}
  export AGORA_SANDBOX_RUNNER_BEARER_TOKEN="\$(gcloud secrets versions access latest --secret agora-sandbox-runner-bearer-token --project ${PROJECT_ID})"
  docker run -d --restart unless-stopped \\
    --name agora-sandbox-runner \\
    -p 8080:8080 \\
    -e GOOGLE_CLOUD_PROJECT=${PROJECT_ID} \\
    -e AGORA_SANDBOX_RUNNER_BEARER_TOKEN="\$AGORA_SANDBOX_RUNNER_BEARER_TOKEN" \\
    -v /var/run/docker.sock:/var/run/docker.sock \\
    ${image_uri}
EOF
}

deploy_api() {
  require_gcloud
  require_billing
  local image_uri
  image_uri="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE_NAME}:${RUNNER_TAG}"

  log "Deploying Cloud Run service ${SERVICE_NAME}"
  gcloud run deploy "$SERVICE_NAME" \
    --image "$image_uri" \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --platform managed \
    --memory 1Gi \
    --concurrency 16 \
    --service-account "$RUNTIME_SA_EMAIL" \
    --network default \
    --subnet default \
    --vpc-egress private-ranges-only \
    --update-env-vars "AGORA_ENVIRONMENT=production,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GCS_BUCKET=${BUCKET_NAME},AUTH_REQUIRED=true,AGORA_COORDINATION_BACKEND=redis,AGORA_COORDINATION_NAMESPACE=${COORDINATION_NAMESPACE},AGORA_FLASH_MODEL=gemini-3.1-flash-lite-preview,AGORA_PRO_MODEL=gemini-3-flash-preview,AGORA_CLAUDE_MODEL=claude-sonnet-4-6,AGORA_OPENROUTER_MODEL=qwen/qwen3.5-flash-02-23,AGORA_OPENROUTER_ANALYSIS_MODEL=google/gemma-4-31b-it,AGORA_WORKOS_CLIENT_ID=<workos-client-id>,AGORA_WORKOS_AUTHKIT_DOMAIN=<authkit-domain>,AGORA_AUTH_ISSUER=<issuer>,AGORA_AUTH_AUDIENCE=<audience>,AGORA_AUTH_JWKS_URL=<jwks-url>,SOLANA_NETWORK=${SOLANA_NETWORK},PROGRAM_ID=${PROGRAM_ID},SOLANA_KEYPAIR_SECRET_NAME=agora-solana-devnet-keypair,SOLANA_KEYPAIR_SECRET_PROJECT=${PROJECT_ID},SOLANA_KEYPAIR_SECRET_VERSION=latest,AGORA_SANDBOX_RUNNER_URL=<sandbox-runner-url>,AGORA_SANDBOX_EXECUTION_TIMEOUT_SECONDS=20,AGORA_SOURCE_MAX_FILE_BYTES=5242880,AGORA_SOURCE_MAX_ATTACHMENTS_PER_TASK=3,AGORA_BACKGROUND_RECOVERY_ENABLED=true,AGORA_BACKGROUND_RECOVERY_POLL_SECONDS=30,AGORA_BACKGROUND_RECOVERY_STALE_SECONDS=420,AGORA_BACKGROUND_RECOVERY_SCAN_LIMIT=500,AGORA_TASK_CREATE_RATE_LIMIT_PER_MINUTE=60,AGORA_TASK_RUN_RATE_LIMIT_PER_MINUTE=30,AGORA_WORKSPACE_CONCURRENT_TASK_RUNS=4,AGORA_AXIOM_ENABLED=true,AGORA_AXIOM_TRACES_DATASET=agora-traces,AGORA_AXIOM_BASE_URL=https://api.axiom.co,AGORA_AXIOM_CAPTURE_CONTENT=metadata_only" \
    --update-secrets "AGORA_GEMINI_API_KEY=agora-gemini-api-key:latest,ANTHROPIC_API_KEY=agora-anthropic-api-key:latest,AGORA_OPENROUTER_API_KEY=agora-openrouter-api-key:latest,HELIUS_RPC_URL=agora-helius-rpc-url:latest,AGORA_API_KEY_PEPPER=agora-api-key-pepper:latest,AGORA_REDIS_URL=agora-redis-url:latest,BENCHMARK_ADMIN_TOKEN=agora-benchmark-admin-token:latest,AGORA_AXIOM_TOKEN=agora-axiom-token:latest,AGORA_BRAVE_API_KEY=agora-brave-api-key:latest,AGORA_BRAVE_API_KEY_2=agora-brave-api-key-2:latest,AGORA_BRAVE_API_KEY_3=agora-brave-api-key-3:latest,AGORA_SANDBOX_RUNNER_BEARER_TOKEN=agora-sandbox-runner-bearer-token:latest" \
    --allow-unauthenticated \
    --no-invoker-iam-check

  log "Verifying /health"
  local url
  url="$(gcloud run services describe "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
  curl -fsS "${url}/health"
}

full_restore() {
  preflight
  enable_services
  create_core
  create_secrets
  build_images
  deploy_runner
  deploy_api
}

main() {
  local command="${1:-}"
  case "$command" in
    preflight) preflight ;;
    enable-services) enable_services ;;
    create-core) create_core ;;
    create-secrets) create_secrets ;;
    build-images) build_images ;;
    deploy-runner) deploy_runner ;;
    deploy-api) deploy_api ;;
    full-restore) full_restore ;;
    ""|-h|--help|help) usage ;;
    *) die "Unknown command: $command" ;;
  esac
}

main "$@"
