#!/usr/bin/env bash
set -euo pipefail

DEPLOY_GATEWAY=1
DEPLOY_WEB=0
ENSURE_EDGE=0
DISCARD_LOCAL_CADDY=0
SKIP_PULL=0
SKIP_GATEWAY_BUILD=0
WEB_INSTALL=0
WEB_PORT="3300"
WEB_HOSTNAME="127.0.0.1"
WEB_PID_FILE=""
WEB_LOG_FILE=""
EDGE_IMPORT_DIR="${WGS_EDGE_IMPORT_DIR:-/etc/caddy/customer-instances}"

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy-production-ready.sh [options]

This is the single production entry point for the production-ready branch.
It can deploy the root gateway stack, prepare the shared edge import directory,
and optionally build and start the internal web control plane.

Options:
  --gateway-only           Deploy only the root gateway stack.
  --web-only               Deploy only the internal web control plane.
  --deploy-web             Build and start the internal web control plane.
  --web-install            Run npm install in web/ before building.
  --ensure-edge            Create the shared edge import directory and example file.
  --edge-import-dir PATH   Override the shared Caddy import directory.
  --web-port PORT          Port for the internal web control plane. Default: 3300.
  --web-hostname HOST      Host binding for the internal web control plane. Default: 127.0.0.1.
  --web-pid-file PATH      PID file for the background web process.
  --web-log-file PATH      Log file for the background web process.
  --skip-pull              Do not run git pull.
  --skip-gateway-build     Skip docker compose build before gateway restart.
  --discard-local-caddy    Backup and reset a dirty tracked Caddyfile before pull.
  -h, --help               Show this help text.

Examples:
  bash scripts/deploy-production-ready.sh
  bash scripts/deploy-production-ready.sh --deploy-web --web-install
  bash scripts/deploy-production-ready.sh --ensure-edge --deploy-web --web-install
  bash scripts/deploy-production-ready.sh --web-only --deploy-web --web-install
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway-only)
      DEPLOY_GATEWAY=1
      DEPLOY_WEB=0
      shift
      ;;
    --web-only)
      DEPLOY_GATEWAY=0
      DEPLOY_WEB=1
      shift
      ;;
    --deploy-web)
      DEPLOY_WEB=1
      shift
      ;;
    --web-install)
      WEB_INSTALL=1
      shift
      ;;
    --ensure-edge)
      ENSURE_EDGE=1
      shift
      ;;
    --edge-import-dir)
      EDGE_IMPORT_DIR="$2"
      shift 2
      ;;
    --web-port)
      WEB_PORT="$2"
      shift 2
      ;;
    --web-hostname)
      WEB_HOSTNAME="$2"
      shift 2
      ;;
    --web-pid-file)
      WEB_PID_FILE="$2"
      shift 2
      ;;
    --web-log-file)
      WEB_LOG_FILE="$2"
      shift 2
      ;;
    --skip-pull)
      SKIP_PULL=1
      shift
      ;;
    --skip-gateway-build)
      SKIP_GATEWAY_BUILD=1
      shift
      ;;
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

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
}

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$DEPLOY_DIR/web"
WEB_PID_FILE="${WEB_PID_FILE:-$WEB_DIR/.next/wgs-admin.pid}"
WEB_LOG_FILE="${WEB_LOG_FILE:-$WEB_DIR/.next/wgs-admin.log}"

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

prepare_local_caddyfile() {
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
      echo "==> Local changes detected in tracked Caddyfile; overriding as requested..."
      backup_and_reset_caddyfile
    else
      echo "Local changes detected in tracked Caddyfile." >&2
      echo "Move server-only directives into Caddyfile.local or rerun with --discard-local-caddy." >&2
      exit 1
    fi
  fi
}

ensure_edge_layout() {
  echo "==> Ensuring shared edge layout..."
  mkdir -p "$EDGE_IMPORT_DIR"
  if [[ ! -f /etc/caddy/Caddyfile.edge.example ]]; then
    install -m 0644 "$DEPLOY_DIR/deploy/Caddyfile.edge.example" /etc/caddy/Caddyfile.edge.example
    echo "==> Installed /etc/caddy/Caddyfile.edge.example"
  fi
  echo "==> Shared edge import directory: $EDGE_IMPORT_DIR"
  echo "==> If your host-level Caddyfile is not importing customer snippets yet, add:"
  echo "    import $EDGE_IMPORT_DIR/*.caddy"
}

git_pull_if_enabled() {
  if [[ "$SKIP_PULL" == "1" ]]; then
    echo "==> Skipping git pull"
    return
  fi
  echo "==> Pulling latest code..."
  git pull --rebase --autostash
}

