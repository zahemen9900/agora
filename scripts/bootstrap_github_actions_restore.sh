#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-zahemen9900/agora}"
PROJECT_ID="${PROJECT_ID:-agora-ai-1199}"
RUNTIME_SA="${RUNTIME_SA:-agora-api-runtime@agora-ai-1199.iam.gserviceaccount.com}"
DEPLOY_SA="${DEPLOY_SA:-github-deploy@agora-ai-1199.iam.gserviceaccount.com}"
BUCKET_NAME="${BUCKET_NAME:-agora-ai-1199-agora-data}"
COORDINATION_NAMESPACE="${COORDINATION_NAMESPACE:-agora-prod}"
WORKOS_CLIENT_ID="${WORKOS_CLIENT_ID:-client_01KNVQVZ4B193J74RHVJF3AKVF}"
WORKOS_AUTHKIT_DOMAIN="${WORKOS_AUTHKIT_DOMAIN:-https://healthy-flare-22-staging.authkit.app}"
AUTH_ISSUER="${AUTH_ISSUER:-https://api.workos.com}"
AUTH_AUDIENCE="${AUTH_AUDIENCE:-client_01KNVQVZ4B193J74RHVJF3AKVF}"
AUTH_JWKS_URL="${AUTH_JWKS_URL:-https://api.workos.com/sso/jwks/client_01KNVQVZ4B193J74RHVJF3AKVF}"
SOLANA_NETWORK="${SOLANA_NETWORK:-devnet}"
PROGRAM_ID="${PROGRAM_ID:-82b5DxHBmKFYohQJTMSBtnMyYVER9XepMnSdwuJB1gkd}"
SOLANA_KEYPAIR_SECRET_NAME="${SOLANA_KEYPAIR_SECRET_NAME:-agora-solana-devnet-keypair}"
SOLANA_KEYPAIR_SECRET_PROJECT="${SOLANA_KEYPAIR_SECRET_PROJECT:-agora-ai-1199}"

usage() {
  cat <<'EOF'
Usage: ./scripts/bootstrap_github_actions_restore.sh [--provider <workload-identity-provider>]

This script sets the GitHub Actions variables and secrets needed by
.github/workflows/deploy.yml for the Agora restore target.

Requirements:
  - gh authenticated with a token that can manage Actions secrets and variables
EOF
}

require_gh() {
  command -v gh >/dev/null 2>&1 || {
    echo "[error] gh CLI is required" >&2
    exit 1
  }
}

PROVIDER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider)
      PROVIDER="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[error] Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_gh

gh variable set GCP_RUNTIME_SERVICE_ACCOUNT --repo "$REPO" --body "$RUNTIME_SA"
gh variable set AGORA_GCS_BUCKET --repo "$REPO" --body "$BUCKET_NAME"
gh variable set AGORA_COORDINATION_NAMESPACE --repo "$REPO" --body "$COORDINATION_NAMESPACE"
gh variable set WORKOS_CLIENT_ID --repo "$REPO" --body "$WORKOS_CLIENT_ID"
gh variable set WORKOS_AUTHKIT_DOMAIN --repo "$REPO" --body "$WORKOS_AUTHKIT_DOMAIN"
gh variable set AUTH_ISSUER --repo "$REPO" --body "$AUTH_ISSUER"
gh variable set AUTH_AUDIENCE --repo "$REPO" --body "$AUTH_AUDIENCE"
gh variable set AUTH_JWKS_URL --repo "$REPO" --body "$AUTH_JWKS_URL"
gh variable set SOLANA_NETWORK --repo "$REPO" --body "$SOLANA_NETWORK"
gh variable set PROGRAM_ID --repo "$REPO" --body "$PROGRAM_ID"
gh variable set SOLANA_KEYPAIR_SECRET_NAME --repo "$REPO" --body "$SOLANA_KEYPAIR_SECRET_NAME"
gh variable set SOLANA_KEYPAIR_SECRET_PROJECT --repo "$REPO" --body "$SOLANA_KEYPAIR_SECRET_PROJECT"

gh secret set GCP_PROJECT_ID --repo "$REPO" --body "$PROJECT_ID"
gh secret set GCP_SERVICE_ACCOUNT --repo "$REPO" --body "$DEPLOY_SA"

if [[ -n "$PROVIDER" ]]; then
  gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "$REPO" --body "$PROVIDER"
else
  echo "[warn] Skipped GCP_WORKLOAD_IDENTITY_PROVIDER because no --provider was supplied." >&2
fi

echo "[info] GitHub Actions bootstrap applied for $REPO"
