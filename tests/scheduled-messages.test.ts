import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../src/routes';
import { resetConfigForTests } from '../src/config';
import { closeRedis } from '../src/redis';
import { stopWebhookWorker } from '../src/queue';
import { stopScheduledMessageWorker } from '../src/queue/scheduled';
import { deviceManager } from '../src/core/device-manager';
import { scheduledMessageService } from '../src/services/scheduled-messages';
import { ScheduledMessageStatus } from '../src/types';

const ORIGINAL_ENV = { ...process.env };
const originalCreate = scheduledMessageService.createScheduledTextMessage.bind(scheduledMessageService);
const originalList = scheduledMessageService.listScheduledMessages.bind(scheduledMessageService);
const originalGet = scheduledMessageService.getScheduledMessage.bind(scheduledMessageService);
const originalCancel = scheduledMessageService.cancelScheduledMessage.bind(scheduledMessageService);
const originalReschedule = scheduledMessageService.rescheduleScheduledMessage.bind(scheduledMessageService);

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  scheduledMessageService.createScheduledTextMessage = originalCreate;
  scheduledMessageService.listScheduledMessages = originalList;
  scheduledMessageService.getScheduledMessage = originalGet;
  scheduledMessageService.cancelScheduledMessage = originalCancel;
  scheduledMessageService.rescheduleScheduledMessage = originalReschedule;
  resetConfigForTests();
}

test.afterEach(async () => {
  await deviceManager.shutdownAll();
  await stopWebhookWorker();
  await stopScheduledMessageWorker();
  await closeRedis();
  restoreEnv();
});

test('scheduled message routes are not registered when scheduling is disabled', async () => {
  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MODULE_PROFILE = 'lite';
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';

  const app = Fastify();
  await registerRoutes(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/clients/acme/devices/dev1/messages/scheduled',
    headers: { 'x-api-key': process.env.API_KEY },
  });

  assert.equal(res.statusCode, 404);
  await app.close();
});

test('scheduled message routes create, list, fetch, reschedule, and cancel records', async () => {
  process.env.API_KEY = 'x'.repeat(32);
  process.env.KEY_SECRET = 'y'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MODULE_PROFILE = 'standard';
  process.env.WEBHOOK_URL = 'https://example.com/webhook';
  process.env.WEBHOOK_API_KEY = 'secret';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'super-secret';

  const baseRecord = {
    id: 'schedule-1',
    clientId: 'acme',
    deviceId: 'dev1',
    targetJid: '972501234567@s.whatsapp.net',
    messageType: 'text' as const,
    payload: { text: 'Reminder' },
    status: ScheduledMessageStatus.SCHEDULED,
    sendAt: Date.parse('2026-03-17T10:00:00.000Z'),
    createdAt: Date.parse('2026-03-17T09:00:00.000Z'),
    updatedAt: Date.parse('2026-03-17T09:00:00.000Z'),
    sentAt: null,
    cancelledAt: null,
    sentMessageId: null,
    lastError: null,
    attemptCount: 0,
  };

  scheduledMessageService.createScheduledTextMessage = (async (input) => ({
    ...baseRecord,
    targetJid: input.targetJid,
    payload: { text: input.text, options: input.options },
    sendAt: input.sendAt,
  })) as typeof scheduledMessageService.createScheduledTextMessage;

  scheduledMessageService.listScheduledMessages = (async (_clientId, _deviceId, status) => {
    if (status && status !== ScheduledMessageStatus.SCHEDULED) return [];
    return [baseRecord];
  }) as typeof scheduledMessageService.listScheduledMessages;

  scheduledMessageService.getScheduledMessage = (async () => baseRecord) as typeof scheduledMessageService.getScheduledMessage;

  scheduledMessageService.rescheduleScheduledMessage = (async (input) => ({
    ...baseRecord,
    sendAt: input.sendAt,
    updatedAt: Date.parse('2026-03-17T09:30:00.000Z'),
  })) as typeof scheduledMessageService.rescheduleScheduledMessage;

  scheduledMessageService.cancelScheduledMessage = (async () => ({
    ...baseRecord,
    status: ScheduledMessageStatus.CANCELLED,
    cancelledAt: Date.parse('2026-03-17T09:45:00.000Z'),
    updatedAt: Date.parse('2026-03-17T09:45:00.000Z'),
  })) as typeof scheduledMessageService.cancelScheduledMessage;

  const app = Fastify();
  await registerRoutes(app);

  const createRes = await app.inject({
    method: 'POST',
    url: '/api/clients/acme/devices/dev1/messages/schedule-text',
    headers: { 'x-api-key': process.env.API_KEY },
    payload: {
      phone: '972501234567',
      text: 'Reminder',
      sendAt: '2026-03-17T10:00:00.000Z',
    },
  });
  assert.equal(createRes.statusCode, 201);
  assert.equal(createRes.json().data.id, 'schedule-1');

  const listRes = await app.inject({
    method: 'GET',
    url: '/api/clients/acme/devices/dev1/messages/scheduled?status=SCHEDULED',
    headers: { 'x-api-key': process.env.API_KEY },
  });
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.json().data.length, 1);

  const getRes = await app.inject({
    method: 'GET',
    url: '/api/clients/acme/devices/dev1/messages/scheduled/schedule-1',
    headers: { 'x-api-key': process.env.API_KEY },
  });
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.json().data.id, 'schedule-1');

  const rescheduleRes = await app.inject({
    method: 'POST',
    url: '/api/clients/acme/devices/dev1/messages/scheduled/schedule-1/reschedule',
    headers: { 'x-api-key': process.env.API_KEY },
    payload: { sendAt: '2026-03-17T11:00:00.000Z' },
  });
  assert.equal(rescheduleRes.statusCode, 200);
  assert.equal(rescheduleRes.json().data.sendAt, Date.parse('2026-03-17T11:00:00.000Z'));

  const cancelRes = await app.inject({
    method: 'DELETE',
    url: '/api/clients/acme/devices/dev1/messages/scheduled/schedule-1',
    headers: { 'x-api-key': process.env.API_KEY },
  });
  assert.equal(cancelRes.statusCode, 200);
  assert.equal(cancelRes.json().data.status, ScheduledMessageStatus.CANCELLED);

  await app.close();
});