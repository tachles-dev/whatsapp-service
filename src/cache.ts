// cache.ts — Per-device in-memory cache for chats, subscriptions, and message deduplication.
// Redis is only touched on startup (bulk load) and on subscription changes (small writes).
import { ChatMetadata } from './types';
import { getRedis } from './redis';
import { logger } from './logger';

export class DeviceCache {
  private chats = new Map<string, ChatMetadata>();
  private subscriptions = new Set<string>();
  // messageId -> expiry timestamp (ms). Avoids all Redis dedup calls.
  private dedupMap = new Map<string, number>();
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private chatsDirty = false;
  private chatFlushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deviceId: string) {}

  private key(suffix: string): string {
    return `wa:${this.deviceId}:${suffix}`;
  }

  async loadFromRedis(): Promise<void> {
    const redis = getRedis();
    const [subs, cachedChats] = await Promise.all([
      redis.smembers(this.key('subscribed')),
      redis.hgetall(this.key('chats')),
    ]);

    this.subscriptions = new Set(subs);
    for (const v of Object.values(cachedChats)) {
      const entry = JSON.parse(v) as ChatMetadata;
      this.chats.set(entry.id, entry);
    }

    logger.info(
      { deviceId: this.deviceId, subscriptions: subs.length, chats: Object.keys(cachedChats).length },
      'Device cache loaded from Redis',
    );

    this.dedupCleanupTimer = setInterval(() => this.cleanupDedup(), 60_000);
    this.chatFlushTimer = setInterval(() => this.flushChats(), 5 * 60_000);
  }

  // ── Deduplication ────────────────────────────────────────────────────────

  isNewMessage(messageId: string): boolean {
    const now = Date.now();
    const expiry = this.dedupMap.get(messageId);
    if (expiry && expiry > now) return false;
    this.dedupMap.set(messageId, now + 300_000);
    return true;
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [id, expiry] of this.dedupMap) {
      if (expiry < now) this.dedupMap.delete(id);
    }
  }

  // ── Subscriptions ────────────────────────────────────────────────────────

  isSubscribed(jid: string): boolean {
    return this.subscriptions.has(jid);
  }

  async subscribe(jid: string): Promise<void> {
    this.subscriptions.add(jid);
    await getRedis().sadd(this.key('subscribed'), jid);
  }

  async unsubscribe(jid: string): Promise<void> {
    this.subscriptions.delete(jid);
    await getRedis().srem(this.key('subscribed'), jid);
  }

  getSubscribed(): string[] {
    return [...this.subscriptions];
  }

  // ── Chat metadata ─────────────────────────────────────────────────────────

  setChat(entry: ChatMetadata): void {
    this.chats.set(entry.id, entry);
    this.chatsDirty = true;
  }

  getChat(jid: string): ChatMetadata | undefined {
    return this.chats.get(jid);
  }

  getChats(query?: string): ChatMetadata[] {
    const all = [...this.chats.values()];
    if (!query) return all;
    const q = query.toLowerCase();
    return all.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.phone && c.phone.includes(q)),
    );
  }

  hasCachedChats(): boolean {
    return this.chats.size > 0;
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  async flushChats(): Promise<void> {
    if (!this.chatsDirty || this.chats.size === 0) return;
    try {
      const redis = getRedis();
      const pipeline = redis.pipeline();
      for (const entry of this.chats.values()) {
        pipeline.hset(this.key('chats'), entry.id, JSON.stringify(entry));
      }
      await pipeline.exec();
      this.chatsDirty = false;
      logger.debug({ deviceId: this.deviceId, count: this.chats.size }, 'Chat cache flushed to Redis');
    } catch (err) {
      logger.warn({ deviceId: this.deviceId, err }, 'Failed to flush chat cache to Redis');
    }
  }

  async deleteFromRedis(): Promise<void> {
    const redis = getRedis();
    await redis.del(this.key('chats'), this.key('subscribed'));
  }

  shutdown(): void {
    if (this.dedupCleanupTimer) clearInterval(this.dedupCleanupTimer);
    if (this.chatFlushTimer) clearInterval(this.chatFlushTimer);
  }
}
