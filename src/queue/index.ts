// queue/index.ts — BullMQ webhook delivery queue and worker.
import { Queue, Worker, Job } from 'bullmq';
import { loadConfig } from '../config';
import { logger } from '../logger';
import { WebhookEvent } from '../types';
import { deliverWebhook } from './delivery';
import { clientConfigManager } from '../core/client-config';

interface WebhookJobPayload {
  clientId: string;
  event: WebhookEvent;
}

const QUEUE_NAME = 'webhook-delivery';

let webhookQueue: Queue<WebhookJobPayload> | null = null;

function getRedisOpts() {
  return { connection: { url: loadConfig().REDIS_URL, maxRetriesPerRequest: null } };
}

function getEventId(event: WebhookEvent): string {
  switch (event.type) {
    case 'message': return event.id;
    case 'reaction': return `${event.messageId}_${event.from}_${event.timestamp}`;
    case 'receipt': return event.messageId;
    case 'group_participants_update': return event.chatId;
    case 'presence_update': return `${event.chatId}:${event.participantJid}:${event.timestamp}`;
    case 'group_update': return `${event.chatId}:${event.timestamp}`;
    case 'call': return event.callId;
  }
}

export function getWebhookQueue(): Queue<WebhookJobPayload> {
  if (webhookQueue) return webhookQueue;

  webhookQueue = new Queue<WebhookJobPayload>(QUEUE_NAME, {
    ...getRedisOpts(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    },
  });

  return webhookQueue;
}

export function startWebhookWorker(): Worker {
  const worker = new Worker<WebhookJobPayload>(
    QUEUE_NAME,
    async (job: Job<WebhookJobPayload>) => {
      const { clientId, event } = job.data;
      const eventId = getEventId(event);
      logger.info({ eventId, type: event.type, attempt: job.attemptsMade + 1 }, 'Delivering webhook');
      const cfg = clientConfigManager.getConfig(clientId);
      await deliverWebhook(event, { webhookUrl: cfg.webhookUrl, webhookApiKey: cfg.webhookApiKey });
    },
    {
      ...getRedisOpts(),
      concurrency: 3,
      // Poll every 1s when idle instead of the 5ms default — major Redis op reduction
      drainDelay: 1000,
      // Check for stalled jobs every 5min instead of the 30s default
      stalledInterval: 300_000,
    },
  );

  worker.on('completed', (job) => {
    const { event } = job.data;
    logger.info({ eventId: getEventId(event), type: event.type }, 'Webhook delivered');
  });

  worker.on('failed', (job, err) => {
    const event = job?.data.event;
    logger.error({ eventId: event ? getEventId(event) : 'unknown', type: event?.type, err: err.message }, 'Webhook delivery failed');
  });

  return worker;
}

export async function enqueueWebhookEvent(clientId: string, event: WebhookEvent): Promise<void> {
  const queue = getWebhookQueue();
  // Deduplicate messages by their WhatsApp message ID; give reactions/receipts unique IDs.
  let jobId: string | undefined;
  if (event.type === 'message') {
    jobId = `msg_${event.id}`;
  } else if (event.type === 'reaction') {
    jobId = `reaction_${event.messageId}_${event.from}_${event.timestamp}`;
  }
  await queue.add('webhook-event', { clientId, event }, jobId ? { jobId } : {});
}
