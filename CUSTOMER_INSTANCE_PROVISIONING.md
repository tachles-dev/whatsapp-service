# Customer Instance Provisioning

This document is the stable operating model for giving each customer a dedicated WhatsApp gateway environment on one server.

## Why The Current Single-Instance Stack Is Not Enough

The root `docker-compose.yml` is designed for one public gateway deployment.

That model is not suitable for many dedicated customer environments on one server because every full stack includes:

- one Caddy container binding `80` and `443`
- one app container
- one Redis container

You cannot run many customer stacks on one host if every stack tries to own `80` and `443`.

## Stable Single-Server Pattern

Use this pattern instead:

1. one shared edge Caddy on the host
2. one dedicated app plus Redis stack per customer
3. one loopback-bound host port per customer instance
4. one customer domain or subdomain per customer
5. one Caddy snippet per customer domain pointing to that loopback port

Example:

- `acme.whatsapp.example.com` -> `127.0.0.1:3101`
- `globex.whatsapp.example.com` -> `127.0.0.1:3102`

This keeps TLS and public ingress centralized while preserving per-customer runtime isolation.

## What Changed Compared To The Previous Structure

Before:

- one root stack expected to own the public domain
- one embedded Caddy per deployment
- one runtime mainly optimized for a single public gateway deployment
- no built-in per-customer instance scaffold on a shared server

Now:

- one shared edge Caddy handles public ingress for all customer domains
- one dedicated app plus Redis stack runs per customer
- each customer stack binds only to `127.0.0.1:<port>` on the host
- each customer gets unique secrets, storage, and runtime state
- the repository contains a provisioning script, lifecycle controls, async job records, and a server-local management surface

That is the architectural change that makes dedicated environments practical on one server.

## Security And Stability Assessment

This structure still holds the security model if you keep the boundaries intact.

Security properties improved:

- per-customer isolation is stronger than the old single shared runtime model
- every customer gets a unique `API_KEY`, `KEY_SECRET`, `CONTROL_PLANE_SECRET`, and Redis password
- public ingress is reduced to one shared edge proxy instead of many public stacks
- the new server management UI can be bound to `127.0.0.1` only and guarded separately from the public fleet UI

Operational stability improved:

- no port collisions on `80` and `443`
- one customer stack can fail without taking down the shared edge Caddy
- readiness checks happen before bootstrap completes
- instance files and generated routes are explicit and recoverable on disk

Remaining operational constraints:

- each customer still consumes memory, CPU, disk, and one loopback port
- Redis is isolated per stack, so total resource usage scales with customer count
- provisioning retries and cleanup policy still need to be managed by your product backend or job runner

## Do Customer-Specific Domains Overload The Server?

No, not by themselves.

The domain count is not the main load factor. The actual load factors are:

- number of running app containers
- number of Redis containers
- number of connected WhatsApp sessions
- webhook throughput
- auth storage growth

Routing overhead for many domains is small compared to the runtime cost of many customer stacks.

On the server side, the routing model is now correct:

1. Caddy terminates TLS once
2. Caddy routes by hostname
3. each hostname proxies to one loopback port
4. that loopback port maps to exactly one customer app container

That is the right pattern for many domains on one host.

## What The Provisioning Script Adds

The repository now includes:

- `deploy/docker-compose.instance.yml`
- `deploy/caddy.customer-instance.template`
- `deploy/Caddyfile.edge.example`
- `scripts/provision-instance.sh`
- `scripts/manage-instance.sh`
- `scripts/run-provision-job.mjs`

That gives you a repeatable server-side scaffold for a dedicated customer environment.

## Provisioning Flow

When a new customer is approved in your product:

1. assign a customer slug
2. assign a customer domain or subdomain
3. assign a unique loopback host port
4. enqueue a provisioning job or run `scripts/provision-instance.sh`
5. create DNS for the customer domain
6. load the generated Caddy snippet into your shared edge Caddy
7. start the customer stack
8. verify health on the loopback port
9. call the gateway control-plane bootstrap API
10. mark the customer environment active in your product database

## Example Command

```bash
bash scripts/provision-instance.sh \
  --slug acme \
  --domain acme.whatsapp.example.com \
  --app-port 3101 \
  --webhook-url https://product.example.com/api/webhooks/whatsapp \
    --webhook-api-key your-shared-secret \
  --bootstrap-client-id acme \
  --bootstrap-device-name "Primary Device" \
  --install-edge-snippet \
  --start
```

This creates:

- `/opt/wgs-instances/acme/.env`
- `/opt/wgs-instances/acme/instance.json`
- `/opt/wgs-instances/acme/edge-route.caddy`
- `/opt/wgs-instances/acme/bootstrap-response.json` when bootstrap succeeds

If `--install-edge-snippet` is used, the same route snippet is copied into your host-level Caddy import directory.

If `WGS_DNS_HOOK_COMMAND` is configured, the provisioner also invokes that command with these environment variables:

