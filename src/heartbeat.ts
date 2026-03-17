// heartbeat.ts
import { loadConfig } from './config';
import { logger } from './logger';
import { deviceManager } from './core/device-manager';

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Sends a periodic heartbeat ping for every active device.
 */
export function startHeartbeat(): void {
  const config = loadConfig();
  if (!config.modules.heartbeat || !config.WEBHOOK_URL || !config.WEBHOOK_API_KEY) return;
  const webhookUrl = config.WEBHOOK_URL;
  const webhookApiKey = config.WEBHOOK_API_KEY;

  heartbeatTimer = setInterval(async () => {
    const allInfos = deviceManager.getAllInfos();

    for (const info of allInfos) {
      const manager = deviceManager.getManager(info.id);
      if (!manager) continue;

      try {
        const statusData = manager.getStatusData();

        logger.info(
          {
            deviceId: info.id,
            status: statusData.status,
            uptime: Math.round(statusData.uptime / 1000) + 's',
          },
          'Heartbeat',
        );

        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': webhookApiKey,
          },
          body: JSON.stringify({ type: 'heartbeat', ...statusData }),
          signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) {
          logger.warn({ status: res.status, deviceId: info.id }, 'Heartbeat ping failed');
        }
      } catch (err) {
        logger.warn({ err, deviceId: info.id }, 'Heartbeat ping error');
      }
    }
  }, config.HEARTBEAT_INTERVAL);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
