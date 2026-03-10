// heartbeat.ts
import { loadConfig } from './config';
import { logger } from './logger';
import { connectionManager } from './connection';

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Sends a periodic heartbeat ping to the Next.js backend
 * to confirm the WhatsApp link is active.
 */
export function startHeartbeat(): void {
  const config = loadConfig();

  heartbeatTimer = setInterval(async () => {
    try {
      const statusData = connectionManager.getStatusData();
      const res = await fetch(config.WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.WEBHOOK_API_KEY,
        },
        body: JSON.stringify({
          type: 'heartbeat',
          ...statusData,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        logger.warn({ status: res.status }, 'Heartbeat ping failed');
      } else {
        logger.debug('Heartbeat sent');
      }
    } catch (err) {
      logger.warn({ err }, 'Heartbeat ping error');
    }
  }, config.HEARTBEAT_INTERVAL);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
