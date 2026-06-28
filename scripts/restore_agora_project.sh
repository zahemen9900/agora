#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d -t agora-restore-XXXXXX)"

PROJECT_ID="${PROJECT_ID:-agora-ai-1199}"
PROJECT_NAME="${PROJECT_NAME:-agora-ai}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-us-central1-a}"
REPOSITORY="${REPOSITORY:-agora}"
SERVICE_NAME="${SERVICE_NAME:-agora-api}"
RUNNER_IMAGE_NAME="${RUNNER_IMAGE_NAME:-agora-sandbox-runtime}"
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
RUNNER_STARTUP_TIMEOUT_SECONDS="${RUNNER_STARTUP_TIMEOUT_SECONDS:-240}"
HTTP_RETRY_SECONDS="${HTTP_RETRY_SECONDS:-5}"
HTTP_RETRY_ATTEMPTS="${HTTP_RETRY_ATTEMPTS:-24}"
RUNNER_TAG="${RUNNER_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD)}"

BUCKET_NAME="${BUCKET_NAME:-${PROJECT_ID}-agora-data}"
RUNTIME_SA_EMAIL="${RUNTIME_SA_EMAIL:-${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com}"
DEPLOY_SA_EMAIL="${DEPLOY_SA_EMAIL:-${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com}"
DEFAULT_SOLANA_KEYPAIR_PATH="${DEFAULT_SOLANA_KEYPAIR_PATH:-/home/zahemen/.config/solana/devnet-keypair.json}"
RESTORE_FORCE_SECRET_ROTATION="${RESTORE_FORCE_SECRET_ROTATION:-0}"
RESTORE_REQUIRE_AUTHENTICATED_SMOKE="${RESTORE_REQUIRE_AUTHENTICATED_SMOKE:-0}"

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

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: ./scripts/restore_agora_project.sh <command>

Commands:
  preflight          Validate auth, project access, and billing
  enable-services    Enable required Google APIs
  create-core        Create or update Artifact Registry, bucket, service accounts, and Redis
  create-secrets     Create empty Secret Manager entries if missing
  seed-secrets       Add missing secret versions from local env / generated values
  build-images       Build API image and sandbox runner image in Artifact Registry
  deploy-runner      Create or update the sandbox runner VM and launch the service
  deploy-api         Deploy Cloud Run using resolved runtime config
  verify-hosted      Verify /health, /auth/config, and hosted auth smoke when credentials exist
  full-restore       Run all of the above in order

Environment overrides:
  PROJECT_ID, PROJECT_NAME, REGION, ZONE, BUCKET_NAME, PROGRAM_ID, SOLANA_NETWORK

Optional verification controls:
  RESTORE_REQUIRE_AUTHENTICATED_SMOKE=1  Fail verify-hosted when no working API key is available
  RESTORE_FORCE_SECRET_ROTATION=1        Add fresh secret versions even when one already exists
EOF
}

log() {
  printf '[info] %s\n' "$*"
}

warn() {
  printf '[warn] %s\n' "$*" >&2
}

die() {
  printf '[error] %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

require_gcloud() {
  require_command gcloud
}

require_billing() {
  local billing_state
  billing_state="$(gcloud beta billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || true)"
  [[ "$billing_state" == "True" || "$billing_state" == "true" ]] || die \
    "Billing is not enabled for $PROJECT_ID. Attach billing before provisioning."
}

random_secret() {
  require_command openssl
  openssl rand -hex 32
}

load_local_env() {
  local env_file
  for env_file in \
    "$ROOT_DIR/.env" \
    "$ROOT_DIR/.env.local" \
    "$ROOT_DIR/.env.development" \
    "$ROOT_DIR/agora-web/.env.local"
  do
    [[ -f "$env_file" ]] || continue
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  done
}

first_env() {
  local name
  for name in "$@"; do
    if [[ -n "${!name:-}" ]]; then
      printf '%s' "${!name}"
      return 0
    fi
  done
  return 1
}

resolve_auth_value() {
  local key="$1"
  case "$key" in
    workos_client_id)
      first_env AGORA_WORKOS_CLIENT_ID WORKOS_CLIENT_ID || true
      ;;
    workos_authkit_domain)
      first_env AGORA_WORKOS_AUTHKIT_DOMAIN WORKOS_AUTHKIT_DOMAIN || true
      ;;
    auth_issuer)
      local value
      value="$(first_env AGORA_AUTH_ISSUER AUTH_ISSUER || true)"
      if [[ -z "$value" ]]; then
        value="$(resolve_auth_value workos_authkit_domain)"
      fi
      printf '%s' "$value"
      ;;
    auth_audience)
      local value
      value="$(first_env AGORA_AUTH_AUDIENCE AUTH_AUDIENCE || true)"
      if [[ -z "$value" ]]; then
        value="$(resolve_auth_value workos_client_id)"
      fi
      printf '%s' "$value"
      ;;
    auth_jwks_url)
      local explicit issuer audience
      explicit="$(first_env AGORA_AUTH_JWKS_URL AUTH_JWKS_URL || true)"
      if [[ -n "$explicit" ]]; then
        printf '%s' "$explicit"
        return 0
      fi
      issuer="$(resolve_auth_value auth_issuer)"
      audience="$(resolve_auth_value auth_audience)"
      if [[ "$issuer" == "https://api.workos.com" && -n "$audience" ]]; then
        printf '%s' "${issuer}/sso/jwks/${audience}"
        return 0
      fi
      if [[ -n "$issuer" ]]; then
        printf '%s' "${issuer%/}/oauth2/jwks"
      fi
      ;;
    *)
      die "Unknown auth key: $key"
      ;;
  esac
}

