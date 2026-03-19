import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../src/routes';
import { resetConfigForTests } from '../src/config';
import { deviceManager } from '../src/core/device-manager';
import { closeRedis } from '../src/redis';
import { stopWebhookWorker } from '../src/queue';
import { stopScheduledMessageWorker } from '../src/queue/scheduled';

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

function applyBaseEnv(profile: 'lite' | 'standard' = 'standard'): void {
  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MODULE_PROFILE = profile;
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';
}

test('public discovery endpoints expose the API contract without authentication', async () => {
  applyBaseEnv('standard');
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'super-secret';

  const app = Fastify();
  await registerRoutes(app);

  const overviewRes = await app.inject({ method: 'GET', url: '/api' });
  assert.equal(overviewRes.statusCode, 200);
  const overview = overviewRes.json();
  assert.equal(overview.success, true);
  assert.equal(overview.data.service.packageName, 'whatsapp-gateway-service');
  assert.ok(overview.data.totals.endpoints > 0);
  assert.ok(overview.data.groups.some((group: { id: string }) => group.id === 'messages'));

  const versionedOverviewRes = await app.inject({ method: 'GET', url: '/api/v1' });
  assert.equal(versionedOverviewRes.statusCode, 200);
  const versionedOverview = versionedOverviewRes.json();
  assert.equal(versionedOverview.success, true);
  assert.equal(versionedOverview.data.service.basePath, '/api/v1');
  assert.equal(versionedOverview.data.service.preferredBasePath, '/api/v1');

  const referenceRes = await app.inject({ method: 'GET', url: '/api/reference' });
  assert.equal(referenceRes.statusCode, 200);
  const reference = referenceRes.json();
  assert.equal(reference.success, true);
  const messagesGroup = reference.data.groups.find((group: { id: string }) => group.id === 'messages');
  assert.ok(messagesGroup);
  assert.ok(messagesGroup.endpoints.some((endpoint: { path: string }) => endpoint.path.endsWith('/messages/send-text')));
  assert.ok(messagesGroup.endpoints.some((endpoint: { path: string }) => endpoint.path.endsWith('/messages/scheduled')));

  const versionedReferenceRes = await app.inject({ method: 'GET', url: '/api/v1/reference' });
  assert.equal(versionedReferenceRes.statusCode, 200);
  const versionedReference = versionedReferenceRes.json();
  const versionedMessagesGroup = versionedReference.data.groups.find((group: { id: string }) => group.id === 'messages');
  assert.ok(versionedMessagesGroup);
  assert.ok(versionedMessagesGroup.endpoints.every((endpoint: { path: string }) => endpoint.path.startsWith('/api/v1/')));

  const openApiRes = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
  assert.equal(openApiRes.statusCode, 200);
  assert.match(openApiRes.headers['content-type'] ?? '', /application\/json/);
  const openApi = openApiRes.json();
  assert.equal(openApi.openapi, '3.1.0');
  assert.ok(openApi.paths['/api/v1/clients/{clientId}/devices/{deviceId}/messages/send-text']);

  const docsRes = await app.inject({ method: 'GET', url: '/' });
  assert.equal(docsRes.statusCode, 200);
  assert.match(docsRes.headers['content-type'] ?? '', /text\/html/);
  assert.match(docsRes.body, /Versioned API Surface/);
  assert.match(docsRes.body, /\/api\/v1\/reference/);
  assert.match(docsRes.body, /\/api\/v1\/openapi\.json/);

  await app.close();
});

test('discovery reference respects runtime module flags', async () => {
  applyBaseEnv('lite');

  const app = Fastify();
  await registerRoutes(app);

  const referenceRes = await app.inject({ method: 'GET', url: '/api/reference' });
  assert.equal(referenceRes.statusCode, 200);
  const reference = referenceRes.json();
  const groupIds = reference.data.groups.map((group: { id: string }) => group.id);
  assert.equal(groupIds.includes('admin'), false);

  const messagesGroup = reference.data.groups.find((group: { id: string }) => group.id === 'messages');
  assert.ok(messagesGroup);
  assert.equal(messagesGroup.endpoints.some((endpoint: { path: string }) => endpoint.path.includes('/messages/scheduled')), false);
  assert.equal(messagesGroup.endpoints.some((endpoint: { path: string }) => endpoint.path.endsWith('/messages/schedule-text')), false);

  await app.close();
});
