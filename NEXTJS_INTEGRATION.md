# WhatsApp Gateway Service — Next.js Integration Guide

This is the canonical integration guide for a Next.js client application that consumes the WhatsApp Gateway Service.

The current sample implementation in this repository lives in:

- `web/lib/wgs.ts`
- `web/app/register/actions.ts`
- `web/app/page.tsx`
- `web/app/register/page.tsx`

## Integration Model

The client application should treat the gateway as a server-to-server dependency.

The Next.js app is responsible for:

1. calling the gateway from server-only code
2. exposing its own internal API routes or server actions to browser clients
3. receiving webhook events from the gateway
4. keeping gateway secrets out of the browser bundle

## Setup Scope

This guide covers both:

1. greenfield setup for a new client codebase
2. migration of an existing client codebase that already talks to the gateway

## Environment Variables

Add these to the Next.js app environment, typically `.env.local` for local work and Vercel project env vars in production:

```env
WGS_URL=https://your-gateway-domain.example.com
WGS_MASTER_KEY=same-value-as-API_KEY-in-WGS
WGS_WEBHOOK_SECRET=same-value-as-WEBHOOK_API_KEY-in-WGS
```

Gateway-side counterpart:

```env
WEBHOOK_URL=https://your-client.vercel.app/api/webhooks/whatsapp
```

For the current Amuta deployment target:

```env
WEBHOOK_URL=https://whatsapp-amuta.vercel.app/api/webhooks/whatsapp
```

## Expected Responsibilities In The Client App

The client codebase should do three things:

1. receive webhook events from the gateway
2. call the gateway from server-only code when it needs status, device, chat, or message actions
3. keep all gateway secrets out of the browser bundle

## Migration Summary

| Area | Old expectation | Current expectation |
|---|---|---|
| Gateway mode | Implicit all-in-one runtime | Explicit `MODULE_PROFILE=standard` for most client installs |
| Webhook target | Client app route path could vary | Use one stable route such as `/api/webhooks/whatsapp` |
| Client env naming | Mixed `WGS_API_KEY` / `WGS_MASTER_KEY` conventions | Standardize on `WGS_MASTER_KEY` for server-side gateway access |
| Response envelope | Mixed `ok` or flat payload handling | Parse `success`, `data`, and `error` consistently |
| Scheduling | Not always available | Only available when the gateway scheduling module is enabled |

## Gateway Response Contract

The gateway returns JSON in this envelope:

```json
{
  "success": true,
  "timestamp": 1770000000000,
  "data": {}
}
```

On failure:

```json
{
  "success": false,
  "timestamp": 1770000000000,
  "error": {
    "code": "SOME_CODE",
    "message": "Human-readable message"
  }
}
```

Your Next.js helper should parse `success`, `data`, and `error.message`.

## Server-Only Gateway Helper

Put the gateway integration behind a server-only helper such as `lib/wgs.ts`.

```ts
import 'server-only';

const BASE = process.env.WGS_URL!;
const KEY = process.env.WGS_MASTER_KEY!;

interface GatewayResponse<T> {
  success: boolean;
  timestamp: number;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-api-key': KEY },
    cache: 'no-store',
  });

  const json: GatewayResponse<T> = await res.json();
  if (!json.success) {
    throw new Error(json.error?.message ?? `WGS error on GET ${path}`);
  }

  return json.data as T;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'x-api-key': KEY,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  const json: GatewayResponse<T> = await res.json();
  if (!json.success) {
    throw new Error(json.error?.message ?? `WGS error on POST ${path}`);
  }

  return json.data as T;
}
```

Rules:

- import this helper only from Server Components, Route Handlers, or Server Actions
- never expose `WGS_MASTER_KEY` to client components
- prefer `cache: 'no-store'` for operator/admin data
- if you want a cached dashboard, apply caching at the Next.js route or page level, not in the browser

If older code still uses `WGS_API_KEY`, replace it with `WGS_MASTER_KEY` in server-only gateway helper code.

## Common Next.js Patterns

### 1. Server-rendered admin dashboard

The sample app uses a Server Component dashboard in `web/app/page.tsx` that calls the gateway on the server and renders device and queue stats.

This is the right pattern for:

- operator dashboards
- internal admin views
- device health screens
- queue visibility

### 2. Server Action onboarding flow

The sample registration flow in `web/app/register/actions.ts` performs:

1. client key creation
2. first device creation
3. QR retrieval
4. QR conversion to an image data URL for rendering

This is the preferred pattern for onboarding an operator without leaking the gateway master key.

### 3. Route handlers as an internal boundary

When browser clients need WhatsApp-related data, expose it from your own Next.js route handlers instead of calling the gateway directly from the browser.

Good examples:

- `app/api/whatsapp/status/route.ts`
- `app/api/whatsapp/chats/route.ts`
- `app/api/whatsapp/qr/route.ts`
- app-specific send or reply routes

