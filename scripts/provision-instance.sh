#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_ROOT_DEFAULT="/opt/wgs-instances"
EDGE_IMPORT_DIR_DEFAULT="/etc/caddy/customer-instances"

SLUG=""
DOMAIN=""
INSTANCE_APP_PORT=""
WEBHOOK_URL=""
WEBHOOK_API_KEY_INPUT=""
MODULE_PROFILE="standard"
INSTANCE_ROOT="$INSTANCE_ROOT_DEFAULT"
EDGE_IMPORT_DIR=""
START_STACK=0
INSTALL_EDGE_SNIPPET=0
BOOTSTRAP_CLIENT_ID=""
BOOTSTRAP_DEVICE_NAME=""
BOOTSTRAP_TTL_DAYS=90
BOOTSTRAP_ROTATE_KEY=0
WAIT_TIMEOUT_SECONDS=120
DNS_HOOK_COMMAND="${WGS_DNS_HOOK_COMMAND:-}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/provision-instance.sh \
    --slug acme \
    --domain acme.whatsapp.example.com \
    --app-port 3101 \
    --webhook-url https://product.example.com/api/webhooks/whatsapp \
    [--webhook-api-key shared-secret-you-control] \
    [--profile standard|full] \
    [--instance-root /opt/wgs-instances] \
    [--install-edge-snippet] \
    [--edge-import-dir /etc/caddy/customer-instances] \
    [--bootstrap-client-id customer-slug] \
    [--bootstrap-device-name "Primary Device"] \
    [--bootstrap-ttl-days 90] \
    [--bootstrap-rotate-key] \
    [--wait-timeout-seconds 120] \
    [--dns-hook-command 'your-hook-command'] \
    [--start]

What it does:
  - creates a dedicated instance folder for one customer
  - generates a per-instance .env with unique secrets
  - renders a shared-edge Caddy snippet for the customer domain
  - optionally starts the customer stack on a loopback-bound port
  - optionally waits for readiness and bootstraps the first client/device

What it does not do:
  - create DNS records
  - install Docker or Caddy
  - provision a VM
  - bootstrap the customer tenant over the control-plane API unless bootstrap flags are provided
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

random_secret() {
  openssl rand -hex 32
}

random_password() {
  openssl rand -base64 24 | tr -d '\n'
}

