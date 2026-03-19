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
        json: async () => ({ success: true, timestamp: Date.now(), data: { ok: true } }),
      } as Response;
    }) as typeof fetch,
  });

  await client.getApiOverview();
  assert.equal(calls[0], `https://example.com${DEFAULT_API_BASE_PATH}`);
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
