# Control Plane Automation Guide

This guide defines the boundary between:

- the WhatsApp gateway instance
- your external control-plane service
- the infrastructure layer that creates new cloud instances

## What The Gateway Can Do

Once an instance is already deployed and reachable on its domain, the gateway can be fully controlled over API for:

- tenant creation
- tenant key issuance and rotation
- per-client configuration
- device creation and removal
- QR pairing lifecycle
- device status inspection
- message, chat, contact, group, and access-control operations
- admin dashboard access on the deployed instance

## What The Gateway Cannot Do By Itself

The gateway does **not** provision cloud infrastructure by itself.

It cannot on its own:

- buy or create a domain
- create DNS records
- create a VM, container app, or Kubernetes workload
- create attached storage or Redis
- install Docker and Caddy on a fresh machine
- write environment variables into a new deployment target

If you want one API call to create a whole new service instance for a customer domain, you need an external orchestrator.

## Recommended Architecture

Use a three-layer model.

### 1. Control Plane

This is the external service you will build.

Responsibilities:

- approve or reject new customers
- generate and store instance-level secrets
- create infrastructure via your cloud provider API
- configure DNS and the target domain
- wait for the instance to become healthy
- call the gateway master APIs for tenant bootstrap
- expose your own internal admin dashboard for cross-instance operations

This is the only service that should know:

- instance `API_KEY`
- instance `KEY_SECRET`
- optional `CONTROL_PLANE_SECRET`
- deployment credentials for your cloud vendor

### 2. Gateway Instance

Each deployed gateway instance serves one domain and exposes:

- `/api/v1/*`
- `/admin`
- optional admin session APIs

Its job is runtime device and tenant management, not infrastructure creation.

### 3. Infrastructure Provider

This can be Hetzner, Render, Azure, Vercel plus a backend service, Kubernetes, or any other platform.

This layer is responsible for:

- creating compute
- mounting persistent storage
- providing Redis
- pointing the domain to the deployment
- restarting and healing the stack

## Hardening Master-Key Access

The gateway now supports an optional second factor for master-key requests.

Gateway env vars:

```env
CONTROL_PLANE_SECRET=long-random-secret
CONTROL_PLANE_HEADER=x-control-plane-key
CONTROL_PLANE_ALLOWED_IPS=203.0.113.10,198.51.100.20
```

Behavior:

- client-key requests are unaffected
- admin-session dashboard login is unaffected
- any request using `API_KEY` is allowed only if it matches the configured control-plane policy
- if `CONTROL_PLANE_SECRET` is set, the caller must send that header
- if `CONTROL_PLANE_ALLOWED_IPS` is set, the caller IP must also be allowlisted

External control-plane request example:

```http
POST /api/v1/control-plane/clients/acme/bootstrap
x-api-key: <instance-master-key>
x-control-plane-key: <control-plane-secret>
Content-Type: application/json
```

Recommended machine-only routes:

- `GET /api/v1/control-plane/instance`
- `GET /api/v1/control-plane/clients`
- `GET /api/v1/control-plane/clients/:clientId`
- `PUT /api/v1/control-plane/clients/:clientId/metadata`
- `POST /api/v1/control-plane/clients/:clientId/bootstrap`
- `GET /api/v1/control-plane/clients/:clientId/devices/:deviceId/onboarding`
- `POST /api/v1/control-plane/clients/:clientId/devices/:deviceId/reissue-qr`
- `DELETE /api/v1/control-plane/clients/:clientId`

These routes are the minimum base you need to manage 20 separate customer instances from one external control plane.

Per instance, your control plane can now inventory:

- running gateway version
- instance profile
- total clients and devices
- auth storage usage
- per-client plan metadata
- per-client contact metadata
- per-client send limits
- current quota usage in the active rate-limit window
- device ownership and status
- allowlist and banlist state

## Can You Stop Doing Manual DevOps?

Yes, but only after you build the control plane.

The operational model should be:

1. Your control plane receives an approved registration request.
2. It calls your cloud provider API to create a new gateway deployment.
3. It injects a unique domain and unique secrets for that instance.
4. It waits for `/api/v1/status/ready` to succeed.
5. It performs bootstrap API calls against that instance.
6. From that point on, you manage the instance through API calls and the admin dashboard.

That means you can leave day-to-day server setup behind, but only because your own orchestration service is doing that work programmatically.

## Example Instance Provisioning Flow

For each new customer domain, your control plane should do this:

1. Generate secrets:
   - `API_KEY`
   - `KEY_SECRET`
   - `REDIS_PASSWORD`
   - `WEBHOOK_API_KEY` if needed
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
   - `CONTROL_PLANE_SECRET`
2. Create DNS for the target domain.
3. Provision compute and Redis.
4. Upload or template the instance `.env`.
5. Deploy the stack with `docker compose` and the `standard` profile.
6. Health-check `https://<domain>/api/v1/status/ready`.
7. Call bootstrap APIs using `API_KEY` plus the control-plane header.
8. Persist the instance metadata in your control-plane database.

## What The Admin Dashboard Can Control

Per deployed instance, the admin dashboard can control runtime operations such as:

- device visibility
- queue visibility
- tenant visibility
- admin-session protected stats

What it should not be responsible for:

- creating new cloud servers
- changing DNS
- rotating infrastructure credentials
- cross-instance fleet orchestration

Those belong in your control plane.

## Recommended End State

Your finished system should look like this:

1. Customers never touch the gateway directly for registration.
2. Your external service is the only master-key caller.
3. Every gateway instance has a unique domain and unique secrets.
4. Your control plane provisions instances automatically.
5. Your admin dashboard manages runtime state after deployment.

That architecture matches your requirement: you retain full control of registration and can operate the fleet through API calls instead of manual server work.