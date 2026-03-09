// queue.ts
import { Queue, Worker, Job } from 'bullmq';
import { loadConfig } from './config';
import { logger } from './logger';
import { InboundMessage } from './types';
import { deliverWebhook } from './webhook';

const QUEUE_NAME = 'webhook-delivery';

let webhookQueue: Queue | null = null;

function getRedisOpts() {
  return { connection: { url: loadConfig().REDIS_URL, maxRetriesPerRequest: null } };
}

export function getWebhookQueue(): Queue {
  if (webhookQueue) return webhookQueue;

  webhookQueue = new Queue(QUEUE_NAME, {
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
  const worker = new Worker<InboundMessage>(
    QUEUE_NAME,
    async (job: Job<InboundMessage>) => {
      logger.info({ msgId: job.data.id, attempt: job.attemptsMade + 1 }, 'Delivering webhook');
      await deliverWebhook(job.data);
    },
    {
      ...getRedisOpts(),
      concurrency: 3,
    },
  );

  worker.on('completed', (job) => {
    logger.info({ msgId: job.data.id }, 'Webhook delivered');
  });

  worker.on('failed', (job, err) => {
    logger.error({ msgId: job?.data.id, err: err.message }, 'Webhook delivery failed');
  });

  return worker;
}

export async function enqueueMessage(msg: InboundMessage): Promise<void> {
  const queue = getWebhookQueue();
  await queue.add('inbound-message', msg, { jobId: msg.id });
}
