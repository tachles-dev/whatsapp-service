import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../src/routes';
import { resetConfigForTests } from '../src/config';
import { deviceManager } from '../src/core/device-manager';
import { closeRedis } from '../src/redis';
import { stopWebhookWorker } from '../src/queue';
import { stopScheduledMessageWorker } from '../src/queue/scheduled';
import { consumeSendQuota } from '../src/send-throttle';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigForTests();
}

test.afterEach(async () => {
  await deviceManager.shutdownAll();
  await stopWebhookWorker();
  await stopScheduledMessageWorker();
  await closeRedis();
  restoreEnv();
});

test('control-plane bootstrap requires the configured control-plane header for master-key access', async () => {
  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MODULE_PROFILE = 'standard';
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';
  process.env.CONTROL_PLANE_SECRET = 'z'.repeat(32);

  const app = Fastify();
  await registerRoutes(app);

  const denied = await app.inject({
    method: 'POST',
    url: '/api/v1/control-plane/clients/acme/bootstrap',
    headers: { 'x-api-key': process.env.API_KEY },
    payload: { deviceName: 'Primary' },
  });

  assert.equal(denied.statusCode, 403);

  const allowed = await app.inject({
    method: 'POST',
    url: '/api/v1/control-plane/clients/acme/bootstrap',
    headers: {
      'x-api-key': process.env.API_KEY,
      'x-control-plane-key': process.env.CONTROL_PLANE_SECRET,
    },
    payload: { deviceName: 'Primary' },
  });

  assert.equal(allowed.statusCode, 201);
  const body = allowed.json();
  assert.equal(body.success, true);
  assert.equal(body.data.clientId, 'acme');
  assert.equal(typeof body.data.key.key, 'string');
  assert.equal(body.data.device.name, 'Primary');
  assert.match(body.data.onboardingPath, /\/api\/v1\/control-plane\/clients\/acme\/devices\//);

  const onboarding = await app.inject({
    method: 'GET',
    url: body.data.onboardingPath,
    headers: {
      'x-api-key': process.env.API_KEY,
      'x-control-plane-key': process.env.CONTROL_PLANE_SECRET,
    },
  });

  assert.equal(onboarding.statusCode, 200);
  const onboardingBody = onboarding.json();
  assert.equal(onboardingBody.success, true);
  assert.equal(onboardingBody.data.clientId, 'acme');
  assert.equal(onboardingBody.data.deviceId, body.data.device.id);

  await app.close();
});

test('control-plane bootstrap refuses to rotate an existing key unless rotateKey is explicit', async () => {
  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MODULE_PROFILE = 'standard';
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';
  process.env.CONTROL_PLANE_SECRET = 'z'.repeat(32);

  const app = Fastify();
  await registerRoutes(app);

  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/control-plane/clients/acme/bootstrap',
    headers: {
      'x-api-key': process.env.API_KEY,
      'x-control-plane-key': process.env.CONTROL_PLANE_SECRET,
    },
    payload: { deviceName: 'Primary' },
  });

  assert.equal(first.statusCode, 201);

  const second = await app.inject({
    method: 'POST',
    url: '/api/v1/control-plane/clients/acme/bootstrap',
    headers: {
      'x-api-key': process.env.API_KEY,
      'x-control-plane-key': process.env.CONTROL_PLANE_SECRET,
    },
    payload: { deviceName: 'Secondary' },
  });

  assert.equal(second.statusCode, 409);
  const body = second.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'CLIENT_KEY_EXISTS');

  await app.close();
});

test('control-plane inventory exposes metadata, limits, and storage for fleet management', async () => {
  const clientId = 'fleetco';
  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MODULE_PROFILE = 'standard';
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';
  process.env.CONTROL_PLANE_SECRET = 'z'.repeat(32);

  const app = Fastify();
  await registerRoutes(app);

  const bootstrap = await app.inject({
    method: 'POST',
    url: `/api/v1/control-plane/clients/${clientId}/bootstrap`,
    headers: {
      'x-api-key': process.env.API_KEY,
      'x-control-plane-key': process.env.CONTROL_PLANE_SECRET,
    },
    payload: { deviceName: 'Primary' },
  });

  assert.equal(bootstrap.statusCode, 201);
  const deviceId = bootstrap.json().data.device.id as string;

  const metadataUpdate = await app.inject({
    method: 'PUT',
    url: `/api/v1/control-plane/clients/${clientId}/metadata`,
    headers: {
      'x-api-key': process.env.API_KEY,
      'x-control-plane-key': process.env.CONTROL_PLANE_SECRET,
    },
    payload: {
      plan: { code: 'pro', storageSoftLimitMb: 512 },
      contact: { companyName: 'Acme Ltd.', email: 'ops@acme.test' },
      limits: { clientSendsPerWindow: 2, deviceSendsPerWindow: 1 },
      tags: ['vip'],
    },
  });

  assert.equal(metadataUpdate.statusCode, 200);

  await consumeSendQuota(clientId, deviceId);

  const list = await app.inject({
    method: 'GET',
    url: '/api/v1/control-plane/clients',
    headers: {
      'x-api-key': process.env.API_KEY,
      'x-control-plane-key': process.env.CONTROL_PLANE_SECRET,
    },
  });

  assert.equal(list.statusCode, 200);
  const listBody = list.json();
  assert.equal(listBody.success, true);
  const listedClient = listBody.data.find((entry: { clientId: string }) => entry.clientId === clientId);
  assert.ok(listedClient);
  assert.equal(listedClient.metadata.plan.code, 'pro');
  assert.equal(listedClient.metadata.contact.companyName, 'Acme Ltd.');
  assert.equal(listedClient.quotas.clientLimit, 2);
  assert.equal(listedClient.quotas.deviceLimit, 1);
  assert.equal(listedClient.quotas.clientUsed, 1);
  assert.equal(listedClient.deviceCount, 1);

  const detail = await app.inject({
    method: 'GET',
    url: `/api/v1/control-plane/clients/${clientId}`,
    headers: {
      'x-api-key': process.env.API_KEY,
      'x-control-plane-key': process.env.CONTROL_PLANE_SECRET,
    },
  });

  assert.equal(detail.statusCode, 200);
  const detailBody = detail.json();
  assert.equal(detailBody.data.clientId, clientId);
  assert.equal(detailBody.data.allowedNumbers.length, 0);
  assert.equal(detailBody.data.bannedNumbers.length, 0);

  const instance = await app.inject({
    method: 'GET',
    url: '/api/v1/control-plane/instance',
    headers: {
      'x-api-key': process.env.API_KEY,
      'x-control-plane-key': process.env.CONTROL_PLANE_SECRET,
    },
  });

  assert.equal(instance.statusCode, 200);
  const instanceBody = instance.json();
  assert.ok(instanceBody.data.totals.clients >= 1);
  assert.ok(instanceBody.data.totals.devices >= 1);
  assert.equal(instanceBody.data.instance.version, '1.0.0');

  await app.close();
});