run_dns_hook() {
  local action_name="$1"
  if [[ -z "$DNS_HOOK_COMMAND" ]]; then
    return 0
  fi

  export WGS_DNS_ACTION="$action_name"
  export WGS_INSTANCE_SLUG="$SLUG"
  export WGS_INSTANCE_DOMAIN="$DOMAIN"
  export WGS_INSTANCE_APP_PORT="$INSTANCE_APP_PORT"
  export WGS_INSTANCE_DIR="$(instance_dir)"
  eval "$DNS_HOOK_COMMAND"
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

instance_env_file() {
  printf '%s/.env\n' "$(instance_dir)"
}

instance_manifest_file() {
  printf '%s/instance.json\n' "$(instance_dir)"
}

instance_caddy_file() {
  printf '%s/edge-route.caddy\n' "$(instance_dir)"
}

instance_bootstrap_file() {
  printf '%s/bootstrap-response.json\n' "$(instance_dir)"
}

render_env_file() {
  local env_file="$1"
  local api_key key_secret redis_password webhook_api_key admin_password control_plane_secret

  api_key="$(random_secret)"
  key_secret="$(random_secret)"
  redis_password="$(random_secret)"
  webhook_api_key="${WEBHOOK_API_KEY_INPUT:-$(random_secret)}"
  admin_password="$(random_password)"
  control_plane_secret="$(random_secret)"

  cat >"$env_file" <<EOF
DOMAIN=$DOMAIN

PORT=3000
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info

API_KEY=$api_key
KEY_SECRET=$key_secret

REDIS_PASSWORD=$redis_password
REDIS_URL=redis://:$redis_password@redis:6379

WEBHOOK_URL=$WEBHOOK_URL
WEBHOOK_API_KEY=$webhook_api_key

MODULE_PROFILE=$MODULE_PROFILE
AUTH_BASE_DIR=/data/auth

ADMIN_USERNAME=admin
ADMIN_PASSWORD=$admin_password

CONTROL_PLANE_SECRET=$control_plane_secret
CONTROL_PLANE_HEADER=x-control-plane-key
EOF

  if [[ "$MODULE_PROFILE" == "full" ]]; then
    cat >>"$env_file" <<EOF
INSTANCE_BASE_URL=https://$DOMAIN
EOF
  fi

  cat >>"$env_file" <<EOF

# Loopback port exposed on the host for the shared edge Caddy.
INSTANCE_APP_PORT=$INSTANCE_APP_PORT
EOF
}

render_manifest() {
  local manifest_file="$1"
  cat >"$manifest_file" <<EOF
{
  "slug": "$SLUG",
  "domain": "$DOMAIN",
  "moduleProfile": "$MODULE_PROFILE",
  "instanceAppPort": $INSTANCE_APP_PORT,
  "instanceDir": "$(instance_dir)",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

render_caddy_snippet() {
  local target_file="$1"
  sed \
    -e "s/{\$CUSTOMER_DOMAIN}/$DOMAIN/g" \
    -e "s/{\$INSTANCE_APP_PORT}/$INSTANCE_APP_PORT/g" \
    "$ROOT_DIR/deploy/caddy.customer-instance.template" >"$target_file"
}

install_caddy_snippet() {
  local source_file="$1"
  local target_dir="$2"
  mkdir -p "$target_dir"
  cp "$source_file" "$target_dir/$SLUG.caddy"
}

start_stack() {
  local env_file="$1"
  INSTANCE_ENV_FILE="$env_file" docker compose \
    --project-name "wgs-$SLUG" \
    --env-file "$env_file" \
    -f "$ROOT_DIR/docker-compose.yml" \
    -f "$ROOT_DIR/deploy/docker-compose.instance.yml" \
    up -d --build redis app
}

bootstrap_instance() {
  local env_file="$1"
  local response_file="$2"
  local payload rotate_json http_code response_body

  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a

  rotate_json='false'
  if [[ "$BOOTSTRAP_ROTATE_KEY" == "1" ]]; then
    rotate_json='true'
  fi

  payload=$(cat <<EOF
{"deviceName":"$BOOTSTRAP_DEVICE_NAME","ttlDays":$BOOTSTRAP_TTL_DAYS,"rotateKey":$rotate_json}
EOF
)

  response_body="$(mktemp)"
  http_code="$(curl -sS -o "$response_body" -w '%{http_code}' \
    -X POST \
    -H "x-api-key: $API_KEY" \
    -H "$CONTROL_PLANE_HEADER: $CONTROL_PLANE_SECRET" \
    -H 'content-type: application/json' \
    --data "$payload" \
    "http://127.0.0.1:$INSTANCE_APP_PORT/api/v1/control-plane/clients/$BOOTSTRAP_CLIENT_ID/bootstrap")"

  case "$http_code" in
    200|201)
      mv "$response_body" "$response_file"
      ;;
    409)
      cat "$response_body" >&2
      rm -f "$response_body"
      echo "Bootstrap returned 409. The instance is healthy, but the client may already have an active key. Retry only if you intend to rotate the key." >&2
      return 2
      ;;
    *)
      cat "$response_body" >&2
      rm -f "$response_body"
      echo "Bootstrap failed with HTTP $http_code" >&2
      return 1
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)
      SLUG="$2"
      shift 2
      ;;
    --domain)
      DOMAIN="$2"
      shift 2
      ;;
    --app-port)
      INSTANCE_APP_PORT="$2"
      shift 2
      ;;
    --webhook-url)
      WEBHOOK_URL="$2"
      shift 2
      ;;
    --webhook-api-key)
      WEBHOOK_API_KEY_INPUT="$2"
      shift 2
      ;;
    --profile)
      MODULE_PROFILE="$2"
      shift 2
      ;;
    --instance-root)
      INSTANCE_ROOT="$2"
      shift 2
      ;;
    --install-edge-snippet)
      INSTALL_EDGE_SNIPPET=1
      shift
      ;;
    --edge-import-dir)
      EDGE_IMPORT_DIR="$2"
      shift 2
      ;;
    --start)
      START_STACK=1
      shift
      ;;
    --bootstrap-client-id)
      BOOTSTRAP_CLIENT_ID="$2"
      shift 2
      ;;
    --bootstrap-device-name)
      BOOTSTRAP_DEVICE_NAME="$2"
      shift 2
      ;;
    --bootstrap-ttl-days)
      BOOTSTRAP_TTL_DAYS="$2"
      shift 2
      ;;
    --bootstrap-rotate-key)
      BOOTSTRAP_ROTATE_KEY=1
      shift
      ;;
    --wait-timeout-seconds)
      WAIT_TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --dns-hook-command)
      DNS_HOOK_COMMAND="$2"
      shift 2
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

