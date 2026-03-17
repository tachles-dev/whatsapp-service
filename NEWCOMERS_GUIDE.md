# Newcomers Guide

This guide is for teams joining the WhatsApp Gateway Service for the first time.

## What This Service Does

The service provides:

- Multi-tenant WhatsApp device management
- Inbound webhook delivery
- Outbound WhatsApp messaging APIs
- Optional scheduling, admin dashboard, audit logging, and multi-instance routing

## Pick A Starting Profile

| You need | Start with |
|---|---|
| A small single-node webhook gateway | `lite` |
| A normal production deployment with dashboard | `standard` |
| Multi-instance deployment behind a load balancer | `full` |

Set one of these in your `.env`:

```env
MODULE_PROFILE=standard
```

## Step 1. Prepare Your Environment

Copy [.env.example](.env.example) to `.env` and fill in the values.

Minimum required variables for most deployments:

```env
API_KEY=change-me
KEY_SECRET=change-me
REDIS_URL=redis://:password@redis:6379
AUTH_BASE_DIR=/data/auth
WEBHOOK_URL=https://your-app.example.com/api/webhooks/whatsapp
WEBHOOK_API_KEY=change-me
```

If using the admin dashboard:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me
```

If using multi-instance forwarding:

```env
INSTANCE_BASE_URL=https://wgs-instance-1.internal.example.com
```

## Step 2. Choose Deployment Mode

Use the base compose file plus a profile override:

### Lite

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.lite.yml up -d
```

### Standard

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.standard.yml up -d
```

### Full

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.full.yml up -d
```

## Step 3. Verify The Service Is Healthy

Check:

```bash
curl -s http://localhost:3000/api/status | cat
curl -i http://localhost:3000/api/status/ready | cat
```

If you enabled admin, also check:

```bash
curl -s http://localhost:3000/api/admin/runtime -H "x-api-key: $API_KEY" | cat
```

If you enabled scheduling, confirm the route exists before wiring your app to it:

```bash
curl -i http://localhost:3000/api/clients/acme/devices/<deviceId>/messages/scheduled \
  -H "x-api-key: $API_KEY" | cat
```

## Step 4. Register Your First Client

Issue a client API key:

```bash
curl -s -X POST "http://localhost:3000/api/clients/acme/key" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ttlDays":90}' | cat
```

Create a device:

```bash
curl -s -X POST "http://localhost:3000/api/clients/acme/devices" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Main Number"}' | cat
```

Fetch the QR:

```bash
curl -s "http://localhost:3000/api/clients/acme/devices/<deviceId>/auth/qr" \
  -H "x-api-key: $API_KEY" | cat
```

## Step 5. Connect Your Webhook Consumer

Your app should accept WhatsApp event posts from the configured `WEBHOOK_URL`.

Recommended first events:

- messages
- reactions
- group updates

## Step 6. Send A First Message

```bash
curl -s -X POST "http://localhost:3000/api/clients/acme/devices/<deviceId>/messages/send-text" \
  -H "x-api-key: <client-key>" \
  -H "Content-Type: application/json" \
  -d '{"phone":"972501234567","text":"Hello from the gateway"}' | cat
```

## Step 6A. Schedule A Message

If the scheduling module is enabled, you can create a delayed text send:

```bash
curl -s -X POST "http://localhost:3000/api/clients/acme/devices/<deviceId>/messages/schedule-text" \
  -H "x-api-key: <client-key>" \
  -H "Content-Type: application/json" \
  -d '{"phone":"972501234567","text":"Reminder","sendAt":"2026-03-17T10:00:00.000Z"}' | cat
```

Then list pending schedules:

```bash
curl -s "http://localhost:3000/api/clients/acme/devices/<deviceId>/messages/scheduled?status=SCHEDULED" \
  -H "x-api-key: <client-key>" | cat
```

## Step 7. Know What Is Optional

| Module | Why you might disable it |
|---|---|
| `admin` | No dashboard needed |
| `audit` | You want the smallest runtime footprint |
| `heartbeat` | You do not need upstream heartbeat posts |
| `scheduling` | You only need live sends |
| `multiInstanceLeasing` | You run only one gateway instance |
| `ownerForwarding` | You do not need cross-instance device forwarding |

## Useful Files

| Purpose | File |
|---|---|
| Environment template | [.env.example](.env.example) |
| Module and profile matrix | [MODULES.md](MODULES.md) |
| Admin and API guide | [ADMIN_GUIDE.md](ADMIN_GUIDE.md) |
| Base compose file | [docker-compose.yml](docker-compose.yml) |
| Profile compose overrides | [deploy/docker-compose.lite.yml](deploy/docker-compose.lite.yml), [deploy/docker-compose.standard.yml](deploy/docker-compose.standard.yml), [deploy/docker-compose.full.yml](deploy/docker-compose.full.yml) |

## Recommended First Production Setup

Start with `standard` unless you know you need something else.

It gives you:

- dashboard access
- audit trail
- scheduling
- health checks
- no multi-instance complexity by default

## Local Validation

For this repository, the local test runner uses in-memory Redis automatically, so you can validate changes on a dev machine without starting Redis first.

```bash
npm run build
npm test
```