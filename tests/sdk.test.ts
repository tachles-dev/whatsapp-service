import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_API_BASE_PATH,
  WhatsAppGatewayClient,
  createWebhookSignature,
  parseWebhookEvent,
  verifyWebhookSignature,
} from '../src/sdk';

test('sdk defaults to the versioned API base path', async () => {
  const calls: string[] = [];
  const client = new WhatsAppGatewayClient({
    baseUrl: 'https://example.com/',
    apiKey: 'secret',
    fetch: (async (input: string | URL) => {
      calls.push(String(input));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, timestamp: Date.now(), data: { ok: true } }),
      } as Response;
    }) as typeof fetch,
  });

  await client.getApiOverview();
  assert.equal(calls[0], `https://example.com${DEFAULT_API_BASE_PATH}`);
});

test('sdk exposes the agent integration route', async () => {
  const calls: string[] = [];
  const client = new WhatsAppGatewayClient({
    baseUrl: 'https://example.com/',
    apiKey: 'secret',
    fetch: (async (input: string | URL) => {
      calls.push(String(input));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          timestamp: Date.now(),
          data: {
            kind: 'wgs-agent-context/v1',
            service: { name: 'WhatsApp Gateway Service', packageName: 'whatsapp-gateway-service', basePath: '/api/v1', sdkPackage: 'whatsapp-gateway-service' },
            links: { overview: '/api/v1', agent: '/api/v1/agent', reference: '/api/v1/reference', docs: '/' },
            instructions: ['Start with GET /api/v1/agent'],
            auth: { header: 'x-api-key', adminCookie: 'wga_admin', modes: [] },
            conventions: {
              preferredBasePath: '/api/v1',
              legacyBasePath: '/api',
              requestContentType: 'application/json',
              responseEnvelope: [],
              rateLimitHeaders: [],
              pathRules: [],
            },
            taskRoutes: [],
            workflows: [],
            examples: [],
            endpointIndex: [],
          },
        }),
      } as Response;
    }) as typeof fetch,
  });

  const context = await client.getAgentContext();
  assert.equal(calls[0], `https://example.com${DEFAULT_API_BASE_PATH}/agent`);
  assert.equal(context.kind, 'wgs-agent-context/v1');
  assert.equal(context.links.agent, '/api/v1/agent');
});

test('sdk exposes control-plane bootstrap routes', async () => {
  const calls: string[] = [];
  const client = new WhatsAppGatewayClient({
    baseUrl: 'https://example.com/',
    apiKey: 'secret',
    headers: { 'x-control-plane-key': 'cp-secret' },
    fetch: (async (input: string | URL) => {
      calls.push(String(input));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          timestamp: Date.now(),
          data: {
            clientId: 'acme',
            key: { key: 'tenant-key', warning: 'Store this key securely. It will never be shown again.' },
            device: { id: 'dev1', clientId: 'acme', name: 'Primary', createdAt: Date.now(), phone: null },
            config: { maxDevices: 5, key: { hasKey: true } },
            onboardingPath: '/api/v1/control-plane/clients/acme/devices/dev1/onboarding',
          },
        }),
      } as Response;
    }) as typeof fetch,
  });

  const result = await client.bootstrapTenant('acme', { deviceName: 'Primary' });
  assert.equal(calls[0], `https://example.com${DEFAULT_API_BASE_PATH}/control-plane/clients/acme/bootstrap`);
  assert.equal(result.clientId, 'acme');
  assert.equal(result.key.key, 'tenant-key');
});

test('sdk exposes fleet-management routes for control planes', async () => {
  const calls: string[] = [];
  const client = new WhatsAppGatewayClient({
    baseUrl: 'https://example.com/',
    apiKey: 'secret',
    fetch: (async (input: string | URL) => {
      calls.push(String(input));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          timestamp: Date.now(),
          data: [],
        }),
      } as Response;
    }) as typeof fetch,
  });

  await client.listManagedClients();
  await client.getManagedInstance();

  assert.equal(calls[0], `https://example.com${DEFAULT_API_BASE_PATH}/control-plane/clients`);
  assert.equal(calls[1], `https://example.com${DEFAULT_API_BASE_PATH}/control-plane/instance`);
});

test('webhook helpers create, verify, and parse signed payloads', () => {
  const payload = JSON.stringify({ type: 'message', deviceId: 'dev1', id: 'msg-1', from: 'a@s.whatsapp.net', chatId: 'a@s.whatsapp.net', messageType: 'text', text: 'hello', mimeType: null, fileName: null, location: null, timestamp: Date.now(), isGroup: false, isForwarded: false, quotedMessageId: null, mentionedJids: [], pushName: 'Alice' });
  const secret = 'webhook-secret';

  const signature = createWebhookSignature(secret, payload);
  const verification = verifyWebhookSignature(secret, payload, signature);
  assert.equal(verification.valid, true);
  assert.equal(verification.providedSignature, signature);

  const failedVerification = verifyWebhookSignature(secret, payload, 'sha256=deadbeef');
  assert.equal(failedVerification.valid, false);

  const parsed = parseWebhookEvent(payload);
  assert.equal(parsed.type, 'message');
  assert.equal(parsed.deviceId, 'dev1');
});
