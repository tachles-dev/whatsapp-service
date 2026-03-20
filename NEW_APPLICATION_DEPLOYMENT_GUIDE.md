# New Application Deployment Guide

This guide is for deploying a new client application that consumes the WhatsApp Gateway Service.

Use this when you are launching a brand-new application, not migrating an existing one.

It complements:

- `PRODUCTION_DEPLOYMENT_GUIDE.md` for gateway and control-plane rollout
- `NEXTJS_INTEGRATION.md` for implementation details inside a Next.js app
- `CLIENT_CODEBASE_MIGRATION.md` for existing client codebases

## Deployment Model

The application and the gateway are separate systems.

### The gateway is responsible for

- device connectivity
- tenant management
- outbound messaging APIs
- inbound webhook delivery
- QR pairing lifecycle

### The client application is responsible for

- business logic
- application auth
- operator workflows
- receiving and validating webhook events
- calling the gateway only from server-side code

## Recommended Greenfield Stack

For a new application rollout, use this split.

### Gateway

Deploy the gateway in `standard` first.

### Client app

Deploy the client app separately, ideally as a Next.js application with:

- server actions
- route handlers
- server-rendered operator pages

### Internal control plane

Deploy the internal `web/` control app separately for operator and fleet workflows.

## 1. Prepare The Gateway For The New App

In the gateway `.env`, point `WEBHOOK_URL` to the new application's webhook route.

Example:

```env
WEBHOOK_URL=https://your-app.example.com/api/webhooks/whatsapp
WEBHOOK_API_KEY=replace-with-long-random-secret
MODULE_PROFILE=standard
```

If the application is a controlled internal rollout, also set:

```env
CONTROL_PLANE_SECRET=replace-with-long-random-secret
CONTROL_PLANE_HEADER=x-control-plane-key
```

## 2. Set The New Application Environment

Minimum app-side environment:

```env
WGS_URL=https://your-gateway-domain.example.com
WGS_MASTER_KEY=same-value-as-API_KEY-in-the-gateway
WGS_WEBHOOK_SECRET=same-value-as-WEBHOOK_API_KEY-in-the-gateway
```

Rules:

- keep `WGS_MASTER_KEY` server-only
- never expose it to browser components
- keep webhook secret verification in the app's webhook route

## 3. Add The Required Application Routes

At minimum, the application should expose:

```text
app/api/webhooks/whatsapp/route.ts
```

And keep privileged gateway calls in server-only code, for example:

```text
lib/wgs.ts
app/api/whatsapp/status/route.ts
app/api/whatsapp/chats/route.ts
app/api/whatsapp/send/route.ts
```

## 4. Deployment Steps For A New App

### Step 1 — Configure gateway webhook target

Point the gateway at the real application route:

```env
WEBHOOK_URL=https://your-app.example.com/api/webhooks/whatsapp
```

### Step 2 — Deploy the application

For a Next.js app:

```bash
npm install
npm run build
```

Then deploy to your chosen hosting target.

### Step 3 — Create the first client and device

Use the internal control plane or the machine-only control-plane API to:

1. create the tenant
2. issue the first API key
3. create the first device
4. fetch and scan the QR

### Step 4 — Validate end-to-end flow

Confirm:

1. the app can receive webhook events
2. invalid webhook signatures are rejected
3. the app can make server-only gateway calls successfully
4. at least one inbound and one outbound message path works

## 5. Recommended Production Shape For A New App

### Gateway

```env
MODULE_PROFILE=standard
WEBHOOK_URL=https://your-app.example.com/api/webhooks/whatsapp
WEBHOOK_API_KEY=replace-with-long-random-secret
```

### App

```env
WGS_URL=https://your-gateway-domain.example.com
WGS_MASTER_KEY=same-value-as-API_KEY-in-the-gateway
WGS_WEBHOOK_SECRET=same-value-as-WEBHOOK_API_KEY-in-the-gateway
```

### Internal web control plane

```env
WGS_URL=https://your-gateway-domain.example.com
WGS_MASTER_KEY=same-value-as-API_KEY-in-the-gateway
WGS_CONTROL_PLANE_SECRET=same-value-as-CONTROL_PLANE_SECRET-in-the-gateway
WGS_ADMIN_UI_USERNAME=admin
WGS_ADMIN_UI_PASSWORD=replace-with-long-random-secret
```

## 6. When To Use Fleet Mode For The App

Use a fleet-aware deployment only when:

- the application needs to talk to multiple gateway instances
- you are routing customers to separate gateway domains
- you want the internal control plane to manage multiple instances centrally

Then set `WGS_FLEET_INSTANCES` in the control-plane app rather than using a single `WGS_URL`.

## 7. Go-Live Checklist For The New App

Before launch, verify:

- the gateway is healthy
- the app's webhook route is reachable from the gateway
- valid webhook signatures are accepted
- invalid webhook signatures are rejected
- the app can query status from server-side code
- the app can trigger at least one real outbound send
- the first paired device remains connected after restart

If those are green, the new application deployment is ready for controlled production use.