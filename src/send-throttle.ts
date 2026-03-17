import { AppError } from './errors';
import { loadConfig } from './config';
import { ErrorCode } from './types';
import { getRedis } from './redis';

function bucket(now: number, windowMs: number): string {
  return String(Math.floor(now / windowMs));
}

function clientQuotaKey(clientId: string, bucketId: string): string {
  return `wa:quota:client:${clientId}:${bucketId}`;
}

function deviceQuotaKey(deviceId: string, bucketId: string): string {
  return `wa:quota:device:${deviceId}:${bucketId}`;
}

async function reserveQuota(key: string, max: number, units: number, ttlMs: number): Promise<number> {
  const redis = getRedis();
  const multi = redis.multi();
  multi.incrby(key, units);
  multi.pexpire(key, ttlMs);
  const results = await multi.exec();
  const count = Number(results?.[0]?.[1] ?? 0);
  if (count > max) {
    throw new AppError(ErrorCode.LIMIT_REACHED, 'Outbound send rate limit exceeded', 429, true);
  }
  return count;
}

export async function consumeSendQuota(clientId: string, deviceId: string, units = 1): Promise<void> {
  const config = loadConfig();
  const now = Date.now();
  const bucketId = bucket(now, config.SEND_THROTTLE_WINDOW_MS);
  const ttlMs = config.SEND_THROTTLE_WINDOW_MS * 2;

  await reserveQuota(clientQuotaKey(clientId, bucketId), config.CLIENT_SENDS_PER_WINDOW, units, ttlMs);
  await reserveQuota(deviceQuotaKey(deviceId, bucketId), config.DEVICE_SENDS_PER_WINDOW, units, ttlMs);
}

export function getBroadcastConcurrency(): number {
  return loadConfig().BROADCAST_MAX_CONCURRENCY;
}