import { getRedis } from './redis';
import { loadConfig } from './config';
import { logger } from './logger';

interface InstanceRecord {
  instanceId: string;
  baseUrl: string;
  updatedAt: number;
}

let renewTimer: ReturnType<typeof setInterval> | null = null;

function instanceKey(instanceId: string): string {
  return `wa:instance:${instanceId}`;
}

export async function registerCurrentInstance(): Promise<void> {
  const config = loadConfig();
  if (!config.INSTANCE_BASE_URL) return;
  const payload: InstanceRecord = {
    instanceId: config.INSTANCE_ID,
    baseUrl: config.INSTANCE_BASE_URL,
    updatedAt: Date.now(),
  };
  await getRedis().set(instanceKey(config.INSTANCE_ID), JSON.stringify(payload), 'PX', config.INSTANCE_REGISTRY_TTL_MS);
}

export async function resolveInstanceBaseUrl(instanceId: string): Promise<string | null> {
  const raw = await getRedis().get(instanceKey(instanceId));
  if (!raw) return null;
  return (JSON.parse(raw) as InstanceRecord).baseUrl;
}

export function startInstanceRegistry(): void {
  const config = loadConfig();
  if (!config.INSTANCE_BASE_URL) return;
  if (renewTimer) return;
  renewTimer = setInterval(() => {
    registerCurrentInstance().catch((err) => logger.warn({ err, instanceId: config.INSTANCE_ID }, 'Instance registry refresh failed'));
  }, config.INSTANCE_REGISTRY_RENEW_INTERVAL_MS);
  renewTimer.unref();
  void registerCurrentInstance();
}

export async function stopInstanceRegistry(): Promise<void> {
  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
  const config = loadConfig();
  await getRedis().del(instanceKey(config.INSTANCE_ID));
}