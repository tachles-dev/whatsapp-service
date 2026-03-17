import { Job, Queue, Worker } from 'bullmq';
import { loadConfig } from '../config';
import { logger } from '../logger';
import { scheduledMessageService, ScheduledMessageJobPayload } from '../services/scheduled-messages';

const QUEUE_NAME = 'scheduled-message-send';

let scheduledQueue: Queue<ScheduledMessageJobPayload> | null = null;
let scheduledWorker: Worker<ScheduledMessageJobPayload> | null = null;

function getRedisOpts() {
  return { connection: { url: loadConfig().REDIS_URL, maxRetriesPerRequest: null } };
}

export function getScheduledMessageQueue(): Queue<ScheduledMessageJobPayload> {
  if (!loadConfig().modules.scheduling) {
    throw new Error('Scheduling module is disabled');
  }
  if (scheduledQueue) return scheduledQueue;

  scheduledQueue = new Queue<ScheduledMessageJobPayload>(QUEUE_NAME, {
    ...getRedisOpts(),
    defaultJobOptions: {
      attempts: 10,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  });

  return scheduledQueue;
}

export async function upsertScheduledMessageJob(scheduleId: string, delayMs: number): Promise<void> {
  if (!loadConfig().modules.scheduling) return;
  const queue = getScheduledMessageQueue();
  const existing = await queue.getJob(scheduleId);
  if (existing) await existing.remove();
  await queue.add('scheduled-message-send', { scheduleId }, { jobId: scheduleId, delay: Math.max(0, delayMs) });
}

export async function removeScheduledMessageJob(scheduleId: string): Promise<void> {
  if (!loadConfig().modules.scheduling) return;
  const queue = getScheduledMessageQueue();
  const existing = await queue.getJob(scheduleId);
  if (existing) await existing.remove();
}

export function startScheduledMessageWorker(): Worker<ScheduledMessageJobPayload> {
  if (scheduledWorker) return scheduledWorker;

  scheduledMessageService.setJobController({
    upsertDelayedJob: upsertScheduledMessageJob,
    removeDelayedJob: removeScheduledMessageJob,
  });

  const worker = new Worker<ScheduledMessageJobPayload>(
    QUEUE_NAME,
    async (job: Job<ScheduledMessageJobPayload>) => {
      await scheduledMessageService.executeScheduledMessage(job);
    },
    {
      ...getRedisOpts(),
      concurrency: 5,
      drainDelay: 1000,
      stalledInterval: 300_000,
    },
  );

  worker.on('completed', (job) => {
    logger.info({ scheduleId: job.data.scheduleId }, 'Scheduled message job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ scheduleId: job?.data.scheduleId, err: err.message }, 'Scheduled message job failed');
  });

  scheduledWorker = worker;
  scheduledMessageService.startReconciliationLoop();
  return worker;
}

export async function stopScheduledMessageWorker(): Promise<void> {
  scheduledMessageService.stopReconciliationLoop();
  if (scheduledWorker) {
    await scheduledWorker.close();
    scheduledWorker = null;
  }
  if (scheduledQueue) {
    await scheduledQueue.close();
    scheduledQueue = null;
  }
}