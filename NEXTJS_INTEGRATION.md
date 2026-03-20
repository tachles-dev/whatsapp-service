# WhatsApp Gateway Service — Next.js Integration Guide

This is the current integration guide for using the WhatsApp Gateway Service from a Next.js application.

It reflects the repository as it exists now, including:

- server-only gateway access
- the internal `web/` control-plane app
- single-instance mode
- fleet mode with `WGS_FLEET_INSTANCES`
- server-action-based onboarding
- per-client management pages

## What This Guide Covers

Use this guide when you are:

1. building a new Next.js application that talks to the gateway
2. deploying the internal `web/` control-plane app from this repository
3. upgrading an older Next.js integration to the current gateway contract

## Current Next.js App Shape In This Repository

The active sample implementation now lives in:

- `web/lib/wgs.ts`
- `web/app/page.tsx`
- `web/app/register/page.tsx`
- `web/app/register/register-form.tsx`
- `web/app/register/actions.ts`
- `web/app/fleet/[instanceId]/clients/[clientId]/page.tsx`
- `web/app/fleet/[instanceId]/clients/[clientId]/client-editor.tsx`
- `web/proxy.ts`

That app is not a public customer app. It is an internal control surface.

## Integration Model

The gateway should be treated as a server-to-server dependency.

Your Next.js app is responsible for:

1. calling the gateway only from server-side code
2. exposing its own route handlers or server actions to browser clients
3. receiving webhook events from the gateway when needed
4. keeping gateway secrets out of the browser bundle

Never call privileged gateway endpoints directly from client components.

## Two Valid Next.js Usage Modes

There are two valid ways to use Next.js with this product.

### 1. Client application integration

This is a business application that consumes WhatsApp functionality.

Examples:

- CRM inbox app
- support dashboard
- nonprofit messaging workflow
- outbound notification tool

In this mode, the Next.js app usually needs:

- `WGS_URL`
- `WGS_MASTER_KEY`
- `WGS_WEBHOOK_SECRET`

### 2. Internal control plane

This is the `web/` app in this repository.

It is an operator-only dashboard that can:

- list instances
- list clients
- bootstrap a new client on a chosen instance
- display storage, quota, and status data
- update client metadata

In this mode, the Next.js app uses either:

- single-instance env vars, or
- `WGS_FLEET_INSTANCES` for multi-instance control

## Environment Variables

### A. Client application integration

Use these in the Next.js app environment:

```env
WGS_URL=https://your-gateway-domain.example.com
WGS_MASTER_KEY=same-value-as-API_KEY-in-the-gateway
WGS_WEBHOOK_SECRET=same-value-as-WEBHOOK_API_KEY-in-the-gateway
```

Optional:

```env
WGS_API_BASE_PATH=/api/v1
```

Use `WGS_API_BASE_PATH=/api` only for older gateway deployments that do not expose the versioned API yet.

### B. Internal control plane in single-instance mode

```env
WGS_URL=https://your-gateway-domain.example.com
WGS_MASTER_KEY=same-value-as-API_KEY-in-the-gateway
WGS_API_BASE_PATH=/api/v1

WGS_CONTROL_PLANE_HEADER=x-control-plane-key
WGS_CONTROL_PLANE_SECRET=same-value-as-CONTROL_PLANE_SECRET-in-the-gateway

WGS_ADMIN_UI_USERNAME=admin
WGS_ADMIN_UI_PASSWORD=replace-with-long-random-secret
```

### C. Internal control plane in fleet mode

```env
WGS_FLEET_INSTANCES=[{"id":"eu-1","label":"EU Cluster","baseUrl":"https://wa-eu.example.com","apiKey":"replace-with-master-key","apiBasePath":"/api/v1","controlPlaneSecret":"replace-with-control-plane-secret"},{"id":"us-1","label":"US Cluster","baseUrl":"https://wa-us.example.com","apiKey":"replace-with-master-key"}]

WGS_ADMIN_UI_USERNAME=admin
WGS_ADMIN_UI_PASSWORD=replace-with-long-random-secret
```

Optional shared control-plane defaults:

```env
WGS_CONTROL_PLANE_HEADER=x-control-plane-key
WGS_CONTROL_PLANE_SECRET=replace-with-long-random-secret
```

## What The Current `web/` App Does

The internal `web/` app is now a fleet-aware control surface.

### Dashboard

`web/app/page.tsx` is a Server Component dashboard that:

1. loads instance inventory server-side
2. aggregates clients, devices, quota usage, and auth storage
3. shows instance-level errors without exposing secrets to the browser

It uses ISR with `revalidate = 10` for a low-friction operator dashboard.

### Registration

`web/app/register/actions.ts` performs an internal onboarding workflow:

1. choose the target instance
2. create the client namespace
3. create the first device
4. issue the first client API key
5. optionally save company, contact, plan, and tags metadata
6. fetch the onboarding QR
7. convert the QR to an image data URL for display

This flow is server-only and does not expose the gateway master key to the browser.

### Per-client management

`web/app/fleet/[instanceId]/clients/[clientId]/page.tsx` loads one managed client and shows:

- metadata
- config snapshot
- device list
- quota usage
- auth storage
- allowlist and banlist data

`client-editor.tsx` updates metadata through a server action.

## Server-Only Gateway Helper Pattern

Put gateway access behind a server-only helper like `web/lib/wgs.ts`.

The current helper supports:

- single-instance fallback with `WGS_URL` and `WGS_MASTER_KEY`
- fleet mode via `WGS_FLEET_INSTANCES`
- optional control-plane headers
- `/api/v1` fallback to `/api` when needed
- server-only fetches using `cache: 'no-store'`

Rules:

- import the helper only from Server Components, Route Handlers, or Server Actions
- never import it from client components
- never pass `WGS_MASTER_KEY` to the browser

