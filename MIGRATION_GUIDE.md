# Existing Client Migration Guide

This guide is for clients already using the WhatsApp Gateway Service before the modular runtime, admin sessions, send throttling, and multi-instance ownership changes.

## What Changed

| Area | Old Behavior | New Behavior |
|---|---|---|
| Admin dashboard | Prompted for master API key in browser | Uses `ADMIN_USERNAME` and `ADMIN_PASSWORD` with a server-side session |
| Runtime shape | All subsystems effectively loaded together | Runtime modules can now be enabled or disabled by profile or config file |
| Health checks | Simple status endpoint | Load-aware liveness and readiness endpoints |
| Multi-instance behavior | No explicit device lease ownership | Optional Redis-backed leasing and owner-aware forwarding |
| Outbound sending | No tenant/device send quotas | Per-client and per-device send throttling |
| Auditing | Limited/no action trail | Optional audit event log in Redis |

## Migration Checklist

### 1. Decide your target runtime profile

| Current deployment style | Recommended profile |
|---|---|
| Single-node, simple webhook gateway | `lite` |
| Single-node with dashboard and scheduling | `standard` |
| Multi-instance deployment | `full` |

Set either:

```env
MODULE_PROFILE=standard
```

Or:

```env
MODULE_CONFIG_PATH=./config/modules.custom.json
```

### 2. Add required environment variables

For all deployments:

```env
API_KEY=...
KEY_SECRET=...
REDIS_URL=...
AUTH_BASE_DIR=/data/auth
```

If `webhooks` or `heartbeat` is enabled:

```env
WEBHOOK_URL=https://your-app.example.com/api/webhooks/whatsapp
WEBHOOK_API_KEY=...
```

If `admin` is enabled:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me
```

If `ownerForwarding` is enabled:

```env
INSTANCE_BASE_URL=https://wgs-instance-1.internal.example.com
```

### 3. Review send-rate expectations

The service now enforces outbound quotas.

Default values:

```env
SEND_THROTTLE_WINDOW_MS=60000
CLIENT_SENDS_PER_WINDOW=300
DEVICE_SENDS_PER_WINDOW=120
BROADCAST_MAX_CONCURRENCY=5
```

If you run higher-volume traffic, tune these values deliberately before rollout.

### 4. Validate admin access

The dashboard no longer accepts the master key directly in the browser UI.

Test:

1. Open `/admin`
2. Sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`
3. Confirm the response sets the `wga_admin` HttpOnly cookie
4. Confirm `/api/admin/runtime` and `/api/admin/stats` load successfully without adding `x-api-key`

### 5. Validate health checks

Confirm these endpoints behave correctly behind your proxy or balancer:

- `/api/status`
- `/api/status/live`
- `/api/status/ready`

### 6. Validate device ownership if running multiple instances

If you use `full` mode:

1. Confirm each instance has a unique `INSTANCE_ID`
2. Confirm each instance has a reachable `INSTANCE_BASE_URL`
3. Confirm Redis lease keys are being created
4. Confirm device-scoped requests can be forwarded to the owning instance

## Recommended Rollout Path

### Single-node clients

1. Move to `standard`
2. Add admin credentials
3. Validate dashboard and readiness
4. Enable or disable scheduling/audit as needed

### Multi-instance clients

1. Stage one instance with `full`
2. Verify instance registry and lease ownership
3. Add a second instance
4. Verify forwarding of device-scoped routes
5. Move traffic gradually behind the load balancer

## Backward Compatibility Notes

| Feature | Compatibility |
|---|---|
| Client keys | Still supported |
| Device and messaging APIs | Still supported |
| Legacy `/send` endpoint | Still supported |
| Scheduled message APIs | Available only when scheduling module is enabled |
| Admin routes | Available only when admin module is enabled |

## Quick Verification Commands

### Check runtime state

```bash
curl -s https://your-gateway.example.com/api/status | cat
```

### Check readiness

```bash
curl -i https://your-gateway.example.com/api/status/ready | cat
```

### Check module profile from admin

```bash
curl -s https://your-gateway.example.com/api/admin/runtime \
  -H "x-api-key: $API_KEY" | cat
```

### Check scheduled-message route availability

```bash
curl -i https://your-gateway.example.com/api/clients/acme/devices/device-1/messages/scheduled \
  -H "x-api-key: $API_KEY" | cat
```

Expected result:

- `200` when the scheduling module is enabled
- `404` when the scheduling module is disabled

## If You Want Minimum Change

Use:

```env
MODULE_PROFILE=standard
```

This preserves the broadest existing behavior while adopting the new runtime safely.