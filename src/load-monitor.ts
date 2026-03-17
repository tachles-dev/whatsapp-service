import { monitorEventLoopDelay } from 'node:perf_hooks';
import { loadConfig } from './config';
import { deviceManager } from './core/device-manager';
import { getWebhookQueue } from './queue';
import { getScheduledMessageQueue } from './queue/scheduled';
import { getRedis } from './redis';

type HealthState = 'OK' | 'DEGRADED' | 'OVERLOADED';

export interface LoadSnapshot {
  state: HealthState;
  live: true;
  ready: boolean;
  reasons: string[];
  timestamp: number;
  uptimeSeconds: number;
  process: {
    pid: number;
    instanceId: string;
    heapUsedBytes: number;
    heapTotalBytes: number;
    heapPercent: number;
    rssBytes: number;
    eventLoopDelayP95Ms: number;
  };
  queues: {
    webhook: {
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
      backlog: number;
    };
    scheduled: {
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
      backlog: number;
    };
  };
  tenants: {
    totalClients: number;
    totalDevices: number;
    connectedDevices: number;
    recoveringDevices: number;
  };
  dependencies: {
    redisConnected: boolean;
  };
}

const eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
eventLoopMonitor.enable();

function roundMs(nanoseconds: number): number {
  return Math.round(nanoseconds / 1_000_000);
}

export async function getLoadSnapshot(): Promise<LoadSnapshot> {
  const config = loadConfig();
  const memory = process.memoryUsage();
  const heapPercent = memory.heapTotal > 0 ? Math.round((memory.heapUsed / memory.heapTotal) * 100) : 0;
  const eventLoopDelayP95Ms = roundMs(eventLoopMonitor.percentile(95));

  const [webhookCounts, scheduledCounts] = await Promise.all([
    config.modules.webhooks
      ? Promise.all([
        getWebhookQueue().getWaitingCount(),
        getWebhookQueue().getActiveCount(),
        getWebhookQueue().getDelayedCount(),
        getWebhookQueue().getFailedCount(),
      ])
      : Promise.resolve([0, 0, 0, 0]),
    config.modules.scheduling
      ? Promise.all([
        getScheduledMessageQueue().getWaitingCount(),
        getScheduledMessageQueue().getActiveCount(),
        getScheduledMessageQueue().getDelayedCount(),
        getScheduledMessageQueue().getFailedCount(),
      ])
      : Promise.resolve([0, 0, 0, 0]),
  ]);

  const webhookBacklog = webhookCounts[0] + webhookCounts[2];
  const scheduledBacklog = scheduledCounts[0] + scheduledCounts[2];
  const deviceStates = deviceManager.getAllInfos().map((info) => deviceManager.getManager(info.id)?.getStatusData()).filter(Boolean);
  const connectedDevices = deviceStates.filter((status) => status?.status === 'CONNECTED').length;
  const recoveringDevices = deviceStates.filter((status) => status?.recovering).length;
  const redisConnected = ['ready', 'connect'].includes(getRedis().status);

  const reasons: string[] = [];
  let state: HealthState = 'OK';

  if (!redisConnected) {
    state = 'OVERLOADED';
    reasons.push('redis_unavailable');
  }
  if (eventLoopDelayP95Ms >= config.STATUS_EVENT_LOOP_P95_MS) {
    state = 'OVERLOADED';
    reasons.push('event_loop_lag');
  }
  if (heapPercent >= config.STATUS_HEAP_PERCENT) {
    state = 'OVERLOADED';
    reasons.push('heap_pressure');
  }
  if (webhookBacklog >= config.STATUS_WEBHOOK_QUEUE_BACKLOG) {
    state = 'OVERLOADED';
    reasons.push('webhook_backlog');
  }
  if (scheduledBacklog >= config.STATUS_SCHEDULED_QUEUE_BACKLOG) {
    state = 'OVERLOADED';
    reasons.push('scheduled_backlog');
  }

  if (state === 'OK') {
    if (recoveringDevices > 0) reasons.push('device_recovery_in_progress');
    if (webhookCounts[3] > 0 || scheduledCounts[3] > 0) reasons.push('recent_queue_failures');
    if (reasons.length > 0) state = 'DEGRADED';
  }

  return {
    state,
    live: true,
    ready: state !== 'OVERLOADED',
    reasons,
    timestamp: Date.now(),
    uptimeSeconds: Math.floor(process.uptime()),
    process: {
      pid: process.pid,
      instanceId: config.INSTANCE_ID,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      heapPercent,
      rssBytes: memory.rss,
      eventLoopDelayP95Ms,
    },
    queues: {
      webhook: {
        waiting: webhookCounts[0],
        active: webhookCounts[1],
        delayed: webhookCounts[2],
        failed: webhookCounts[3],
        backlog: webhookBacklog,
      },
      scheduled: {
        waiting: scheduledCounts[0],
        active: scheduledCounts[1],
        delayed: scheduledCounts[2],
        failed: scheduledCounts[3],
        backlog: scheduledBacklog,
      },
    },
    tenants: {
      totalClients: deviceManager.getClientIds().length,
      totalDevices: deviceStates.length,
      connectedDevices,
      recoveringDevices,
    },
    dependencies: {
      redisConnected,
    },
  };
}