#!/usr/bin/env bash
# scripts/deploy.sh — Run directly ON the server after SSHing in.
# Usage (on server):
#   cd /app && bash scripts/deploy.sh
#   cd /app && bash scripts/deploy.sh --discard-local-caddy
set -euo pipefail

DISCARD_LOCAL_CADDY=0

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy.sh [--discard-local-caddy]

Options:
  --discard-local-caddy   Backup the current tracked Caddyfile and reset it
                          before pulling. Use this when the server has a local
                          Caddyfile edit that you want to override.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --discard-local-caddy)
      DISCARD_LOCAL_CADDY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DEPLOY_DIR"

backup_and_reset_caddyfile() {
  local timestamp backup_file
  timestamp="$(date +%Y%m%d-%H%M%S)"
  backup_file="Caddyfile.backup.${timestamp}"
  cp Caddyfile "$backup_file"
  git checkout -- Caddyfile
  echo "==> Backed up local Caddyfile to $backup_file"
  echo "==> Reset tracked Caddyfile to the git version"
}

echo "==> Preparing local deployment overrides..."
if [[ ! -f Caddyfile.local ]]; then
  if [[ -f Caddyfile.local.example ]]; then
    cp Caddyfile.local.example Caddyfile.local
  else
    touch Caddyfile.local
  fi
fi

if ! git diff --quiet -- Caddyfile; then
  if [[ "$DISCARD_LOCAL_CADDY" == "1" ]]; then
    echo "==> Local changes detected in tracked Caddyfile — overriding as requested..."
    backup_and_reset_caddyfile
  else
    echo "⚠ Local changes detected in tracked Caddyfile."
    echo "   This would block git pull if the remote also changed Caddyfile."
    echo "   Either move your server-only directives into Caddyfile.local, or rerun:"
    echo ""
    echo "     bash scripts/deploy.sh --discard-local-caddy"
    echo ""
    echo "   That mode creates a timestamped backup before overriding the tracked file."
    exit 1
  fi
fi

echo "==> [1/3] Pulling latest code..."
git pull --rebase --autostash

echo "==> [2/3] Building and restarting containers..."
docker compose build --pull
docker compose up -d
docker compose ps

echo "==> [3/3] Health check..."
sleep 5
docker compose exec app curl -sf http://localhost:3000/api/status && echo '' && echo '✓ Service is healthy' \
  || echo '⚠ Health check failed — run: docker compose logs app'

