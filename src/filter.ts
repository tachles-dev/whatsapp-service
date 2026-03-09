// filter.ts
import { loadConfig } from './config';
import { logger } from './logger';
import { getRedis } from './redis';

/**
 * Check if a JID is in the allowed contacts list.
 * If ALLOWED_CONTACTS is empty, all contacts are allowed.
 */
export function isAllowedContact(jid: string): boolean {
  const { ALLOWED_CONTACTS } = loadConfig();
  if (ALLOWED_CONTACTS.length === 0) return true;
  return ALLOWED_CONTACTS.includes(jid);
}

/**
 * Deduplicate messages using Redis SETNX with 5-minute expiry.
 * Returns true if the message is new (should be processed).
 */
export async function isNewMessage(messageId: string): Promise<boolean> {
  const redis = getRedis();
  const key = `dedup:${messageId}`;
  const result = await redis.set(key, '1', 'EX', 300, 'NX');
  if (result === 'OK') {
    return true;
  }
  logger.debug({ messageId }, 'Duplicate message filtered');
  return false;
}