deploy_gateway() {
  require_command docker
  prepare_local_caddyfile
  git_pull_if_enabled

  echo "==> Deploying gateway stack..."
  if [[ "$SKIP_GATEWAY_BUILD" == "0" ]]; then
    docker compose build --pull
  fi
  docker compose up -d
  docker compose ps

  echo "==> Running gateway health checks..."
  sleep 5
  docker compose exec app curl -sf http://localhost:3000/api/status >/dev/null
  docker compose exec app curl -sf http://localhost:3000/api/status/live >/dev/null
  echo "==> Gateway health checks passed"
}

stop_existing_web_process() {
  if [[ -f "$WEB_PID_FILE" ]]; then
    local existing_pid
    existing_pid="$(cat "$WEB_PID_FILE")"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" >/dev/null 2>&1; then
      echo "==> Stopping existing web control plane process ($existing_pid)..."
      kill "$existing_pid"
      wait "$existing_pid" 2>/dev/null || true
    fi
    rm -f "$WEB_PID_FILE"
  fi
}

read_web_env_value() {
  local key="$1"
  local env_file raw_line raw_value
  for env_file in "$WEB_DIR/.env.local" "$WEB_DIR/.env"; do
    if [[ ! -f "$env_file" ]]; then
      continue
    fi
    raw_line="$(grep -E "^${key}=" "$env_file" | tail -n 1 || true)"
    if [[ -z "$raw_line" ]]; then
      continue
    fi
    raw_value="${raw_line#*=}"
    raw_value="${raw_value%$'\r'}"
    raw_value="${raw_value#\"}"
    raw_value="${raw_value%\"}"
    raw_value="${raw_value#\'}"
    raw_value="${raw_value%\'}"
    printf '%s' "$raw_value"
    return 0
  done
  return 1
}

verify_web_health() {
  local health_url="http://$WEB_HOSTNAME:$WEB_PORT"
  local admin_username admin_password
  admin_username="$(read_web_env_value WGS_ADMIN_UI_USERNAME || true)"
  admin_password="$(read_web_env_value WGS_ADMIN_UI_PASSWORD || true)"

  if [[ -n "$admin_username" && -n "$admin_password" ]]; then
    curl -sf -u "$admin_username:$admin_password" "$health_url" >/dev/null
    return
  fi

  if [[ -f "$WEB_PID_FILE" ]]; then
    local web_pid
    web_pid="$(cat "$WEB_PID_FILE")"
    if [[ -n "$web_pid" ]] && kill -0 "$web_pid" >/dev/null 2>&1; then
      return
    fi
  fi

  return 1
}

deploy_web() {
  require_command node
  require_command npm

  if [[ ! -d "$WEB_DIR" ]]; then
    echo "web/ is not present in this checkout. Pull the branch containing the internal control plane first." >&2
    exit 1
  fi

  echo "==> Deploying internal web control plane..."
  mkdir -p "$(dirname "$WEB_PID_FILE")"
  mkdir -p "$(dirname "$WEB_LOG_FILE")"

  pushd "$WEB_DIR" >/dev/null
  if [[ "$WEB_INSTALL" == "1" || ! -d node_modules ]]; then
    npm install
  fi
  npm run build
  stop_existing_web_process
  nohup npm run start -- --hostname "$WEB_HOSTNAME" --port "$WEB_PORT" >"$WEB_LOG_FILE" 2>&1 &
  local web_pid=$!
  popd >/dev/null

  echo "$web_pid" > "$WEB_PID_FILE"
  sleep 5
  if ! verify_web_health; then
    echo "Internal web control plane failed health check. Check $WEB_LOG_FILE" >&2
    exit 1
  fi

  echo "==> Internal web control plane is running on http://$WEB_HOSTNAME:$WEB_PORT"
  echo "==> PID file: $WEB_PID_FILE"
  echo "==> Log file: $WEB_LOG_FILE"
}

main() {
  require_command git
  require_command curl

  if [[ "$DEPLOY_GATEWAY" == "1" && "$DEPLOY_WEB" == "0" && "$ENSURE_EDGE" == "0" ]]; then
    deploy_gateway
    return
  fi

  if [[ "$DEPLOY_GATEWAY" == "1" ]]; then
    deploy_gateway
  else
    git_pull_if_enabled
  fi

  if [[ "$ENSURE_EDGE" == "1" ]]; then
    ensure_edge_layout
  fi

  if [[ "$DEPLOY_WEB" == "1" ]]; then
    deploy_web
  fi

  echo "==> Production-ready deployment complete"
}

main