require_resolved_auth_config() {
  local client_id authkit_domain issuer audience jwks_url
  load_local_env

  client_id="$(resolve_auth_value workos_client_id)"
  authkit_domain="$(resolve_auth_value workos_authkit_domain)"
  issuer="$(resolve_auth_value auth_issuer)"
  audience="$(resolve_auth_value auth_audience)"
  jwks_url="$(resolve_auth_value auth_jwks_url)"

  [[ -n "$client_id" ]] || die "Missing WorkOS client id. Set AGORA_WORKOS_CLIENT_ID or WORKOS_CLIENT_ID."
  [[ -n "$authkit_domain" ]] || die "Missing WorkOS AuthKit domain. Set AGORA_WORKOS_AUTHKIT_DOMAIN or WORKOS_AUTHKIT_DOMAIN."
  [[ -n "$issuer" ]] || die "Missing auth issuer. Set AGORA_AUTH_ISSUER, AUTH_ISSUER, or WorkOS AuthKit domain."
  [[ -n "$audience" ]] || die "Missing auth audience. Set AGORA_AUTH_AUDIENCE, AUTH_AUDIENCE, or WorkOS client id."
  [[ -n "$jwks_url" ]] || die "Missing auth JWKS URL. Set AGORA_AUTH_JWKS_URL or AUTH_JWKS_URL."

  printf '%s\n' "$client_id" "$authkit_domain" "$issuer" "$audience" "$jwks_url"
}

secret_enabled_version_count() {
  local secret_name="$1"
  gcloud secrets versions list "$secret_name" \
    --project "$PROJECT_ID" \
    --filter='state=ENABLED' \
    --format='value(name)' | wc -l | tr -d ' '
}

secret_has_enabled_versions() {
  local secret_name="$1"
  [[ "$(secret_enabled_version_count "$secret_name")" != "0" ]]
}

secret_latest_value() {
  local secret_name="$1"
  if ! secret_has_enabled_versions "$secret_name"; then
    return 1
  fi
  gcloud secrets versions access latest --secret "$secret_name" --project "$PROJECT_ID"
}

add_secret_version() {
  local secret_name="$1"
  local secret_value="$2"
  if [[ -z "$secret_value" ]]; then
    warn "Skipping empty secret value for $secret_name"
    return 0
  fi

  if [[ "$RESTORE_FORCE_SECRET_ROTATION" != "1" ]] && secret_has_enabled_versions "$secret_name"; then
    log "Secret already has enabled version(s): $secret_name"
    return 0
  fi

  printf '%s' "$secret_value" | gcloud secrets versions add "$secret_name" \
    --project "$PROJECT_ID" \
    --data-file=-
}

upsert_secret_value() {
  local secret_name="$1"
  local secret_value="$2"
  local current_value=""

  [[ -n "$secret_value" ]] || die "Cannot upsert empty secret value for $secret_name"

  if secret_has_enabled_versions "$secret_name"; then
    current_value="$(secret_latest_value "$secret_name" || true)"
  fi

  if [[ "$current_value" == "$secret_value" ]]; then
    log "Secret already matches desired value: $secret_name"
    return 0
  fi

  printf '%s' "$secret_value" | gcloud secrets versions add "$secret_name" \
    --project "$PROJECT_ID" \
    --data-file=-
}