## Registration Flow

If the client app includes an operator onboarding flow, follow the pattern in `web/app/register/actions.ts`:

1. create a client key
2. create the first device
3. fetch the QR code
4. render the QR as an image for pairing

This keeps the gateway master key on the server and gives the client application a controlled onboarding path.

## Webhook Route

The client app should expose:

```text
app/api/webhooks/whatsapp/route.ts
```

Minimal implementation:

```ts
import { NextResponse } from 'next/server';

const WGS_WEBHOOK_SECRET = process.env.WGS_WEBHOOK_SECRET!;

export async function POST(request: Request) {
  const apiKey = request.headers.get('x-api-key');
  if (apiKey !== WGS_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();

  if (body.type === 'heartbeat') {
    return NextResponse.json({ ok: true });
  }

  // Process inbound WhatsApp events here.
  return NextResponse.json({ ok: true });
}
```

Requirements:

- validate the `x-api-key` header
- return quickly with `200`
- move heavy downstream work into background jobs if needed
- make the handler idempotent if the client product requires replay safety

For the current client rollout, the intended webhook target is:

```env
WEBHOOK_URL=https://whatsapp-amuta.vercel.app/api/webhooks/whatsapp
```

## Typical Gateway Calls From Next.js

Examples you are likely to need:

- `GET /api/status` for public health and readiness summaries
- `GET /api/admin/stats` for operator dashboards
- `POST /api/clients/:clientId/key` to issue a client API key
- `POST /api/clients/:clientId/devices` to create a device
- `GET /api/clients/:clientId/devices/:deviceId/auth/qr` to fetch the pairing QR
- `GET /api/clients/:clientId/devices/:deviceId/chats` for searchable contacts and chats

Use the master key only from trusted server-side code.

If your product needs tenant-scoped device operations after onboarding, you can also issue a tenant client key and use that for restricted server-to-server requests.

## Migration Steps For Existing Client Apps

1. Update environment variables to `WGS_URL`, `WGS_MASTER_KEY`, and `WGS_WEBHOOK_SECRET`.
2. Normalize the client webhook route to `/api/webhooks/whatsapp`, or point `WEBHOOK_URL` at the real route.
3. Move any privileged browser-side gateway calls into server-only code.
4. Update gateway helpers to parse the `success` response envelope instead of legacy `ok` handling.
5. Treat scheduling as optional and only surface scheduling UI when the gateway runtime exposes it.
6. Re-test status fetch, chat listing, QR retrieval, and outbound send flows.

## Optional Features And Runtime Awareness

Do not assume scheduling routes always exist.

If the client product uses scheduled sends, verify the gateway is running with scheduling enabled before surfacing those UI features.

Recommended check:

1. call `/api/admin/runtime` from server code or inspect the gateway admin dashboard
2. inspect `modules.scheduling`
3. show or hide scheduling UI accordingly

The gateway dashboard itself now uses admin credentials and server-side session cookies. That mostly affects operators using the gateway dashboard directly. The client codebase should still use server-side API calls with `WGS_MASTER_KEY` where appropriate.

## Security Requirements

- keep `WGS_MASTER_KEY` server-only
- keep `WGS_WEBHOOK_SECRET` server-only
- do not fetch privileged gateway endpoints from client-side React components
- protect your own Next.js routes with your application auth layer
- validate all inbound webhook requests before processing them

## Deployment Notes

Recommended gateway mode for most client apps:

```env
MODULE_PROFILE=standard
```

That is the intended single-node profile.

Do not set `INSTANCE_BASE_URL` unless you are intentionally deploying a multi-instance gateway topology with owner forwarding enabled.

## Verification Checklist

After wiring the integration:

1. confirm the Next.js app can call `GET /api/admin/stats` from server code
2. confirm the registration flow can create a client key and first device
3. confirm QR retrieval works
4. confirm the webhook route accepts a valid signed POST
5. confirm a real inbound WhatsApp event reaches the client app
6. confirm outbound send or chat lookup flows work from the client app

For an existing client migration, also validate:

1. webhook route returns `401` for an invalid secret
2. no browser component calls privileged gateway endpoints directly
3. any scheduling UI is hidden when the runtime module is disabled

## Recommended Final State

For a normal single-node client integration, the intended setup is:

Gateway:

```env
MODULE_PROFILE=standard
WEBHOOK_URL=https://whatsapp-amuta.vercel.app/api/webhooks/whatsapp
```

Client app:

```env
WGS_URL=https://your-gateway-domain.example.com
WGS_MASTER_KEY=same-value-as-API_KEY-in-WGS
WGS_WEBHOOK_SECRET=same-value-as-WEBHOOK_API_KEY-in-WGS
```

Leave `INSTANCE_BASE_URL` unset unless you are deliberately moving the gateway to a multi-instance topology.

## Related Documents

- `.env.example`
