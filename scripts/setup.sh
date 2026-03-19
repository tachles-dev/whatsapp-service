#!/usr/bin/env bash
# scripts/setup.sh — Run ONCE on a fresh Hetzner server.
# Usage (from your local machine):
#   bash scripts/setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KEY="$HOME/.ssh/hetzner"

SERVER="root@178.104.32.156"
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new $SERVER"
DEPLOY_DIR="/opt/whatsapp-service"

echo "==> [1/5] Installing system packages..."
$SSH "apt-get update -qq && apt-get install -y -qq ufw fail2ban curl git"

echo "==> [2/5] Installing Docker..."
$SSH "curl -fsSL https://get.docker.com | sh"

echo "==> [3/5] Configuring UFW firewall..."
$SSH bash <<'ENDSSH'
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  # Keep SSH open — do NOT lock yourself out
  ufw allow 22/tcp
  ufw --force enable
  ufw status
ENDSSH

echo "==> [4/5] Creating deploy directory..."
$SSH "mkdir -p $DEPLOY_DIR"

echo "==> [5/5] Syncing project files..."
rsync -az --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env \
  -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
  . "$SERVER:$DEPLOY_DIR/"

echo ""
echo "✓ Setup complete."
echo ""
echo "Next: SSH in and create your .env file:"
echo "  ssh -i ssh-hetzner $SERVER"
echo "  cd $DEPLOY_DIR && cp .env.example .env && nano .env"
echo "  cp Caddyfile.local.example Caddyfile.local && nano Caddyfile.local   # optional server-only Caddy overrides"
echo ""
echo "Then run: bash scripts/deploy.sh"