if [[ -z "$SLUG" || -z "$DOMAIN" || -z "$INSTANCE_APP_PORT" || -z "$WEBHOOK_URL" ]]; then
  usage >&2
  exit 1
fi

if [[ "$MODULE_PROFILE" != "standard" && "$MODULE_PROFILE" != "full" ]]; then
  echo "--profile must be standard or full" >&2
  exit 1
fi

if ! [[ "$INSTANCE_APP_PORT" =~ ^[0-9]+$ ]]; then
  echo "--app-port must be numeric" >&2
  exit 1
fi

require_cmd openssl
require_cmd docker

if [[ "$START_STACK" == "1" ]]; then
  require_cmd curl
fi

if [[ -n "$BOOTSTRAP_CLIENT_ID" || -n "$BOOTSTRAP_DEVICE_NAME" ]]; then
  if [[ -z "$BOOTSTRAP_CLIENT_ID" || -z "$BOOTSTRAP_DEVICE_NAME" ]]; then
    echo "Both --bootstrap-client-id and --bootstrap-device-name are required when bootstrapping" >&2
    exit 1
  fi
  if [[ "$START_STACK" != "1" ]]; then
    echo "--start is required when using bootstrap flags" >&2
    exit 1
  fi
fi

if [[ "$INSTALL_EDGE_SNIPPET" == "1" && -z "$EDGE_IMPORT_DIR" ]]; then
  EDGE_IMPORT_DIR="$EDGE_IMPORT_DIR_DEFAULT"
fi

mkdir -p "$(instance_dir)"

if [[ ! -f "$(instance_env_file)" ]]; then
  render_env_file "$(instance_env_file)"
  chmod 600 "$(instance_env_file)"
fi

render_manifest "$(instance_manifest_file)"
render_caddy_snippet "$(instance_caddy_file)"

if [[ "$INSTALL_EDGE_SNIPPET" == "1" ]]; then
  install_caddy_snippet "$(instance_caddy_file)" "$EDGE_IMPORT_DIR"
fi

run_dns_hook provision

if [[ "$START_STACK" == "1" ]]; then
  start_stack "$(instance_env_file)"
  wait_for_http "http://127.0.0.1:$INSTANCE_APP_PORT/api/status/live" "$WAIT_TIMEOUT_SECONDS"
  wait_for_http "http://127.0.0.1:$INSTANCE_APP_PORT/api/status/ready" "$WAIT_TIMEOUT_SECONDS"
fi

if [[ -n "$BOOTSTRAP_CLIENT_ID" ]]; then
  bootstrap_instance "$(instance_env_file)" "$(instance_bootstrap_file)"
fi

cat <<EOF
Provisioning scaffold ready.

Instance directory: $(instance_dir)
Env file:           $(instance_env_file)
Manifest:           $(instance_manifest_file)
Edge snippet:       $(instance_caddy_file)
Compose project:    wgs-$SLUG
Loopback port:      127.0.0.1:$INSTANCE_APP_PORT

Next steps:
1. Create DNS for $DOMAIN.
2. Import the edge Caddy snippet into your shared edge proxy.
3. If you used --start, verify:
   curl -sf http://127.0.0.1:$INSTANCE_APP_PORT/api/status/live
4. Bootstrap the customer through /api/v1/control-plane/clients/:clientId/bootstrap.
EOF