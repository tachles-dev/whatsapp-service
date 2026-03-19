import { AppError } from './errors';
import { loadConfig } from './config';
import { ErrorCode } from './types';
import { getRedis } from './redis';
import { assertClientRuntimeAccess, clientMetadataManager } from './core/client-metadata';

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
  await assertClientRuntimeAccess(clientId);
  const config = loadConfig();
  const limits = await clientMetadataManager.getEffectiveLimits(clientId);
  const now = Date.now();
  const bucketId = bucket(now, config.SEND_THROTTLE_WINDOW_MS);
  const ttlMs = config.SEND_THROTTLE_WINDOW_MS * 2;

  await reserveQuota(clientQuotaKey(clientId, bucketId), limits.clientSendsPerWindow, units, ttlMs);
  await reserveQuota(deviceQuotaKey(deviceId, bucketId), limits.deviceSendsPerWindow, units, ttlMs);
}

export function getBroadcastConcurrency(): number {
  return loadConfig().BROADCAST_MAX_CONCURRENCY;
}

export async function getSendQuotaSnapshot(clientId: string, deviceIds: string[]): Promise<{
  windowMs: number;
  clientLimit: number;
  deviceLimit: number;
  clientUsed: number;
  devicesUsed: Record<string, number>;
}> {
  const config = loadConfig();
  const limits = await clientMetadataManager.getEffectiveLimits(clientId);
  const bucketId = bucket(Date.now(), config.SEND_THROTTLE_WINDOW_MS);
  const redis = getRedis();

  const keys = [clientQuotaKey(clientId, bucketId), ...deviceIds.map((deviceId) => deviceQuotaKey(deviceId, bucketId))];
  const values = await redis.mget(keys);

  const clientUsed = Number(values[0] ?? 0);
  const devicesUsed: Record<string, number> = {};
  for (let index = 0; index < deviceIds.length; index += 1) {
    devicesUsed[deviceIds[index]] = Number(values[index + 1] ?? 0);
  }

  return {
    windowMs: config.SEND_THROTTLE_WINDOW_MS,
    clientLimit: limits.clientSendsPerWindow,
    deviceLimit: limits.deviceSendsPerWindow,
    clientUsed,
    devicesUsed,
  };
}