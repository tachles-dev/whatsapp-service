import test from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { resetConfigForTests, loadConfig } from '../src/config';
import { closeRedis } from '../src/redis';
import { stopWebhookWorker } from '../src/queue';
import { stopScheduledMessageWorker } from '../src/queue/scheduled';

const ORIGINAL_ENV = { ...process.env };
const TEMP_MODULE_CONFIG_PATH = 'config/modules.custom.test.json';

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    unlinkSync(TEMP_MODULE_CONFIG_PATH);
  } catch {}
  resetConfigForTests();
}

test.afterEach(async () => {
  await stopWebhookWorker();
  await stopScheduledMessageWorker();
  await closeRedis();
  restoreEnv();
});

test('lite profile disables heavy modules', () => {
  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MODULE_PROFILE = 'lite';
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';

  const config = loadConfig();
  assert.equal(config.modules.admin, false);
  assert.equal(config.modules.audit, false);
  assert.equal(config.modules.heartbeat, false);
  assert.equal(config.modules.webhooks, true);
  assert.equal(config.modules.scheduling, false);
  assert.equal(config.modules.multiInstanceLeasing, false);
  assert.equal(config.modules.ownerForwarding, false);
});

test('default module set does not require instance base url', () => {
  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';

  const config = loadConfig();
  assert.equal(config.modules.admin, true);
  assert.equal(config.modules.audit, true);
  assert.equal(config.modules.scheduling, true);
  assert.equal(config.modules.multiInstanceLeasing, false);
  assert.equal(config.modules.ownerForwarding, false);
});

test('full profile requires instance base url when owner forwarding remains enabled', () => {
  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MODULE_PROFILE = 'full';
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';

  assert.throws(() => loadConfig(), /INSTANCE_BASE_URL is required/);
});

test('module file plus env override resolves correctly', () => {
  writeFileSync(TEMP_MODULE_CONFIG_PATH, JSON.stringify({
    profile: 'standard',
    modules: {
      admin: true,
      audit: false,
      scheduling: true,
    },
  }));

  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MODULE_CONFIG_PATH = TEMP_MODULE_CONFIG_PATH;
  process.env.MODULE_ADMIN_ENABLED = 'false';
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';

  const config = loadConfig();
  assert.equal(config.modules.admin, false);
  assert.equal(config.modules.audit, false);
  assert.equal(config.modules.scheduling, true);
});