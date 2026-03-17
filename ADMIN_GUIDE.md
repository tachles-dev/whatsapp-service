# WhatsApp Gateway — Admin Guide

## Prerequisites

All admin operations require the master API key (`API_KEY` env var). Pass it in every request:

```
x-api-key: <your-master-API_KEY>
```

---

## 1. Registering a New Client

A **client** is a tenant — an organisation or application that uses the gateway under its own isolated namespace. The registration process has three steps.

### Step 1 — Issue an API key

```http
POST /api/clients/:clientId/key
x-api-key: <master-key>
Content-Type: application/json

{ "ttlDays": 90 }
```

| Field | Notes |
|---|---|
| `clientId` | URL-safe slug you choose, e.g. `acme` or `team-sales`. Immutable. |
| `ttlDays` | Key lifetime in days. Default `90`, max `365`. |

**Response** — the plaintext key is returned **once only**. Store it immediately.

```json
{
  "ok": true,
  "data": {
    "key": "a3f...7d2",
    "warning": "Store this key securely. It will never be shown again."
  }
}
```

> The gateway stores only an HMAC hash.  If the key is lost, rotate it (see §4).

---

### Step 2 — Configure the client (optional)

Set a dedicated webhook and choose which events to forward:

```http
PUT /api/clients/:clientId/config
x-api-key: <master-key>
Content-Type: application/json

{
  "webhookUrl": "https://your-app.example.com/webhooks/whatsapp",
  "webhookApiKey": "secret-for-your-app",
  "events": {
    "messages": true,
    "reactions": true,
    "receipts": false,
    "groupParticipants": true,
    "presenceUpdates": false,
    "groupUpdates": true,
    "calls": false
  },
  "maxDevices": 5
}
```

Skip this step to inherit global defaults (`WEBHOOK_URL` / `WEBHOOK_API_KEY` env vars, up to 5 devices).

---

### Step 3 — Register a WhatsApp device

A device maps to one WhatsApp phone number or business account.

```http
POST /api/clients/:clientId/devices
x-api-key: <master-key>
Content-Type: application/json

{ "name": "Main Sales Number" }
```

Response includes the `deviceId`. The device starts in `INITIALIZING` state and generates a QR code within a few seconds.

**Scan the QR code to link the WhatsApp account:**

```http
GET /api/clients/:clientId/devices/:deviceId/auth/qr
x-api-key: <master-key>
```

The `qr` field in the response is a raw QR string. Render it with any QR library (e.g. `qrcode`), or open the admin dashboard (see §2) where it is displayed automatically.

**Check connection status:**

```http
GET /api/clients/:clientId/devices/:deviceId/status
x-api-key: <master-key>
```

| Status | Meaning |
|---|---|
| `INITIALIZING` | Starting up |
| `QR_READY` | Waiting for QR scan |
| `CONNECTED` | Linked and ready |
| `DISCONNECTED` | Lost connection |
| `ERROR` | Fatal error — reset or remove the device |

Once status is `CONNECTED` the client is live and can send/receive messages.

---

### Complete example (curl)

```bash
CLIENT="acme"
MASTER_KEY="your-master-key"
BASE="https://gateway.example.com"

# 1. Issue API key
curl -s -X POST "$BASE/api/clients/$CLIENT/key" \
  -H "x-api-key: $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ttlDays":180}'

# 2. Configure webhook
curl -s -X PUT "$BASE/api/clients/$CLIENT/config" \
  -H "x-api-key: $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl":"https://your-app.example.com/webhooks/whatsapp"}'

# 3. Create a device
curl -s -X POST "$BASE/api/clients/$CLIENT/devices" \
  -H "x-api-key: $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Main Number"}'
# → note the deviceId in the response

# 4. Fetch QR string
curl -s "$BASE/api/clients/$CLIENT/devices/<deviceId>/auth/qr" \
  -H "x-api-key: $MASTER_KEY"
```

---

## 2. Admin Dashboard

### Opening the dashboard

Navigate to:

```
https://gateway.example.com/admin
```

The dashboard now uses admin credentials and a server-side session cookie.

