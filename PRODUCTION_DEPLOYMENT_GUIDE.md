# Production Deployment Guide

This guide is the practical rollout document for shipping the full product to production.

It covers both supported gateway deployment patterns:

1. `standard` — the recommended single-instance production deployment
2. `full` — the multi-instance production deployment with leasing and owner forwarding

It also explains where the internal `web/` control plane fits into the production architecture.

## What You Are Deploying

The full product has two deployable parts.

### 1. Gateway runtime

This repository's root service provides:

- Redis-backed WhatsApp connectivity
- device lifecycle and QR pairing
- outbound messaging APIs
- inbound webhook delivery
- control-plane APIs
- admin dashboard APIs

### 2. Internal web control plane

The `web/` app is a separate Next.js deployment target.

It provides:

- internal fleet dashboard
- internal client onboarding UI
- internal client metadata management

Do not treat the `web/` app as part of the Docker Compose gateway stack unless you intentionally build a separate deployment process for it.

## Choose The Right Gateway Mode

Use this decision rule.

### Use `standard` when

- you are deploying one gateway instance
- you want the normal production feature set
- you do not need cross-instance device ownership forwarding
- you want the lowest operational complexity

### Use `full` when

- you are deploying multiple gateway instances
- you need multi-instance leasing and owner forwarding
- you are intentionally building a fleet topology
- every instance has its own `INSTANCE_BASE_URL`

For most first production rollouts, start with `standard`.

## Part A — Gateway Production In `standard`

### 1. Prepare the server

Required baseline:

- Docker installed
- Docker Compose available
- DNS for the public domain already pointing at the host
- persistent disk available for auth and Redis state
- `.env` created from `.env.example`

### 2. Set the required `.env`

Minimum production template:

```env
DOMAIN=wa.example.com

PORT=3000
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info

API_KEY=replace-with-long-random-secret
KEY_SECRET=replace-with-different-long-random-secret

REDIS_PASSWORD=replace-with-long-random-secret
REDIS_URL=redis://:replace-with-long-random-secret@redis:6379

WEBHOOK_URL=https://your-app.example.com/api/webhooks/whatsapp
WEBHOOK_API_KEY=replace-with-long-random-secret

MODULE_PROFILE=standard
AUTH_BASE_DIR=/data/auth

ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-long-random-secret

CONTROL_PLANE_SECRET=replace-with-long-random-secret
CONTROL_PLANE_HEADER=x-control-plane-key
```

Notes:

- `API_KEY` is the instance master key
- `KEY_SECRET` must not match `API_KEY`
- `WEBHOOK_URL` should point to the real application that consumes WhatsApp events
- `CONTROL_PLANE_SECRET` is strongly recommended when the control-plane APIs are enabled

### 3. Deploy the gateway

Preferred entry point on the production-ready branch:

```bash
cd /opt/whatsapp-service
bash scripts/deploy-production-ready.sh
```

That wrapper keeps the old root gateway behavior, but also becomes the single operator entry point for the new production-ready layout.

The legacy command still works:

```bash
cd /opt/whatsapp-service
bash scripts/deploy.sh
```

If you intentionally want to discard a dirty tracked `Caddyfile` on the server:

```bash
bash scripts/deploy.sh --discard-local-caddy
```

### 4. Verify the gateway

Run these checks on the server:

```bash
docker compose ps
docker compose exec app curl -sf http://localhost:3000/api/status && echo
docker compose exec app curl -sf http://localhost:3000/api/status/live && echo
```

Run these checks externally:

```bash
curl -i --max-time 10 https://wa.example.com/api/v1/status/live
curl -i --max-time 10 https://wa.example.com/api/v1/reference
curl -i --max-time 10 https://wa.example.com/api/v1/openapi.json
```

### 5. Perform the real functional smoke test

Before calling the instance production-ready, do all of these:

1. create a client key
2. create a device
3. fetch a QR code
4. pair a real WhatsApp account
5. confirm the device reaches `CONNECTED`
6. confirm a real webhook event arrives at the configured consumer
7. confirm the consumer rejects an invalid webhook signature

If any of those fail, the code may be ready but the environment is not.

## Part B — Gateway Production In `full`

Use this only for a real multi-instance topology.

### 1. Requirements

Every gateway instance needs:

- its own domain or reachable base URL
- its own `.env`
- its own persistent auth storage
- reachable Redis
- `INSTANCE_BASE_URL` set to that instance's public or internal routed address

### 2. Set the required `.env` per instance

