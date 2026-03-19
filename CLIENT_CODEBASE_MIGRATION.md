# Client Codebase Migration Guide

This guide is for an existing Next.js client application that already integrates with the WhatsApp Gateway Service and needs to align with the current gateway contract.

## What Changed

The current gateway changed in five ways that matter to an existing client app:

1. the recommended gateway runtime for normal deployments is now `MODULE_PROFILE=standard`
2. the preferred webhook route is `/api/webhooks/whatsapp`
3. the server-side client env name should be `WGS_MASTER_KEY`, not `WGS_API_KEY`
4. gateway responses use the standard `success` / `data` / `error` envelope
5. scheduling should be treated as optional runtime capability, not always-on behavior

## Migration Summary

| Area | Old expectation | Current expectation |
|---|---|---|
| Gateway mode | Implicit all-in-one runtime | Explicit `MODULE_PROFILE=standard` for most client installs |
| Webhook target | Client app route path could vary | Use one stable route such as `/api/webhooks/whatsapp` |
| Client env naming | Mixed `WGS_API_KEY` / `WGS_MASTER_KEY` conventions | Standardize on `WGS_MASTER_KEY` for server-side gateway access |
| Response envelope | Mixed `ok` or flat payload handling | Parse `success`, `data`, and `error` consistently |
| Scheduling | Not always available | Only available when the gateway scheduling module is enabled |

## 1. Normalize Client Environment Variables

Move the client codebase to this naming scheme:

```env
WGS_URL=https://your-gateway-domain.example.com
WGS_MASTER_KEY=same-value-as-API_KEY-in-WGS
WGS_WEBHOOK_SECRET=same-value-as-WEBHOOK_API_KEY-in-WGS
```

If older code still uses `WGS_API_KEY`, replace it with `WGS_MASTER_KEY` in server-only gateway helper code.

## 2. Normalize The Webhook Route

Use one route in the client codebase:

```text
app/api/webhooks/whatsapp/route.ts
```

Then set the gateway to point at:

```env
WEBHOOK_URL=https://your-client.vercel.app/api/webhooks/whatsapp
```

For the current Amuta client rollout:

```env
WEBHOOK_URL=https://whatsapp-amuta.vercel.app/api/webhooks/whatsapp
```

## 3. Keep Gateway Calls Server-Only

Any existing client-side fetches that hit the gateway directly should be moved behind server routes, server actions, or server components.

Use [web/lib/wgs.ts](c:/dev/didi-tech/whatsapp-service/web/lib/wgs.ts) as the current reference shape.

The browser should never receive:

- `WGS_MASTER_KEY`
- the raw gateway admin key
- direct privileged gateway URLs used by operator workflows

## 4. Update Response Handling To The Current Gateway Format

Current gateway responses use this envelope:

```json
{
  "success": true,
  "timestamp": 1770000000000,
  "data": {}
}
```

Or on failure:

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

If the client codebase still expects `{ ok: true }` or a flatter payload, update those integration helpers first.

## 5. Treat Scheduling As Optional

Do not assume scheduling routes always exist.

If the client product uses scheduled sends, verify the gateway is running with scheduling enabled before surfacing that UI.

Recommended check:

1. call `/api/admin/runtime` from server code or inspect the gateway admin dashboard
2. inspect `modules.scheduling`
3. show or hide scheduling UI accordingly

## 6. Admin UX Expectations

The gateway dashboard itself now uses admin credentials and server-side session cookies.

That mostly affects operators using the gateway dashboard directly. The client codebase should still use server-side API calls with `WGS_MASTER_KEY` where appropriate.

## 7. Migration Checklist

1. Update env vars to `WGS_URL`, `WGS_MASTER_KEY`, and `WGS_WEBHOOK_SECRET`.
2. Ensure the client webhook route is `/api/webhooks/whatsapp`, or update `WEBHOOK_URL` to the real path.
3. Move any browser-side privileged gateway fetches into server-only code.
4. Update gateway helper code to parse `success` / `data` / `error` envelopes.
5. Verify status fetch, QR fetch, chat listing, and outbound send flows.
6. If scheduling is used, verify the runtime exposes it before enabling UI.

## 8. Smoke Tests

After migration, validate these flows in the client codebase:

1. server-side status or stats fetch succeeds
2. webhook route returns `200` for a valid signed POST
3. webhook route returns `401` for an invalid secret
4. QR retrieval works in the admin/operator setup flow
5. outbound send succeeds from the client app workflow
6. a real inbound WhatsApp event reaches the client app

## 9. Recommended Final State

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