Required env vars when the admin module is enabled:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me
```

### What's shown

| Section | Description |
|---|---|
| **Device totals** | Counts per status: Connected, QR Ready, Disconnected, Initializing, Error |
| **Queue** | BullMQ webhook delivery job counts: waiting, active, completed, failed, delayed |
| **Clients table** | Every registered client with its devices, phone numbers, and live statuses |
| **Uptime** | Service uptime in seconds |

### JSON stats endpoint

For programmatic access or external monitoring:

```http
GET /api/admin/stats
Cookie: wga_admin=<session-cookie>
```

```json
{
  "ok": true,
  "data": {
    "devices": {
      "total": 4,
      "byStatus": { "CONNECTED": 3, "QR_READY": 1, "DISCONNECTED": 0, ... },
      "byClient": {
        "acme": [
          { "deviceId": "dev_...", "name": "Main Number", "phone": "972501234567", "status": "CONNECTED" }
        ]
      }
    },
    "queue": { "waiting": 0, "active": 1, "completed": 842, "failed": 2, "delayed": 0 },
    "uptime": 3600,
    "timestamp": 1741737600000
  }
}
```

---

## 3. Runtime Profiles And Modules

The service can be started in a lighter or heavier mode.

### Built-in profiles

| Profile | Use case |
|---|---|
| `lite` | Minimal single-node webhook gateway |
| `standard` | Full single-node production deployment |
| `full` | Multi-instance deployment with leasing and owner forwarding |

### Select a profile

```env
MODULE_PROFILE=standard
```

Or load a custom module file:

```env
MODULE_CONFIG_PATH=./config/modules.custom.json
```

### Module overrides

Each module can be overridden individually with env vars such as:

- `MODULE_ADMIN_ENABLED=false`
- `MODULE_SCHEDULING_ENABLED=false`
- `MODULE_OWNER_FORWARDING_ENABLED=false`

See [MODULES.md](MODULES.md) for the full matrix and examples.

---

## 4. Managing Existing Clients

### List all devices for a client

```http
GET /api/clients/:clientId/devices
x-api-key: <master-key>
```

### View client configuration (key metadata included)

```http
GET /api/clients/:clientId/config
x-api-key: <master-key>
```

Returns key metadata (`hasKey`, `expiresAt`, `lastUsedAt`, `lastUsedIp`) without exposing the hash.

### Disconnect / reconnect a device

```http
POST /api/clients/:clientId/devices/:deviceId/disconnect
POST /api/clients/:clientId/devices/:deviceId/reconnect
x-api-key: <master-key>
```

### Reset WhatsApp auth (force re-scan)

```http
POST /api/clients/:clientId/devices/:deviceId/auth/reset
x-api-key: <master-key>
```

Clears stored credentials and generates a new QR code.

### Remove a device permanently

```http
DELETE /api/clients/:clientId/devices/:deviceId
x-api-key: <master-key>
```

### Reset client config to defaults

```http
DELETE /api/clients/:clientId/config
x-api-key: <master-key>
```

---

## 5. Scheduled Messaging

Scheduled messaging is currently available for text messages. The gateway stores the schedule in Redis and uses a delayed BullMQ job to send it at `sendAt`.

### Required headers

Every request needs:

```http
x-api-key: <master-key-or-client-key>
Content-Type: application/json
```

The master key works everywhere. A client key works only under that client's `/api/clients/:clientId/...` routes.

### Create a scheduled text message

```http
POST /api/clients/:clientId/devices/:deviceId/messages/schedule-text
x-api-key: <master-or-client-key>
Content-Type: application/json

{
  "jid": "972501234567@s.whatsapp.net",
  "text": "Reminder: standup starts in 10 minutes.",
  "sendAt": "2026-03-16T07:50:00.000Z",
  "options": {
    "quotedMessageId": "optional-message-id",
    "mentionedJids": ["972501234567@s.whatsapp.net"]
  }
}
```

You may send `phone` instead of `jid`.

```json
{
  "phone": "972501234567",
  "text": "Reminder: standup starts in 10 minutes.",
  "sendAt": "2026-03-16T07:50:00.000Z"
}
```

### List scheduled messages for a device

```http
GET /api/clients/:clientId/devices/:deviceId/messages/scheduled
GET /api/clients/:clientId/devices/:deviceId/messages/scheduled?status=SCHEDULED
x-api-key: <master-or-client-key>
```

Allowed `status` values:

- `SCHEDULED`
- `PROCESSING`
- `SENT`
- `FAILED`
- `CANCELLED`

### Get one scheduled message

```http
GET /api/clients/:clientId/devices/:deviceId/messages/scheduled/:scheduleId
x-api-key: <master-or-client-key>
```

### Cancel a scheduled message

```http
DELETE /api/clients/:clientId/devices/:deviceId/messages/scheduled/:scheduleId
x-api-key: <master-or-client-key>
```

### Reschedule an existing scheduled message

```http
POST /api/clients/:clientId/devices/:deviceId/messages/scheduled/:scheduleId/reschedule
x-api-key: <master-or-client-key>
Content-Type: application/json

{
  "sendAt": "2026-03-16T08:05:00.000Z"
}
```

### Notes

- `sendAt` must be a future ISO-8601 timestamp.
- If the device is offline when the job runs, the queue retries automatically with exponential backoff.
- When a message is sent successfully, the record moves to `SENT` and includes `sentMessageId`.
- Cancelling a `SENT` message is rejected.

---

## 6. API Key Lifecycle

### Rotate a key (replaces the existing one immediately)

```http
POST /api/clients/:clientId/key/rotate
x-api-key: <master-key>
Content-Type: application/json

{ "ttlDays": 90 }
```

The client can also rotate its own key by passing its current client key instead of the master key.

### Revoke a key (disable without removing the client)

```http
DELETE /api/clients/:clientId/key
x-api-key: <master-key>
```

After revocation all requests using that client key return `401 UNAUTHORIZED`. Re-issue via Step 1 to re-enable.

---

## 5. Access Control (per client)

### Ban a phone number (block inbound messages from it)

```http
POST /api/clients/:clientId/banned-numbers
x-api-key: <master-key>
Content-Type: application/json

{ "phone": "972501234567" }
```

### Restrict to an allowlist (empty list = open mode)

```http
POST /api/clients/:clientId/allowed-numbers
Content-Type: application/json

{ "phone": "972501234567" }
```

Remove with `DELETE /api/clients/:clientId/allowed-numbers/:phone` (and similarly for banned numbers).
