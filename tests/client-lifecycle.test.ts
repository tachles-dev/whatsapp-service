import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AppError } from '../src/errors';
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

test('suspended clients are blocked from tenant runtime routes while control-plane access remains available', async () => {
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
    url: '/api/v1/control-plane/clients/acme/bootstrap',
    headers: {
      'x-api-key': process.env.API_KEY,
      'x-control-plane-key': process.env.CONTROL_PLANE_SECRET,
    },
    payload: { deviceName: 'Primary' },
  });

  assert.equal(bootstrap.statusCode, 201);
  const bootstrapBody = bootstrap.json();
  const clientKey = bootstrapBody.data.key.key as string;
  const deviceId = bootstrapBody.data.device.id as string;

  const suspend = await app.inject({
    method: 'PUT',
    url: '/api/v1/control-plane/clients/acme/metadata',
    headers: {
      'x-api-key': process.env.API_KEY,
      'x-control-plane-key': process.env.CONTROL_PLANE_SECRET,
    },
    payload: { status: 'suspended' },
  });

  assert.equal(suspend.statusCode, 200);

  const runtimeRequest = await app.inject({
    method: 'GET',
    url: '/api/v1/clients/acme/devices',
    headers: { 'x-api-key': clientKey },
  });

  assert.equal(runtimeRequest.statusCode, 403);
  assert.match(runtimeRequest.json().error.message, /suspended/i);

  const controlPlaneRequest = await app.inject({
    method: 'GET',
    url: '/api/v1/control-plane/clients/acme',
    headers: {
      'x-api-key': process.env.API_KEY,
      'x-control-plane-key': process.env.CONTROL_PLANE_SECRET,
    },
  });

  assert.equal(controlPlaneRequest.statusCode, 200);
  assert.equal(controlPlaneRequest.json().data.metadata.status, 'suspended');

  await assert.rejects(
    () => consumeSendQuota('acme', deviceId),
    (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN' && /suspended/i.test(error.message),
  );

  await app.close();
});