## Security Model

### 1. Gateway secrets stay server-side

Keep these out of browser code:

- `WGS_MASTER_KEY`
- `WGS_CONTROL_PLANE_SECRET`
- `WGS_WEBHOOK_SECRET`

### 2. Protect the internal `web/` app

The built-in control plane is protected by HTTP Basic auth in `web/proxy.ts`.

Required env vars:

- `WGS_ADMIN_UI_USERNAME`
- `WGS_ADMIN_UI_PASSWORD`

If those are missing, the app fails closed.

### 3. Protect the gateway master key path

If the gateway uses:

- `CONTROL_PLANE_SECRET`
- `CONTROL_PLANE_HEADER`
- `CONTROL_PLANE_ALLOWED_IPS`

then the Next.js control plane must send the correct control-plane header for master-key requests.

## Webhook Route Expectations

A client application should expose:

```text
app/api/webhooks/whatsapp/route.ts
```

Minimum requirements:

1. validate the webhook secret
2. return quickly
3. move heavy work into background jobs if necessary
4. make processing idempotent when your product requires replay safety

Typical gateway-side setting:

```env
WEBHOOK_URL=https://your-app.example.com/api/webhooks/whatsapp
WEBHOOK_API_KEY=replace-with-long-random-secret
```

Matching Next.js app env:

```env
WGS_WEBHOOK_SECRET=same-value-as-WEBHOOK_API_KEY-in-the-gateway
```

## Typical Gateway Operations From Next.js

For client applications, common server-side gateway calls include:

- status or stats fetches
- chat and contact lookup
- QR retrieval during onboarding
- outbound messaging actions

For the internal control plane, common server-side operations include:

- instance inventory
- client inventory
- managed client detail
- metadata updates
- bootstrap onboarding

## Fleet Mode Behavior

When `WGS_FLEET_INSTANCES` is set, the internal control-plane app:

1. builds one typed gateway client per instance
2. fetches instance and client inventory server-side
3. surfaces per-instance online or error state on the dashboard
4. routes registration and management actions to the selected instance

If `WGS_FLEET_INSTANCES` is not set, the app falls back to a single instance using:

- `WGS_URL`
- `WGS_MASTER_KEY`

## Registration Flow For A Controlled Operator App

The current recommended pattern for operator onboarding is:

1. render a controlled internal form
2. submit to a server action
3. bootstrap the tenant server-side
4. fetch the QR server-side
5. render the QR in the app

Do not send the built-in registration page to end customers.

It is an admin helper, not a public sign-up workflow.

## Scheduling And Runtime Awareness

Do not assume scheduling is always enabled.

If your Next.js product exposes scheduled-send features, first confirm the gateway runtime supports them.

Recommended check:

1. inspect the gateway runtime or admin surface
2. confirm scheduling is enabled
3. only then show scheduling UI

The same rule applies to multi-instance assumptions: do not build fleet-only UI unless you actually have multiple gateway instances configured.

## Deployment Notes

### Gateway

For most application integrations, deploy the gateway with:

```env
MODULE_PROFILE=standard
```

Move to `full` only when you intentionally need multi-instance leasing and owner forwarding.

### Internal control plane

Deploy `web/` as a separate Next.js app.

It is not part of the gateway Compose stack by default.

Typical targets:

- Vercel
- a separate containerized Next.js deployment
- a separate Node process behind a reverse proxy

### Build validation

For the internal app:

```bash
cd web
npm install
npm run build
```

## Verification Checklist

### For a client application

Verify all of these:

1. the app can call the gateway from server-side code
2. the webhook route accepts valid requests
3. the webhook route rejects invalid secrets
4. QR retrieval works in the onboarding flow
5. outbound message or chat lookup flows work
6. a real inbound WhatsApp event reaches the app

### For the internal control plane

Verify all of these:

1. HTTP Basic auth blocks unauthenticated access
2. the dashboard loads data from the configured instance or fleet
3. the registration flow creates a client and first device
4. the client detail page loads metadata and devices
5. metadata updates persist through the control-plane APIs

## Recommended Final State

### New client application

Gateway:

```env
MODULE_PROFILE=standard
WEBHOOK_URL=https://your-app.example.com/api/webhooks/whatsapp
WEBHOOK_API_KEY=replace-with-long-random-secret
```

App:

```env
WGS_URL=https://your-gateway-domain.example.com
WGS_MASTER_KEY=same-value-as-API_KEY-in-the-gateway
WGS_WEBHOOK_SECRET=same-value-as-WEBHOOK_API_KEY-in-the-gateway
```

### Internal control plane for one gateway

```env
WGS_URL=https://your-gateway-domain.example.com
WGS_MASTER_KEY=same-value-as-API_KEY-in-the-gateway
WGS_CONTROL_PLANE_SECRET=same-value-as-CONTROL_PLANE_SECRET-in-the-gateway
WGS_ADMIN_UI_USERNAME=admin
WGS_ADMIN_UI_PASSWORD=replace-with-long-random-secret
```

### Internal control plane for many gateways

```env
WGS_FLEET_INSTANCES=[{"id":"eu-1","label":"EU Cluster","baseUrl":"https://wa-eu.example.com","apiKey":"replace-with-master-key","apiBasePath":"/api/v1","controlPlaneSecret":"replace-with-control-plane-secret"}]
WGS_ADMIN_UI_USERNAME=admin
WGS_ADMIN_UI_PASSWORD=replace-with-long-random-secret
```

## Related Documents

- `PRODUCTION_DEPLOYMENT_GUIDE.md`
- `NEW_APPLICATION_DEPLOYMENT_GUIDE.md`
- `CLIENT_CODEBASE_MIGRATION.md`
- `.env.example`
- `web/.env.example`
