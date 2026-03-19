# Client Onboarding Playbook

This guide is for you as the platform admin when a new client wants access to the WhatsApp Gateway Service.

It documents the onboarding flow the current codebase actually supports.

## What The Platform Supports Today

Today the gateway supports:

- creating a tenant-scoped client ID
- issuing a tenant API key
- creating one or more WhatsApp devices under that tenant
- pairing the client phone by QR scan
- giving the tenant API-level control over its own devices and access-control lists

Today the gateway does **not** support:

- a safe customer-facing self-service join link
- storing full customer contact details inside the gateway
- a tenant-specific browser login or dedicated customer dashboard session

Your stated policy should therefore be:

- no public signup
- no client-created tenants
- no customer access to the internal registration UI
- every new tenant is created only after your manual approval

Important consequence:

- Do **not** send the built-in `web/register` page directly to a client. It uses the master key server-side and is an internal admin helper, not a tenant-safe invite flow.
- Protect the example `web/` app with admin-only credentials before deploying it anywhere reachable from the internet.

For the current `web/` app, set these environment variables:

```env
WGS_ADMIN_UI_USERNAME=your-admin-ui-user
WGS_ADMIN_UI_PASSWORD=your-admin-ui-password
WGS_CONTROL_PLANE_SECRET=match-the-instance-control-plane-secret
WGS_CONTROL_PLANE_HEADER=x-control-plane-key
```

Without them, the app now fails closed and returns `401` instead of exposing the dashboard or registration flow.

If you want the exact flow you described, where the client opens a unique invite link, fills in their own business/contact details, pairs their phone, and then lands in their own dashboard, that requires an additional control-plane app on top of this gateway.

## Recommended Current Workflow

Use this as your standard operating procedure for adding a new client.

Registration policy:

1. A prospect contacts you.
2. You decide whether to approve them.
3. Only after approval do you create the tenant.
4. Only you or your staff perform the initial QR pairing workflow.

### Step 1. Collect The Client Details Outside The Gateway

Before touching the API, record these in your CRM, Notion, spreadsheet, or admin system:

- company name
- main contact name
- contact email
- contact phone
- desired client slug
- webhook URL, if they have their own app
- number of devices you plan to allow
- who will receive the API key

The gateway itself stores tenant technical configuration, not a complete customer profile.

### Step 2. Choose A Stable Client ID

Pick a lowercase tenant slug such as:

- `acme`
- `acme-sales`
- `north_region_team`

Rules taken from the current onboarding UI:

- lowercase letters only
- numbers allowed
- hyphens and underscores allowed
- avoid spaces and renaming later

Treat `clientId` as the tenant boundary for:

- API key validation
- device ownership
- per-client config
- access-control lists

### Step 3. Issue The Client API Key

Create the tenant key with the master key:

```bash
BASE="https://your-gateway.example.com"
MASTER_KEY="your-master-key"
CLIENT_ID="acme"

curl -s -X POST "$BASE/api/v1/clients/$CLIENT_ID/key" \
  -H "x-api-key: $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ttlDays":90}'
```

Expected result:

- a plaintext `key`
- a warning telling you it will never be shown again

Operational rule:

- store this key immediately in your password manager or secure secrets vault
- do not send it over casual chat if you can avoid it

### Step 4. Apply Per-Client Config

If the client needs custom webhook delivery or a stricter device limit, set it now.

```bash
curl -s -X PUT "$BASE/api/v1/clients/$CLIENT_ID/config" \
  -H "x-api-key: $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookUrl": "https://client.example.com/api/webhooks/whatsapp",
    "webhookApiKey": "client-webhook-secret",
    "maxDevices": 1,
    "events": {
      "messages": true,
      "reactions": true,
      "receipts": false,
      "groupParticipants": true,
      "presenceUpdates": false,
      "groupUpdates": true,
      "calls": false
    }
  }'
```

Use this step to define what the client is allowed to operate under that tenant.

Good defaults for most customers:

- `maxDevices: 1` if they should manage a single WhatsApp number
- custom `webhookUrl` only if they already have an app that consumes events
- leave webhook fields unset if they will use your own downstream system

### Step 5. Create The First Device

Create the WhatsApp device record:

```bash
DEVICE_NAME="Main Number"

curl -s -X POST "$BASE/api/v1/clients/$CLIENT_ID/devices" \
  -H "x-api-key: $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$DEVICE_NAME\"}"
```

Save the returned `deviceId`.

The device starts asynchronously. The initial status is usually `INITIALIZING`, and a QR becomes available shortly after.

### Step 6. Pair The Client Phone

Fetch the QR code:

```bash
DEVICE_ID="returned-device-id"

curl -s "$BASE/api/v1/clients/$CLIENT_ID/devices/$DEVICE_ID/auth/qr" \
  -H "x-api-key: $MASTER_KEY"
```

Possible outcomes:

