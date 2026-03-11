// queue/delivery.ts — HTTP delivery of webhook events to client endpoints.
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
  const url = overrides?.webhookUrl || config.WEBHOOK_URL;
  const apiKey = overrides?.webhookApiKey || config.WEBHOOK_API_KEY;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(message),
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
