#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_ROOT="/opt/wgs-instances"
EDGE_IMPORT_DIR=""
ACTION=""
SLUG=""
WAIT_TIMEOUT_SECONDS=120
DELETE_INSTANCE_FILES=1
DELETE_EDGE_SNIPPET=1

usage() {
  cat <<'EOF'
Usage:
  bash scripts/manage-instance.sh --slug acme --action start|stop|restart|delete [options]

Options:
  --instance-root /opt/wgs-instances
  --edge-import-dir /etc/caddy/customer-instances
  --wait-timeout-seconds 120
  --keep-instance-files
  --keep-edge-snippet
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

wait_for_http() {
  local url="$1"
  local timeout_seconds="$2"
  local start_ts now
  start_ts="$(date +%s)"

  until curl -fsS "$url" >/dev/null 2>&1; do
    now="$(date +%s)"
    if (( now - start_ts >= timeout_seconds )); then
      echo "Timed out waiting for $url" >&2
      return 1
    fi
    sleep 2
  done
}

instance_dir() {
  printf '%s/%s\n' "$INSTANCE_ROOT" "$SLUG"
}

env_file() {
  printf '%s/.env\n' "$(instance_dir)"
}

compose() {
  local env_path="$1"
  shift
  INSTANCE_ENV_FILE="$env_path" docker compose \
    --project-name "wgs-$SLUG" \
    --env-file "$env_path" \
    -f "$ROOT_DIR/docker-compose.yml" \
    -f "$ROOT_DIR/deploy/docker-compose.instance.yml" \
    "$@"
}

run_dns_hook() {
  local action_name="$1"
  local command_value="${WGS_DNS_HOOK_COMMAND:-}"
  if [[ -z "$command_value" ]]; then
    return 0
  fi

  export WGS_DNS_ACTION="$action_name"
  export WGS_INSTANCE_SLUG="$SLUG"
  export WGS_INSTANCE_DIR="$(instance_dir)"

  if [[ -f "$(env_file)" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$(env_file)"
    set +a
    export WGS_INSTANCE_DOMAIN="${DOMAIN:-}"
    export WGS_INSTANCE_APP_PORT="${INSTANCE_APP_PORT:-}"
  fi

  eval "$command_value"
}

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)
      SLUG="$2"
      shift 2
      ;;
    --action)
      ACTION="$2"
      shift 2
      ;;
    --instance-root)
      INSTANCE_ROOT="$2"
      shift 2
      ;;
    --edge-import-dir)
      EDGE_IMPORT_DIR="$2"
      shift 2
      ;;
    --wait-timeout-seconds)
      WAIT_TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --keep-instance-files)
      DELETE_INSTANCE_FILES=0
      shift
      ;;
    --keep-edge-snippet)
      DELETE_EDGE_SNIPPET=0
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

if [[ -z "$SLUG" || -z "$ACTION" ]]; then
  usage >&2
  exit 1
fi

if [[ "$ACTION" != "start" && "$ACTION" != "stop" && "$ACTION" != "restart" && "$ACTION" != "delete" ]]; then
  echo "--action must be start, stop, restart, or delete" >&2
  exit 1
fi

if [[ ! -f "$(env_file)" ]]; then
  echo "Instance env file not found: $(env_file)" >&2
  exit 1
fi

require_cmd docker
require_cmd curl

case "$ACTION" in
  start)
    compose "$(env_file)" up -d --build redis app
    set -a
    # shellcheck disable=SC1090
    source "$(env_file)"
    set +a
    wait_for_http "http://127.0.0.1:$INSTANCE_APP_PORT/api/status/live" "$WAIT_TIMEOUT_SECONDS"
    wait_for_http "http://127.0.0.1:$INSTANCE_APP_PORT/api/status/ready" "$WAIT_TIMEOUT_SECONDS"
    echo "Started instance $SLUG"
    ;;
  stop)
    compose "$(env_file)" stop app redis
    echo "Stopped instance $SLUG"
    ;;
  restart)
    compose "$(env_file)" restart app redis
    set -a
    # shellcheck disable=SC1090
    source "$(env_file)"
    set +a
    wait_for_http "http://127.0.0.1:$INSTANCE_APP_PORT/api/status/live" "$WAIT_TIMEOUT_SECONDS"
    wait_for_http "http://127.0.0.1:$INSTANCE_APP_PORT/api/status/ready" "$WAIT_TIMEOUT_SECONDS"
    echo "Restarted instance $SLUG"
    ;;
  delete)
    compose "$(env_file)" down --volumes --remove-orphans || true
    if [[ "$DELETE_EDGE_SNIPPET" == "1" && -n "$EDGE_IMPORT_DIR" ]]; then
      rm -f "$EDGE_IMPORT_DIR/$SLUG.caddy"
    fi
    run_dns_hook delete || true
    if [[ "$DELETE_INSTANCE_FILES" == "1" ]]; then
      rm -rf "$(instance_dir)"
    fi
    echo "Deleted instance $SLUG"
    ;;
esac