- `qr` returned: render it and scan from the client's WhatsApp app
- `QR_NOT_AVAILABLE`: wait a few seconds and retry
- `qr: null` with an "Already connected" message: the phone is already paired

Recommended operational practice:

- if the client is local, open the QR and let them scan it in front of you
- if the client is remote, do the pairing during a call or screen-share session
- do not give them the master key or the admin dashboard just to complete QR pairing

### Step 7. Poll Until The Device Is Connected

```bash
curl -s "$BASE/api/v1/clients/$CLIENT_ID/devices/$DEVICE_ID/status" \
  -H "x-api-key: $MASTER_KEY"
```

Wait for `status: CONNECTED`.

If the device gets stuck:

- `INITIALIZING`: wait a bit longer
- `QR_READY`: the phone has not been scanned yet
- `DISCONNECTED`: ask the client to reconnect or request a new QR
- `ERROR`: reset auth or recreate the device if the error persists

To generate a fresh QR:

```bash
curl -s -X POST "$BASE/api/v1/clients/$CLIENT_ID/devices/$DEVICE_ID/auth/reset" \
  -H "x-api-key: $MASTER_KEY"
```

### Step 8. Hand Off The Tenant Access

Once the device is connected, send the client:

- their `clientId`
- their tenant API key
- their `deviceId`
- the base URL they should use
- a short list of supported operations

What they can control today with the tenant key:

- read their config: `GET /api/v1/clients/:clientId/config`
- update their config if you permit that workflow in your product
- list devices: `GET /api/v1/clients/:clientId/devices`
- read device status: `GET /api/v1/clients/:clientId/devices/:deviceId/status`
- request a QR: `GET /api/v1/clients/:clientId/devices/:deviceId/auth/qr`
- reset auth: `POST /api/v1/clients/:clientId/devices/:deviceId/auth/reset`
- disconnect or reconnect a device
- manage allowed and banned phone numbers
- use message, chat, group, and contact routes under their tenant

What they do **not** get today:

- a tenant browser session
- a dedicated hosted dashboard inside this repository
- access to other tenants
- access to `/api/admin/*`

### Step 9. Configure Access Restrictions If Needed

If the client wants to restrict who can contact the device, configure tenant-level lists.

Allowlist example:

```bash
curl -s -X POST "$BASE/api/v1/clients/$CLIENT_ID/allowed-numbers" \
  -H "x-api-key: $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phone":"972501234567"}'
```

Blocklist example:

```bash
curl -s -X POST "$BASE/api/v1/clients/$CLIENT_ID/banned-numbers" \
  -H "x-api-key: $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phone":"972509998888"}'
```

Use these when the customer asks for device-level accessibility controls.

### Step 10. Run The Go-Live Checklist

Before you tell the client they are live, confirm all of these:

1. `GET /api/v1/clients/:clientId/config` returns the expected settings.
2. `GET /api/v1/clients/:clientId/devices` shows the new device.
3. `GET /api/v1/clients/:clientId/devices/:deviceId/status` returns `CONNECTED`.
4. The phone number appears on the device record once paired.
5. If webhooks are enabled, the webhook endpoint is reachable and receiving expected events.
6. The client key has been stored securely and delivered through a secure channel.

## Admin Handoff Template

You can use this message template when sending access details to a new client.

```text
Your WhatsApp tenant has been created.

Client ID: <clientId>
Device ID: <deviceId>
Gateway Base URL: <baseUrl>

Your tenant API key will be sent through our secure secrets channel.

Current scope:
- 1 WhatsApp device
- tenant-scoped API access only
- no browser dashboard yet

If you need a new QR, device reconnect, or webhook changes, contact us.
```

## Rotation And Offboarding

### Rotate the tenant key

```bash
curl -s -X POST "$BASE/api/v1/clients/$CLIENT_ID/key/rotate" \
  -H "x-api-key: $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ttlDays":90}'
```

### Revoke the tenant key

```bash
curl -s -X DELETE "$BASE/api/v1/clients/$CLIENT_ID/key" \
  -H "x-api-key: $MASTER_KEY"
```

### Remove a device

```bash
curl -s -X DELETE "$BASE/api/v1/clients/$CLIENT_ID/devices/$DEVICE_ID" \
  -H "x-api-key: $MASTER_KEY"
```

Use key rotation when the client changes operators. Use revocation and device deletion when the client leaves the platform.

## If You Want The Exact Self-Service Flow

To support the workflow you described, build a small control-plane app on top of this gateway with these steps:

1. You create a one-time invite token in your own app.
2. You send the client a unique invite URL.
3. That page collects company and contact details.
4. A server action or backend route creates the tenant key and first device using the master key.
5. The page renders the QR code without exposing the master key.
6. After pairing, your app creates a tenant-scoped browser session.
7. The client lands in a dashboard that only calls gateway routes for their own `clientId` using their tenant key server-side.

That control-plane app can live in the `web/` project, but it is not implemented yet in the current repository.