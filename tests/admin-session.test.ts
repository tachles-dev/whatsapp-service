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

test('admin login sets a session cookie that authorizes runtime access and logout revokes it', async () => {
  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MODULE_PROFILE = 'standard';
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'super-secret';

  const app = Fastify();
  await registerRoutes(app);

  const login = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username: 'admin', password: 'super-secret' },
  });

  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'];
  assert.ok(cookie);
  assert.match(Array.isArray(cookie) ? cookie[0] : cookie, /wga_admin=/);

  const runtimeWithCookie = await app.inject({
    method: 'GET',
    url: '/api/admin/runtime',
    headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie },
  });

  assert.equal(runtimeWithCookie.statusCode, 200);
  const runtimeBody = runtimeWithCookie.json();
  assert.equal(runtimeBody.success, true);
  assert.equal(runtimeBody.data.features.adminCredentialsConfigured, true);

  const logout = await app.inject({
    method: 'POST',
    url: '/api/admin/logout',
    headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie },
  });

  assert.equal(logout.statusCode, 200);

  const runtimeAfterLogout = await app.inject({
    method: 'GET',
    url: '/api/admin/runtime',
    headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie },
  });

  assert.equal(runtimeAfterLogout.statusCode, 401);
  await app.close();
});

test('admin login rejects invalid credentials', async () => {
  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MODULE_PROFILE = 'standard';
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'super-secret';

  const app = Fastify();
  await registerRoutes(app);

  const login = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username: 'admin', password: 'wrong' },
  });

  assert.equal(login.statusCode, 401);
  await app.close();
});