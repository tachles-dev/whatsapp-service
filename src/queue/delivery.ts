// queue/delivery.ts — HTTP delivery of webhook events to client endpoints.
import { createHmac } from 'crypto';
import { loadConfig } from '../config';
import { logger } from '../logger';
import { WebhookEvent } from '../types';

/**
 * Deliver a webhook event payload to the client's configured webhook endpoint.
 * Throws on failure so BullMQ can retry with exponential backoff.
 */
export async function deliverWebhook(
  message: WebhookEvent,
  overrides?: { webhookUrl?: string; webhookApiKey?: string },
): Promise<void> {
  const config = loadConfig();
  if (!config.modules.webhooks) return;
  const url = overrides?.webhookUrl || config.WEBHOOK_URL;
  const apiKey = overrides?.webhookApiKey || config.WEBHOOK_API_KEY;
  if (!url || !apiKey) throw new Error('Webhook delivery is enabled but webhook configuration is missing');

  const bodyStr = JSON.stringify(message);
  const signature = createHmac('sha256', apiKey).update(bodyStr).digest('hex');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'x-webhook-signature': `sha256=${signature}`,
    },
    body: bodyStr,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error(
      { status: res.status, body },
      'Webhook delivery failed with non-OK status',
    );
    throw new Error(`Webhook returned ${res.status}`);
  }
}
