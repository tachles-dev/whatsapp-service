// webhook.ts
import { loadConfig } from './config';
import { logger } from './logger';
import { InboundMessage } from './types';

/**
 * Deliver a message payload to the Next.js webhook endpoint.
 * Throws on failure so BullMQ can retry with exponential backoff.
 */
export async function deliverWebhook(message: InboundMessage): Promise<void> {
  const config = loadConfig();

  const res = await fetch(config.WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': config.WEBHOOK_API_KEY,
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
