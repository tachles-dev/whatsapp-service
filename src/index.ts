// index.ts — Entry point
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config';
import { logger } from './logger';
import { getRedis } from './redis';
import { connectionManager } from './connection';
import { registerRoutes } from './routes';
import { startWebhookWorker } from './queue';
import { startHeartbeat } from './heartbeat';
import { setupGracefulShutdown } from './shutdown';

async function main(): Promise<void> {
  // Load and validate env vars early
  const config = loadConfig();

  const app = Fastify({ logger });

  // CORS for Next.js frontend calls
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST'],
  });

  // Connect Redis
  const redis = getRedis();
  await redis.connect();

  // Register API routes
  await registerRoutes(app);

  // Start BullMQ webhook delivery worker
  startWebhookWorker();

  // Graceful shutdown on SIGTERM/SIGINT
  setupGracefulShutdown(app);

  // Start HTTP server
  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT }, 'WhatsApp Gateway Service started');

  // Start WhatsApp connection
  await connectionManager.start();

  // Start heartbeat pings to Next.js backend
  startHeartbeat();
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start service');
  process.exit(1);
});
