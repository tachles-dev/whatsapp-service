import { getRedis } from './redis';
import { loadConfig } from './config';

const AUDIT_LOG_KEY = 'wa:audit:events';
const AUDIT_LOG_MAX = 1000;

export interface AuditEvent {
  id: string;
  timestamp: number;
  action: string;
  actorType: 'admin-session' | 'master-key' | 'client-key' | 'system';
  actorId: string;
  ip: string | null;
  clientId?: string;
  deviceId?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAuditEvent(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void> {
  if (!loadConfig().modules.audit) return;
  const payload: AuditEvent = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    ...event,
  };

  const redis = getRedis();
  const multi = redis.multi();
  multi.lpush(AUDIT_LOG_KEY, JSON.stringify(payload));
  multi.ltrim(AUDIT_LOG_KEY, 0, AUDIT_LOG_MAX - 1);
  await multi.exec();
}

export async function listAuditEvents(limit = 100): Promise<AuditEvent[]> {
  if (!loadConfig().modules.audit) return [];
  const rows = await getRedis().lrange(AUDIT_LOG_KEY, 0, Math.max(0, limit - 1));
  return rows.map((row) => JSON.parse(row) as AuditEvent);
}