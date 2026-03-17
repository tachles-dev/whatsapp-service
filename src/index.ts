// index.ts — Entry point
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config';
import { logger, loggerConfig } from './logger';
import { getRedis } from './redis';
import { registerRoutes } from './routes/index';
import { startWebhookWorker } from './queue/index';
import { startScheduledMessageWorker } from './queue/scheduled';
import { startHeartbeat } from './heartbeat';
import { setupGracefulShutdown } from './shutdown';
import { deviceManager } from './core/device-manager';
import { startInstanceRegistry } from './instance-registry';

async function main(): Promise<void> {
  // Load and validate env vars early
  const config = loadConfig();

  const app = Fastify({ logger: loggerConfig, trustProxy: true });

  // CORS — auto-derived from WEBHOOK_URL + optional CORS_ORIGINS extras
  const webhookOrigin = config.WEBHOOK_URL ? new URL(config.WEBHOOK_URL).origin : null;
  const origins = webhookOrigin
    ? [webhookOrigin, ...config.CORS_ORIGINS.filter((o) => o !== webhookOrigin)]
    : config.CORS_ORIGINS;

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
  if (config.modules.webhooks) startWebhookWorker();
  if (config.modules.scheduling) startScheduledMessageWorker();
  if (config.modules.ownerForwarding) startInstanceRegistry();

  // Graceful shutdown on SIGTERM/SIGINT
  setupGracefulShutdown(app);

  // Start HTTP server
  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, deviceStartBatchSize: config.DEVICE_START_BATCH_SIZE }, 'WhatsApp Gateway Service started');

  // Start heartbeat pings to Next.js backend
  if (config.modules.heartbeat) startHeartbeat();
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start service');
  process.exit(1);
});