- `WGS_DNS_ACTION=provision`
- `WGS_INSTANCE_SLUG`
- `WGS_INSTANCE_DOMAIN`
- `WGS_INSTANCE_APP_PORT`
- `WGS_INSTANCE_DIR`

If you pass `--webhook-api-key`, that exact value is written into the customer instance `.env` as `WEBHOOK_API_KEY`.
That is the recommended production pattern when your product backend must validate incoming webhook calls with a secret it already knows.

## What Gets Generated Per Customer

Each customer gets unique values for:

- `API_KEY`
- `KEY_SECRET`
- `REDIS_PASSWORD`
- `WEBHOOK_API_KEY`
- `ADMIN_PASSWORD`
- `CONTROL_PLANE_SECRET`

If you do not provide `--webhook-api-key`, the provisioner generates a unique webhook secret automatically.

That means each environment is independently controlled and can be suspended or rotated without affecting the rest of the fleet.

## Compose Model

The per-customer compose override does three important things:

1. disables the embedded `caddy` service
2. disables `redisinsight`
3. binds the app container to `127.0.0.1:<customer-port>`

This lets one shared edge Caddy terminate TLS and reverse-proxy to many customer stacks without port collisions.

## Shared Edge Caddy Model

Your host-level Caddy should import customer route snippets from a dedicated directory.

Example host-level import:

```caddyfile
import /etc/caddy/customer-instances/*.caddy
```

The repository also includes a host-level example file:

- `deploy/Caddyfile.edge.example`

Each generated snippet looks like this:

```caddyfile
acme.whatsapp.example.com {
  reverse_proxy 127.0.0.1:3101
}
```

The generated template in this repository adds health checks and basic security headers.

## Server-Only Management Page

The internal `web/` app can now expose a dedicated server management page at `/server`.

In development, that page should run in simulation mode.

Use:

```env
WGS_SERVER_MANAGEMENT_MODE=dev
```

In that mode, the page does not try to run Docker or host scripts. It records mock instances and mock jobs under a local development directory so you can build and test the operator workflow safely.

Only use this on the real host:

```env
WGS_SERVER_MANAGEMENT_MODE=live
```

That page can:

- queue asynchronous provisioning jobs
- display recent job status and log tails
- list local customer instances
- start, stop, restart, and delete local customer instances

Recommended deployment mode:

```bash
cd web
npm run build
npm run start:local
```

That binds the management app to `127.0.0.1:3300` only.

Recommended access pattern:

- SSH into the server and browse locally
- or use an SSH tunnel from your workstation to `127.0.0.1:3300`

Defense in depth:

- HTTP Basic auth still applies
- `/server` is blocked unless the request host is localhost when `WGS_SERVER_UI_LOCAL_ONLY` is enabled

This should not be treated as the only safeguard. The primary safeguard is binding the app to localhost.

## Lifecycle Controls

The repository now includes `scripts/manage-instance.sh` for instance lifecycle operations.

Supported actions:

- `start`
- `stop`
- `restart`
- `delete`

Example:

```bash
bash scripts/manage-instance.sh --slug acme --action restart --instance-root /opt/wgs-instances
```

Delete removes the Docker project, removes volumes, optionally removes the edge route snippet, optionally invokes the DNS hook with `WGS_DNS_ACTION=delete`, and removes the instance directory.

## Async Job Records

The server-local control plane now records asynchronous provisioning jobs under `WGS_JOB_ROOT`.

Each job stores:

- input payload
- status
- timestamps
- log file path
- error state when provisioning fails

That gives you a durable operator trail instead of running long provisioning actions inline in the browser request.

## Provisioning State Model

Your product backend should keep explicit states for each customer environment.

Recommended states:

- `queued`
- `provisioning`
- `dns_pending`
- `starting`
- `healthy`
- `bootstrapping`
- `awaiting_qr`
- `active`
- `failed`
- `suspended`
- `offboarding`

Do not hide this state machine. It is what makes provisioning stable and recoverable.

## What This Script Does Not Replace

This script and UI are a provisioning scaffold, not the full control plane.

They do not:

- create billing records
- decide customer approval
- replace a real application job queue or orchestration layer
- replace your product backend as the source of truth for customer lifecycle

DNS can now be integrated through `WGS_DNS_HOOK_COMMAND`, but the actual provider implementation still belongs to your infrastructure layer.

Those concerns belong in your product backend or your dedicated control-plane service.

## Stable End State

For each new customer:

1. signup happens in your product
2. your backend creates a provisioning job
3. the provisioning worker runs `scripts/provision-instance.sh`
4. the worker verifies `http://127.0.0.1:<port>/api/status/live` and `/api/status/ready`
5. the worker bootstraps the customer through `/api/v1/control-plane/*`
6. the worker marks the customer ready

That is the stable model for a dedicated-environment product on one server.