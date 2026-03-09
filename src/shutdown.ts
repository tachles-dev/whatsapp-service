// shutdown.ts
import { FastifyInstance } from 'fastify';
import { connectionManager } from './connection';
import { closeRedis } from './redis';
import { stopHeartbeat } from './heartbeat';
import { logger } from './logger';

export function setupGracefulShutdown(app: FastifyInstance): void {
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Graceful shutdown initiated');

    stopHeartbeat();

    // Close WhatsApp socket first to prevent session corruption
    await connectionManager.close();

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
