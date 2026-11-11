#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
RELEASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_VERSION="v2.40.3"
ECR_HELPER_VERSION="0.9.0"

dnf install -y docker jq
if ! command -v aws >/dev/null 2>&1; then
  dnf install -y awscli-2 || dnf install -y awscli
fi

systemctl enable --now docker

mkdir -p /usr/libexec/docker/cli-plugins
curl -fsSL \
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
  -o /usr/libexec/docker/cli-plugins/docker-compose
chmod 0755 /usr/libexec/docker/cli-plugins/docker-compose

curl -fsSL \
  "https://amazon-ecr-credential-helper-releases.s3.us-east-2.amazonaws.com/${ECR_HELPER_VERSION}/linux-amd64/docker-credential-ecr-login" \
  -o /usr/local/bin/docker-credential-ecr-login
chmod 0755 /usr/local/bin/docker-credential-ecr-login

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
mkdir -p /root/.docker
cat > /root/.docker/config.json <<JSON
{
  "credHelpers": {
    "${REGISTRY}": "ecr-login"
  }
}
JSON
chmod 0600 /root/.docker/config.json

install -d -m 0700 /opt/agora /opt/agora/bin /opt/agora/releases /opt/agora/control /opt/agora/secrets
install -d -m 0711 /opt/agora/sandbox-work

if ! swapon --show 2>/dev/null | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
cat > /etc/sysctl.d/99-agora.conf <<'EOF'
vm.swappiness = 10
vm.vfs_cache_pressure = 50
EOF
sysctl --system >/dev/null

install -m 0755 "${RELEASE_DIR}/scripts/deploy.sh" /opt/agora/bin/deploy.sh
install -m 0755 "${RELEASE_DIR}/scripts/rollback.sh" /opt/agora/bin/rollback.sh

cp "${RELEASE_DIR}/systemd/agora-sandbox-work.mount" /etc/systemd/system/
cp "${RELEASE_DIR}/systemd/agora-secrets.service" /etc/systemd/system/
cp "${RELEASE_DIR}/systemd/agora.service" /etc/systemd/system/
chmod 0644 /etc/systemd/system/agora*.service /etc/systemd/system/agora-sandbox-work.mount

systemctl daemon-reload
systemctl enable agora-sandbox-work.mount
systemctl start agora-sandbox-work.mount
systemctl enable agora-secrets.service agora.service

echo "agora host bootstrap complete"
