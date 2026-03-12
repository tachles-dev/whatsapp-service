// core/cache.ts — Per-device in-memory cache for chats, subscriptions, and message deduplication.
// Redis is only touched on startup (bulk load) and on subscription changes (small writes).
import { ChatMetadata } from '../types';
import { getRedis } from '../redis';
import { logger } from '../logger';

export class DeviceCache {
  private chats = new Map<string, ChatMetadata>();
  private subscriptions = new Set<string>();
  // messageId -> expiry timestamp (ms). Avoids all Redis dedup calls.
  private dedupMap = new Map<string, number>();
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;
  // Track only the IDs of chats that changed — avoids rewriting all chats on every flush
  private dirtyChatIds = new Set<string>();
  private chatFlushTimer: ReturnType<typeof setInterval> | null = null;
  // LID → phone JID mapping (e.g. '123@lid' → '972501234567@s.whatsapp.net')
  private lidMap = new Map<string, string>();

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
    // Flush every 15min instead of 5min — reduces Redis writes 3x
    this.chatFlushTimer = setInterval(() => this.flushChats(), 15 * 60_000);
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

  // ── LID resolution ─────────────────────────────────────────────────────

  /**
   * Store a LID → phone JID mapping. Safe to call repeatedly; a no-op if lid is falsy.
   */
  setLid(lid: string, phoneJid: string): void {
    if (lid) this.lidMap.set(lid, phoneJid);
  }

  /**
   * Resolve a JID that may be a LID to a phone JID.
   * If jid ends with @lid and we have a mapping, returns the phone JID.
   * Otherwise returns the original jid unchanged.
   */
  resolveLid(jid: string): string {
    if (!jid.endsWith('@lid')) return jid;
    return this.lidMap.get(jid) ?? jid;
  }

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
    this.dirtyChatIds.add(entry.id);
  }

  getChat(jid: string): ChatMetadata | undefined {
    return this.chats.get(jid);
  }

  getChats(query?: string, kind?: 'CONTACT' | 'GROUP', hideUnnamed?: boolean): ChatMetadata[] {
    const q = query ? query.toLowerCase() : null;

    // Single pass: apply all three filter conditions at once to avoid intermediate arrays.
    const results: Array<{ chat: ChatMetadata; isNamed: boolean }> = [];
    for (const c of this.chats.values()) {
      if (kind === 'CONTACT' && c.isGroup) continue;
      if (kind === 'GROUP' && !c.isGroup) continue;

      // Compute once per entry — reused for both hideUnnamed and sort key.
      const rawId = c.id.includes('@') ? c.id.slice(0, c.id.indexOf('@')) : c.id;
      const isNamed = c.name !== rawId && c.name !== c.phone;

      if (hideUnnamed && !isNamed) continue;

      if (q !== null) {
        const nameLower = c.name.toLowerCase();
        const notifyLower = c.notify ? c.notify.toLowerCase() : null;
        if (
          !nameLower.includes(q) &&
          !(notifyLower && notifyLower.includes(q)) &&
          !(c.phone && c.phone.includes(q))
        ) continue;
      }

      results.push({ chat: c, isNamed });
    }

    if (q !== null) {
      // Named contacts (saved name ≠ raw JID/phone) rank before unnamed/LID-only entries.
      // isNamed is pre-computed so no extra work inside the comparator.
      results.sort((a, b) => {
        if (a.isNamed !== b.isNamed) return a.isNamed ? -1 : 1;
        return a.chat.name.localeCompare(b.chat.name);
      });
    }

    return results.map((r) => r.chat);
  }

  hasCachedChats(): boolean {
    return this.chats.size > 0;
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  async flushChats(): Promise<void> {
    if (this.dirtyChatIds.size === 0) return;
    try {
      const redis = getRedis();
      const pipeline = redis.pipeline();
      for (const id of this.dirtyChatIds) {
        const entry = this.chats.get(id);
        if (entry) pipeline.hset(this.key('chats'), id, JSON.stringify(entry));
      }
      await pipeline.exec();
      logger.debug({ deviceId: this.deviceId, count: this.dirtyChatIds.size }, 'Chat cache flushed to Redis');
      this.dirtyChatIds.clear();
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
