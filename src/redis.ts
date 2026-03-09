// redis.ts
import Redis from 'ioredis';
import { loadConfig } from './config';
import { logger } from './logger';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (redis) return redis;

  const config = loadConfig();
  redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ
    lazyConnect: true,
  });

  redis.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });

  redis.on('connect', () => {
    logger.info('Redis connected');
  });

  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
