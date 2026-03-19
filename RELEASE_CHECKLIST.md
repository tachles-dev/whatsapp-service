# Release Checklist

## Package And Contract

- Run `npm run build`
- Run `npm test`
- Confirm `/api/v1/reference` returns the current contract
- Confirm `/api/v1/openapi.json` returns the current OpenAPI document
- Confirm the package root still exports the SDK and `./server` still exports the runtime entrypoint

## Runtime Configuration

- Set `API_KEY` to a strong operator secret
- Set `KEY_SECRET` to a different strong secret
- Set `REDIS_URL` for the target environment
- Set `AUTH_BASE_DIR` to persistent storage
- Set `MODULE_PROFILE` intentionally: `lite`, `standard`, or `full`
- If webhooks are enabled, set `WEBHOOK_URL` and `WEBHOOK_API_KEY`
- If admin is enabled, set `ADMIN_USERNAME` and `ADMIN_PASSWORD`
- If owner forwarding is enabled, set `INSTANCE_BASE_URL`

## Deployment Verification

- Check `GET /api/v1/status`
- Check `GET /api/v1/status/ready`
- Check `GET /api/v1`
- Check `GET /api/v1/reference`
- Check `GET /api/v1/openapi.json`
- If admin is enabled, check `/admin` and `GET /api/v1/admin/runtime`

## Functional Smoke Tests

- Create a client key
- Create a device
- Fetch a QR code
- Pair a real WhatsApp account
- Confirm the device reaches `CONNECTED`
- Send a text message through `/api/v1/clients/:clientId/devices/:deviceId/messages/send-text`
- Receive at least one webhook event in the configured consumer
- Verify webhook signature validation on the consumer side
- If scheduling is enabled, create, fetch, reschedule, and cancel a scheduled message

## Consumer Readiness

- Point new consumers to `/api/v1`, not `/api`
- Publish or share the SDK usage example
- Publish or share the OpenAPI document
- Confirm any internal UI uses `WGS_MASTER_KEY` naming, not older aliases

## Multi-Instance Only

- Verify instance registration and lease renewal
- Verify device requests forward to the owning instance
- Simulate one instance becoming unavailable and confirm failure behavior is acceptable

## Final Go/No-Go

Ship only if:

- build is green
- tests are green
- readiness endpoint is healthy
- a real device can connect
- a real webhook consumer receives valid events
- secrets and persistent storage are configured for the target environment
