// index.ts — Entry point
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config';
import { logger, loggerConfig } from './logger';
import { getRedis } from './redis';
import { registerRoutes } from './routes/index';
import { startWebhookWorker } from './queue/index';
import { startHeartbeat } from './heartbeat';
import { setupGracefulShutdown } from './shutdown';
import { deviceManager } from './core/device-manager';

async function main(): Promise<void> {
  // Load and validate env vars early
  const config = loadConfig();

  const app = Fastify({ logger: loggerConfig, trustProxy: true });

  // CORS — auto-derived from WEBHOOK_URL + optional CORS_ORIGINS extras
  const webhookOrigin = new URL(config.WEBHOOK_URL).origin;
  const origins = [webhookOrigin, ...config.CORS_ORIGINS.filter((o) => o !== webhookOrigin)];

  await app.register(cors, {
    origin: origins,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
  });

  // Connect Redis
  const redis = getRedis();
  await redis.connect();

  // Restore all previously registered devices from Redis
  await deviceManager.loadFromRedis();

  // Register API routes
  await registerRoutes(app);

  // Start BullMQ webhook delivery worker
  startWebhookWorker();

  // Graceful shutdown on SIGTERM/SIGINT
  setupGracefulShutdown(app);

  // Start HTTP server
  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT }, 'WhatsApp Gateway Service started');

  // Start heartbeat pings to Next.js backend
  startHeartbeat();
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start service');
  process.exit(1);
});
