#!/usr/bin/env bash
# scripts/deploy.sh — Run directly ON the server after SSHing in.
# Usage (on server):
#   cd /app && bash scripts/deploy.sh
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DEPLOY_DIR"

echo "==> [1/3] Pulling latest code..."
git pull

echo "==> [2/3] Building and restarting containers..."
docker compose build --pull
docker compose up -d
docker compose ps

echo "==> [3/3] Health check..."
sleep 5
docker compose exec app curl -sf http://localhost:3000/api/status && echo '' && echo '✓ Service is healthy' \
  || echo '⚠ Health check failed — run: docker compose logs app'