redis_url() {
  local host port
  host="$(gcloud redis instances describe "$REDIS_INSTANCE_NAME" \
    --region "$REGION" \
    --project "$PROJECT_ID" \
    --format='value(host)')"
  port="$(gcloud redis instances describe "$REDIS_INSTANCE_NAME" \
    --region "$REGION" \
    --project "$PROJECT_ID" \
    --format='value(port)')"
  [[ -n "$host" && -n "$port" ]] || die "Redis instance $REDIS_INSTANCE_NAME is not ready"
  printf 'redis://%s:%s/0' "$host" "$port"
}

upsert_redis_secret() {
  local value
  value="$(redis_url)"
  upsert_secret_value "agora-redis-url" "$value"
}

runner_image_uri() {
  printf '%s-docker.pkg.dev/%s/%s/%s:%s' \
    "$REGION" "$PROJECT_ID" "$REPOSITORY" "$RUNNER_IMAGE_NAME" "$RUNNER_TAG"
}

api_image_uri() {
  printf '%s-docker.pkg.dev/%s/%s/%s:%s' \
    "$REGION" "$PROJECT_ID" "$REPOSITORY" "$SERVICE_NAME" "$RUNNER_TAG"
}

runner_private_ip() {
  gcloud compute instances describe "$RUNNER_VM_NAME" \
    --zone "$ZONE" \
    --project "$PROJECT_ID" \
    --format='value(networkInterfaces[0].networkIP)'
}

runner_service_url() {
  local override ip
  override="${AGORA_SANDBOX_RUNNER_URL:-${SANDBOX_RUNNER_URL:-}}"
  if [[ -n "$override" ]]; then
    printf '%s' "${override%/}"
    return 0
  fi
  ip="$(runner_private_ip)"
  [[ -n "$ip" ]] || die "Runner VM private IP is unavailable"
  printf 'http://%s:8080' "$ip"
}

service_url() {
  gcloud run services describe "$SERVICE_NAME" \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --format='value(status.url)'
}

wait_for_http_ok() {
  local url="$1"
  local description="$2"
  local attempt=1

  while (( attempt <= HTTP_RETRY_ATTEMPTS )); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "$description is reachable: $url"
      return 0
    fi
    sleep "$HTTP_RETRY_SECONDS"
    attempt=$((attempt + 1))
  done

  die "$description did not become reachable: $url"
}

render_runner_startup_script() {
  local startup_script="$TMP_DIR/runner-startup.sh"
  local image_uri
  image_uri="$(runner_image_uri)"

  cat >"$startup_script" <<EOF
#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl docker.io jq
systemctl enable --now docker

metadata_token() {
  curl -fsS -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
    | jq -r '.access_token'
}

secret_value() {
  local token encoded
  token="\$1"
  encoded="\$(curl -fsS -H "Authorization: Bearer \${token}" \
    "https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/agora-sandbox-runner-bearer-token/versions/latest:access" \
    | jq -r '.payload.data')"
  printf '%s' "\${encoded}" | base64 -d
}

ACCESS_TOKEN=""
for _ in \$(seq 1 30); do
  ACCESS_TOKEN="\$(metadata_token || true)"
  if [[ -n "\${ACCESS_TOKEN}" && "\${ACCESS_TOKEN}" != "null" ]]; then
    break
  fi
  sleep 2
done
[[ -n "\${ACCESS_TOKEN}" && "\${ACCESS_TOKEN}" != "null" ]] || exit 1

printf '%s' "\${ACCESS_TOKEN}" | docker login -u oauth2accesstoken --password-stdin https://${REGION}-docker.pkg.dev

RUNNER_TOKEN="\$(secret_value "\${ACCESS_TOKEN}")"
mkdir -p /tmp/agora-sandbox

docker pull ${image_uri}
docker rm -f agora-sandbox-runner >/dev/null 2>&1 || true
docker run -d --restart unless-stopped \\
  --name agora-sandbox-runner \\
  -p 8080:8080 \\
  -e GOOGLE_CLOUD_PROJECT=${PROJECT_ID} \\
  -e AGORA_SANDBOX_RUNNER_BEARER_TOKEN="\$RUNNER_TOKEN" \\
  -e AGORA_SANDBOX_ROOT=/tmp/agora-sandbox \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  ${image_uri}
EOF

  printf '%s' "$startup_script"
}

