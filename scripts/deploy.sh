#!/usr/bin/env bash
# scripts/deploy.sh — Pull latest code and restart the service.
# Run this from your local machine after every git push.
# Usage:
#   bash scripts/deploy.sh
set -euo pipefail

SERVER="root@178.104.32.156"
SSH="ssh -i ssh-hetzner $SERVER"
DEPLOY_DIR="/opt/whatsapp-service"

echo "==> [1/3] Syncing files to server..."
rsync -az --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env \
  -e "ssh -i ssh-hetzner" \
  . "$SERVER:$DEPLOY_DIR/"

echo "==> [2/3] Building and restarting containers..."
$SSH bash <<ENDSSH
  set -euo pipefail
  cd $DEPLOY_DIR
  docker compose build --pull
  docker compose up -d
  docker compose ps
ENDSSH

echo "==> [3/3] Waiting for health check..."
sleep 5
$SSH "curl -sf http://localhost:3000/api/status && echo '' && echo '✓ Service is healthy'" \
  || echo "⚠ Health check failed — run: ssh -i ssh-hetzner $SERVER 'cd $DEPLOY_DIR && docker compose logs app'"
