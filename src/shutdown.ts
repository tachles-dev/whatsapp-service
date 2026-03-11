// shutdown.ts
import { FastifyInstance } from 'fastify';
import { closeRedis } from './redis';
import { stopHeartbeat } from './heartbeat';
import { deviceManager } from './core/device-manager';
import { logger } from './logger';

export function setupGracefulShutdown(app: FastifyInstance): void {
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Graceful shutdown initiated');

    stopHeartbeat();

    // Flush caches and close all device connections
    await deviceManager.shutdownAll();

    // Close HTTP server
    await app.close();

    // Close Redis
    await closeRedis();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
