import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../src/routes';
import { resetConfigForTests } from '../src/config';
import { deviceManager } from '../src/core/device-manager';
import * as instanceRegistry from '../src/instance-registry';
import * as adminAuth from '../src/admin-auth';
import { closeRedis } from '../src/redis';
import { stopWebhookWorker } from '../src/queue';
import { stopScheduledMessageWorker } from '../src/queue/scheduled';

const ORIGINAL_ENV = { ...process.env };
const originalGetInfo = deviceManager.getInfo.bind(deviceManager);
const originalIsOwnedLocally = deviceManager.isOwnedLocally.bind(deviceManager);
const originalGetOwnerInstanceId = deviceManager.getOwnerInstanceId.bind(deviceManager);
const originalResolve = instanceRegistry.resolveInstanceBaseUrl;
const originalSession = adminAuth.isValidAdminSession;

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  deviceManager.getInfo = originalGetInfo;
  deviceManager.isOwnedLocally = originalIsOwnedLocally;
  deviceManager.getOwnerInstanceId = originalGetOwnerInstanceId;
  instanceRegistry.resolveInstanceBaseUrl = originalResolve;
  adminAuth.isValidAdminSession = originalSession;
  resetConfigForTests();
}

test.afterEach(async () => {
  await deviceManager.shutdownAll();
  await stopWebhookWorker();
  await stopScheduledMessageWorker();
  await closeRedis();
  restoreEnv();
});

test('admin route is not registered when admin module is disabled', async () => {
  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MODULE_PROFILE = 'lite';
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';

  const app = Fastify();
  await registerRoutes(app);
  const res = await app.inject({ method: 'GET', url: '/api/admin/runtime', headers: { 'x-api-key': process.env.API_KEY } });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('device-scoped request returns service unavailable when owner is remote and unavailable', async () => {
  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MODULE_PROFILE = 'full';
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';
  process.env.INSTANCE_BASE_URL = 'https://self.example.com';

  deviceManager.getInfo = (() => ({ id: 'dev1', clientId: 'acme', name: 'Test', createdAt: 1, phone: null })) as typeof deviceManager.getInfo;
  deviceManager.isOwnedLocally = (() => false) as typeof deviceManager.isOwnedLocally;
  deviceManager.getOwnerInstanceId = (async () => 'instance-b') as typeof deviceManager.getOwnerInstanceId;
  instanceRegistry.resolveInstanceBaseUrl = (async () => null) as typeof instanceRegistry.resolveInstanceBaseUrl;

  const app = Fastify();
  await registerRoutes(app);
  const res = await app.inject({
    method: 'GET',
    url: '/api/clients/acme/devices/dev1/status',
    headers: { 'x-api-key': process.env.API_KEY },
  });
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /instance endpoint is unavailable/);
  await app.close();
});