```env
DOMAIN=wa-eu-1.example.com

PORT=3000
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info

API_KEY=replace-with-instance-master-key
KEY_SECRET=replace-with-instance-key-secret

REDIS_PASSWORD=replace-with-long-random-secret
REDIS_URL=redis://:replace-with-long-random-secret@redis:6379

WEBHOOK_URL=https://your-app.example.com/api/webhooks/whatsapp
WEBHOOK_API_KEY=replace-with-long-random-secret

MODULE_PROFILE=full
AUTH_BASE_DIR=/data/auth
INSTANCE_BASE_URL=https://wa-eu-1.example.com

ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-long-random-secret

CONTROL_PLANE_SECRET=replace-with-long-random-secret
CONTROL_PLANE_HEADER=x-control-plane-key
```

### 3. Deploy each gateway instance

```bash
cd /opt/whatsapp-service
docker compose -f docker-compose.yml -f deploy/docker-compose.full.yml up -d --build
```

Or use the deploy script if your `.env` already sets `MODULE_PROFILE=full`:

```bash
bash scripts/deploy.sh
```

### 4. Verify multi-instance behavior

In addition to the standard checks, verify:

1. instance registration and lease renewal
2. device ownership resolves correctly
3. forwarded device requests reach the owning instance
4. failure behavior is acceptable when one instance is unavailable

Do not label a `full` deployment production-ready until that behavior is exercised in a real environment.

## Part C — Deploy The Internal Web Control Plane

The internal `web/` app is separate from the gateway Compose stack.

Deploy it as its own Next.js service.

### Single-instance web control plane env

```env
WGS_URL=https://wa.example.com
WGS_MASTER_KEY=same-value-as-API_KEY-in-the-gateway
WGS_API_BASE_PATH=/api/v1

WGS_CONTROL_PLANE_HEADER=x-control-plane-key
WGS_CONTROL_PLANE_SECRET=same-value-as-CONTROL_PLANE_SECRET-in-the-gateway

WGS_ADMIN_UI_USERNAME=admin
WGS_ADMIN_UI_PASSWORD=replace-with-long-random-secret
```

### Multi-instance fleet web control plane env

```env
WGS_FLEET_INSTANCES=[{"id":"eu-1","label":"EU Cluster","baseUrl":"https://wa-eu-1.example.com","apiKey":"replace-with-master-key","apiBasePath":"/api/v1","controlPlaneSecret":"replace-with-control-plane-secret"},{"id":"us-1","label":"US Cluster","baseUrl":"https://wa-us-1.example.com","apiKey":"replace-with-master-key","apiBasePath":"/api/v1","controlPlaneSecret":"replace-with-control-plane-secret"}]

WGS_ADMIN_UI_USERNAME=admin
WGS_ADMIN_UI_PASSWORD=replace-with-long-random-secret
```

### Deploy steps for `web/`

Preferred single-command deployment on the server:

```bash
cd /opt/whatsapp-service
bash scripts/deploy-production-ready.sh --deploy-web --web-install
```

That command:

- pulls the latest branch unless `--skip-pull` is used
- builds the internal `web/` app
- starts it in the background on `127.0.0.1:3300`
- writes a PID file to `web/.next/wgs-admin.pid`
- writes logs to `web/.next/wgs-admin.log`

If you want to run only the internal control plane and skip the gateway stack:

```bash
bash scripts/deploy-production-ready.sh --web-only --deploy-web --web-install
```

If you want a different local port:

```bash
bash scripts/deploy-production-ready.sh --deploy-web --web-install --web-port 3400
```

Manual deploy steps still work when you want finer control:

```bash
cd web
npm install
npm run build
```

Then deploy it to your chosen Next.js hosting target such as:

- Vercel
- a separate Node process behind a reverse proxy
- a separate containerized Next.js deployment

### Verify the web control plane

1. confirm HTTP Basic auth blocks unauthenticated access
2. confirm the dashboard loads instance and client data
3. confirm the registration flow creates a client and first device
4. confirm the per-client management page can update metadata

## Part D — Final Go/No-Go Checklist

Ship only when all of these are true.

### Gateway

- build is green
- tests are green
- `/api/v1/status/live` is healthy
- `/api/v1/reference` and `/api/v1/openapi.json` are reachable
- a real WhatsApp device reaches `CONNECTED`
- a real webhook reaches the consumer
- Redis persistence survives restart
- auth storage survives restart

### Web control plane

- the app is protected by `WGS_ADMIN_UI_USERNAME` and `WGS_ADMIN_UI_PASSWORD`
- it can reach the gateway with `WGS_MASTER_KEY` or `WGS_FLEET_INSTANCES`
- operator workflows work from server-side code only
- no browser code receives privileged gateway secrets

## Recommended First Production Rollout

If you want the least risky path:

1. deploy one gateway in `standard`
2. validate real pairing and webhook delivery
3. deploy `web/` against that one instance
4. move to `full` only when you truly need multi-instance routing

That gets the full product live faster and with fewer operational unknowns.