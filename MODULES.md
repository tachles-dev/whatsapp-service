# WhatsApp Gateway Modules And Profiles

This service can run in a light or heavy mode. Module loading is controlled by either:

- `MODULE_PROFILE`
- `MODULE_CONFIG_PATH`
- Per-module env overrides like `MODULE_ADMIN_ENABLED=false`

Priority order:

1. Per-module env overrides
2. Module config file values
3. Module profile
4. Built-in defaults

## Profiles

| Profile | Admin | Audit | Heartbeat | Webhooks | Scheduling | Leasing | Owner Forwarding | Intended Use |
|---|---|---|---|---|---|---|---|---|
| `lite` | off | off | off | on | off | off | off | Single-node, simple webhook gateway |
| `standard` | on | on | on | on | on | off | off | Single-node production with dashboard |
| `full` | on | on | on | on | on | on | on | Multi-instance deployment |

`MODULE_CONFIG_PATH` is for a custom JSON file when a built-in profile plus env overrides is not enough.

## Fast Start

Use a profile directly:

```env
MODULE_PROFILE=lite
```

Or use a file:

```env
MODULE_CONFIG_PATH=./config/modules.custom.json
```

Example file:

```json
{
	"profile": "standard",
	"modules": {
		"admin": true,
		"audit": true,
		"scheduling": false
	}
}
```

## Per-Module Overrides

These env vars override both the profile and the config file:

- `MODULE_ADMIN_ENABLED`
- `MODULE_AUDIT_ENABLED`
- `MODULE_HEARTBEAT_ENABLED`
- `MODULE_WEBHOOKS_ENABLED`
- `MODULE_SCHEDULING_ENABLED`
- `MODULE_MULTI_INSTANCE_LEASING_ENABLED`
- `MODULE_OWNER_FORWARDING_ENABLED`

Accepted values: `true`, `false`, `1`, `0`, `yes`, `no`, `on`, `off`.

## Multi-Instance Requirements

If `ownerForwarding` is enabled, `INSTANCE_BASE_URL` must be set to a per-instance reachable URL.

If `multiInstanceLeasing` is disabled, `ownerForwarding` is automatically disabled.

Recommended values for full mode:

```env
MODULE_PROFILE=full
INSTANCE_BASE_URL=https://wgs-instance-1.internal.example.com
```

## Operational Notes

- When `webhooks` is disabled, inbound events are not queued or delivered.
- When `scheduling` is disabled, scheduled-message routes and workers are not started.
- When `admin` is disabled, `/admin` and `/api/admin/*` routes are not registered.
- When `audit` is disabled, audit writes become no-ops.
- When `heartbeat` is disabled, heartbeat posts are not sent.
- The local test runner forces `WGA_IN_MEMORY_REDIS=1`, so `npm test` does not require a Redis server on the dev machine.

## Suggested Deployment Modes

### Small single-purpose gateway

```env
MODULE_PROFILE=lite
```

### Normal single-node production

```env
MODULE_PROFILE=standard
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me
```

### Multi-instance production

```env
MODULE_PROFILE=full
INSTANCE_BASE_URL=https://wgs-instance-1.internal.example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me
```