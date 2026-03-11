// queue.ts
import { Queue, Worker, Job } from 'bullmq';
import { loadConfig } from './config';
import { logger } from './logger';
import { WebhookEvent } from './types';
import { deliverWebhook } from './webhook';

const QUEUE_NAME = 'webhook-delivery';

let webhookQueue: Queue<WebhookEvent> | null = null;

function getRedisOpts() {
  return { connection: { url: loadConfig().REDIS_URL, maxRetriesPerRequest: null } };
}

export function getWebhookQueue(): Queue<WebhookEvent> {
  if (webhookQueue) return webhookQueue;

  webhookQueue = new Queue<WebhookEvent>(QUEUE_NAME, {
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
  const worker = new Worker<WebhookEvent>(
    QUEUE_NAME,
    async (job: Job<WebhookEvent>) => {
      const eventId = job.data.type === 'message' ? job.data.id : job.data.type === 'group_participants_update' ? job.data.chatId : job.data.messageId;
      logger.info({ eventId, type: job.data.type, attempt: job.attemptsMade + 1 }, 'Delivering webhook');
      await deliverWebhook(job.data);
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
    const eventId = job.data.type === 'message' ? job.data.id : job.data.type === 'group_participants_update' ? job.data.chatId : job.data.messageId;
    logger.info({ eventId, type: job.data.type }, 'Webhook delivered');
  });

  worker.on('failed', (job, err) => {
    const eventId = job?.data.type === 'message' ? job.data.id : job?.data.type === 'group_participants_update' ? job?.data.chatId : job?.data.messageId;
    logger.error({ eventId, type: job?.data.type, err: err.message }, 'Webhook delivery failed');
  });

  return worker;
}

export async function enqueueWebhookEvent(event: WebhookEvent): Promise<void> {
  const queue = getWebhookQueue();
  // Deduplicate messages by their WhatsApp message ID.
  // Reactions and receipts get unique IDs so every event is tracked.
  let jobId: string | undefined;
  if (event.type === 'message') {
    jobId = `msg_${event.id}`;
  } else if (event.type === 'reaction') {
    jobId = `reaction_${event.messageId}_${event.from}_${event.timestamp}`;
  }
  await queue.add('webhook-event', event, jobId ? { jobId } : {});
}