ensure_runner_vm() {
  local startup_script="$1"
  local instance_exists status

  instance_exists="$(gcloud compute instances describe "$RUNNER_VM_NAME" \
    --zone "$ZONE" \
    --project "$PROJECT_ID" \
    --format='value(name)' 2>/dev/null || true)"

  if [[ -z "$instance_exists" ]]; then
    log "Creating sandbox runner VM"
    gcloud compute instances create "$RUNNER_VM_NAME" \
      --project "$PROJECT_ID" \
      --zone "$ZONE" \
      --machine-type "$RUNNER_MACHINE_TYPE" \
      --service-account "$RUNTIME_SA_EMAIL" \
      --scopes=https://www.googleapis.com/auth/cloud-platform \
      --image-family "$RUNNER_IMAGE_FAMILY" \
      --image-project "$RUNNER_IMAGE_PROJECT" \
      --tags=agora-sandbox-runner \
      --metadata-from-file=startup-script="$startup_script"
    return 0
  fi

  log "Updating sandbox runner VM startup script"
  gcloud compute instances add-metadata "$RUNNER_VM_NAME" \
    --project "$PROJECT_ID" \
    --zone "$ZONE" \
    --metadata-from-file=startup-script="$startup_script" >/dev/null

  status="$(gcloud compute instances describe "$RUNNER_VM_NAME" \
    --project "$PROJECT_ID" \
    --zone "$ZONE" \
    --format='value(status)')"
  if [[ "$status" != "RUNNING" ]]; then
    gcloud compute instances start "$RUNNER_VM_NAME" \
      --project "$PROJECT_ID" \
      --zone "$ZONE" >/dev/null
  else
    gcloud compute instances reset "$RUNNER_VM_NAME" \
      --project "$PROJECT_ID" \
      --zone "$ZONE" >/dev/null
  fi
}

verify_runner_vm() {
  local deadline now
  deadline=$((SECONDS + RUNNER_STARTUP_TIMEOUT_SECONDS))

  while true; do
    if gcloud compute ssh "$RUNNER_VM_NAME" \
      --project "$PROJECT_ID" \
      --zone "$ZONE" \
      --quiet \
      --command 'curl -fsS http://127.0.0.1:8080/health' >/dev/null 2>&1
    then
      log "Sandbox runner VM is healthy"
      return 0
    fi

    now=$SECONDS
    if (( now >= deadline )); then
      die "Sandbox runner VM did not become healthy within ${RUNNER_STARTUP_TIMEOUT_SECONDS}s"
    fi
    sleep 10
  done
}

runner_image_exists() {
  gcloud artifacts docker images describe "$(runner_image_uri)" \
    --project "$PROJECT_ID" >/dev/null 2>&1
}

resolve_hosted_auth_token() {
  load_local_env

  if [[ -n "${AGORA_TEST_API_KEY:-}" ]]; then
    printf '%s' "$AGORA_TEST_API_KEY"
    return 0
  fi

  if [[ -n "${AGORA_API_KEY:-}" ]]; then
    printf '%s' "$AGORA_API_KEY"
    return 0
  fi

  if secret_has_enabled_versions "agora-test-api-key"; then
    secret_latest_value "agora-test-api-key"
    return 0
  fi

  return 1
}

persist_hosted_test_api_key_if_valid() {
  local token="$1"
  [[ -n "$token" ]] || return 0
  upsert_secret_value "agora-test-api-key" "$token"
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

  log "Granting runtime IAM access"
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role="roles/storage.objectAdmin" \
    --condition=None >/dev/null
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --condition=None >/dev/null
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role="roles/artifactregistry.reader" \
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

  upsert_redis_secret
}

create_secrets() {
  require_gcloud
  require_billing
  local secret_name
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

seed_secrets() {
  require_gcloud
  require_billing
  load_local_env

  local solana_keypair_payload=""
  if [[ -f "$DEFAULT_SOLANA_KEYPAIR_PATH" ]]; then
    solana_keypair_payload="$(cat "$DEFAULT_SOLANA_KEYPAIR_PATH")"
  fi

  add_secret_version "agora-gemini-api-key" "${AGORA_GEMINI_API_KEY:-}"
  add_secret_version "agora-anthropic-api-key" "${ANTHROPIC_API_KEY:-}"
  add_secret_version "agora-openrouter-api-key" "${OPENROUTER_API_KEY:-${AGORA_OPENROUTER_API_KEY:-${OPENROUTER_API_KEY_2:-${AGORA_OPENROUTER_API_KEY_2:-}}}}"
  add_secret_version "agora-helius-rpc-url" "${HELIUS_RPC_URL:-${HELIUS_URL:-}}"
  add_secret_version "agora-solana-devnet-keypair" "$solana_keypair_payload"
  add_secret_version "agora-api-key-pepper" "${AGORA_API_KEY_PEPPER:-$(random_secret)}"
  add_secret_version "agora-benchmark-admin-token" "${BENCHMARK_ADMIN_TOKEN:-$(random_secret)}"
  add_secret_version "agora-axiom-token" "${AGORA_AXIOM_TOKEN:-}"
  add_secret_version "agora-brave-api-key" "${AGORA_BRAVE_API_KEY:-}"
  add_secret_version "agora-brave-api-key-2" "${AGORA_BRAVE_API_KEY_2:-}"
  add_secret_version "agora-brave-api-key-3" "${AGORA_BRAVE_API_KEY_3:-}"
  add_secret_version "agora-sandbox-runner-bearer-token" "${AGORA_SANDBOX_RUNNER_BEARER_TOKEN:-$(random_secret)}"

  warn "Skipping agora-test-api-key during base secret seed. Persist a verified hosted key after /auth/me succeeds."
  upsert_redis_secret
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

  log "Building sandbox runner image"
  gcloud builds submit "$ROOT_DIR" \
    --project "$PROJECT_ID" \
    --config "$ROOT_DIR/sandbox_runner_service/runtime-image.cloudbuild.yaml" \
    --substitutions "_REGION=${REGION},_REPOSITORY=${REPOSITORY},_IMAGE=${RUNNER_IMAGE_NAME},_TAG=${RUNNER_TAG}"
}

deploy_runner() {
  require_gcloud
  require_billing
  local startup_script runner_url

  if ! runner_image_exists; then
    log "Runner image tag $(runner_image_uri) is missing; building sandbox runner image"
    gcloud builds submit "$ROOT_DIR" \
      --project "$PROJECT_ID" \
      --config "$ROOT_DIR/sandbox_runner_service/runtime-image.cloudbuild.yaml" \
      --substitutions "_REGION=${REGION},_REPOSITORY=${REPOSITORY},_IMAGE=${RUNNER_IMAGE_NAME},_TAG=${RUNNER_TAG}"
  fi

  startup_script="$(render_runner_startup_script)"
  ensure_runner_vm "$startup_script"
  verify_runner_vm

  runner_url="$(runner_service_url)"
  log "Sandbox runner URL: $runner_url"
}

deploy_api() {
  require_gcloud
  require_billing
  mapfile -t auth_values < <(require_resolved_auth_config)

  local image_uri
  local runner_url
  image_uri="$(api_image_uri)"
  runner_url="$(runner_service_url)"
  upsert_redis_secret

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
    --update-env-vars "AGORA_ENVIRONMENT=production,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GCS_BUCKET=${BUCKET_NAME},AUTH_REQUIRED=true,AGORA_COORDINATION_BACKEND=redis,AGORA_COORDINATION_NAMESPACE=${COORDINATION_NAMESPACE},AGORA_GEMINI_USE_VERTEXAI=true,AGORA_FLASH_MODEL=gemini-3.1-flash-lite-preview,AGORA_PRO_MODEL=gemini-3-flash-preview,AGORA_CLAUDE_MODEL=claude-sonnet-4-6,AGORA_OPENROUTER_MODEL=qwen/qwen3.5-flash-02-23,AGORA_OPENROUTER_ANALYSIS_MODEL=google/gemma-4-31b-it,AGORA_WORKOS_CLIENT_ID=${auth_values[0]},AGORA_WORKOS_AUTHKIT_DOMAIN=${auth_values[1]},AGORA_AUTH_ISSUER=${auth_values[2]},AGORA_AUTH_AUDIENCE=${auth_values[3]},AGORA_AUTH_JWKS_URL=${auth_values[4]},SOLANA_NETWORK=${SOLANA_NETWORK},PROGRAM_ID=${PROGRAM_ID},SOLANA_KEYPAIR_SECRET_NAME=agora-solana-devnet-keypair,SOLANA_KEYPAIR_SECRET_PROJECT=${PROJECT_ID},SOLANA_KEYPAIR_SECRET_VERSION=latest,AGORA_SANDBOX_RUNNER_URL=${runner_url},AGORA_SANDBOX_EXECUTION_TIMEOUT_SECONDS=20,AGORA_SOURCE_MAX_FILE_BYTES=5242880,AGORA_SOURCE_MAX_ATTACHMENTS_PER_TASK=3,AGORA_BACKGROUND_RECOVERY_ENABLED=true,AGORA_BACKGROUND_RECOVERY_POLL_SECONDS=30,AGORA_BACKGROUND_RECOVERY_STALE_SECONDS=420,AGORA_BACKGROUND_RECOVERY_SCAN_LIMIT=500,AGORA_TASK_CREATE_RATE_LIMIT_PER_MINUTE=60,AGORA_TASK_RUN_RATE_LIMIT_PER_MINUTE=30,AGORA_WORKSPACE_CONCURRENT_TASK_RUNS=4,AGORA_AXIOM_ENABLED=true,AGORA_AXIOM_TRACES_DATASET=agora-traces,AGORA_AXIOM_BASE_URL=https://api.axiom.co,AGORA_AXIOM_CAPTURE_CONTENT=metadata_only" \
    --update-secrets "AGORA_GEMINI_API_KEY=agora-gemini-api-key:latest,ANTHROPIC_API_KEY=agora-anthropic-api-key:latest,AGORA_OPENROUTER_API_KEY=agora-openrouter-api-key:latest,HELIUS_RPC_URL=agora-helius-rpc-url:latest,AGORA_API_KEY_PEPPER=agora-api-key-pepper:latest,AGORA_REDIS_URL=agora-redis-url:latest,BENCHMARK_ADMIN_TOKEN=agora-benchmark-admin-token:latest,AGORA_AXIOM_TOKEN=agora-axiom-token:latest,AGORA_BRAVE_API_KEY=agora-brave-api-key:latest,AGORA_BRAVE_API_KEY_2=agora-brave-api-key-2:latest,AGORA_BRAVE_API_KEY_3=agora-brave-api-key-3:latest,AGORA_SANDBOX_RUNNER_BEARER_TOKEN=agora-sandbox-runner-bearer-token:latest" \
    --allow-unauthenticated \
    --no-invoker-iam-check

  wait_for_http_ok "$(service_url)/health" "Cloud Run health endpoint"
}

verify_hosted() {
  require_gcloud
  load_local_env

  local url auth_token auth_config_output auth_me_output
  url="$(service_url)"
  [[ -n "$url" ]] || die "Cloud Run service ${SERVICE_NAME} is not deployed"

  wait_for_http_ok "${url}/health" "Cloud Run health endpoint"

  auth_config_output="$TMP_DIR/auth-config.json"
  curl -fsS "${url}/auth/config" | tee "$auth_config_output" >/dev/null
  log "Fetched /auth/config"

  if ! auth_token="$(resolve_hosted_auth_token)"; then
    if [[ "$RESTORE_REQUIRE_AUTHENTICATED_SMOKE" == "1" ]]; then
      die "No hosted API key available for authenticated smoke. Set AGORA_API_KEY or seed agora-test-api-key."
    fi
    warn "No hosted API key available; skipping authenticated /auth/me smoke."
    log "Cloud Run URL: $url"
    return 0
  fi

  auth_me_output="$TMP_DIR/auth-me.json"
  if ! curl -fsS -H "Authorization: Bearer ${auth_token}" "${url}/auth/me" | tee "$auth_me_output" >/dev/null; then
    if [[ "$RESTORE_REQUIRE_AUTHENTICATED_SMOKE" == "1" ]]; then
      die "Hosted authenticated smoke failed for /auth/me"
    fi
    warn "Hosted authenticated smoke failed for /auth/me; backend is live but SDK parity is not complete."
    log "Cloud Run URL: $url"
    return 0
  fi

  log "Verified authenticated hosted /auth/me smoke"
  persist_hosted_test_api_key_if_valid "$auth_token"
  log "Cloud Run URL: $url"
}

full_restore() {
  preflight
  enable_services
  create_core
  create_secrets
  seed_secrets
  build_images
  deploy_runner
  deploy_api
  verify_hosted
}

main() {
  local command="${1:-}"
  case "$command" in
    preflight) preflight ;;
    enable-services) enable_services ;;
    create-core) create_core ;;
    create-secrets) create_secrets ;;
    seed-secrets) seed_secrets ;;
    build-images) build_images ;;
    deploy-runner) deploy_runner ;;
    deploy-api) deploy_api ;;
    verify-hosted) verify_hosted ;;
    full-restore) full_restore ;;
    ""|-h|--help|help) usage ;;
    *) die "Unknown command: $command" ;;
  esac
}

main "$@"
