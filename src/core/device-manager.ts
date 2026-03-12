// core/device-manager.ts — Manages all per-client WhatsApp device instances.
import * as fs from 'fs/promises';
import * as path from 'path';
import { BaileysAdapter } from '../adapters/baileys';
import { DeviceCache } from './cache';
import { DeviceInfo, IWhatsAppAdapter } from '../types';
import { getRedis } from '../redis';
import { loadConfig } from '../config';
import { logger } from '../logger';
import { clientConfigManager } from './client-config';

const MAX_DEVICES_PER_CLIENT = 5;
void MAX_DEVICES_PER_CLIENT; // used via clientConfig.maxDevices

interface StoredDeviceInfo extends DeviceInfo {
  clientId: string;
}

class DeviceManager {
  private managers = new Map<string, IWhatsAppAdapter>();
  private caches = new Map<string, DeviceCache>();
  private infos = new Map<string, StoredDeviceInfo>();

  // ── Redis key helpers ──────────────────────────────────────────────────────

  private deviceRedisKey(deviceId: string): string {
    return `wa:device:${deviceId}`;
  }

  private clientDevicesKey(clientId: string): string {
    return `wa:client:${clientId}:devices`;
  }

  private bannedKey(clientId: string): string {
    return `wa:client:${clientId}:banned`;
  }

  private allowedKey(clientId: string): string {
    return `wa:client:${clientId}:allowed`;
  }

  // ── Phone access control ───────────────────────────────────────────────────

  /**
   * Called by BaileysAdapter when a QR scan succeeds and a phone connects.
   * Returns true if the phone is permitted; false if the device should be
   * immediately disconnected (banned or outside allowlist).
   * Also persists the phone number to the device's stored info.
   */
  private async handlePhoneConnected(
    clientId: string,
    deviceId: string,
    phone: string,
  ): Promise<boolean> {
    const redis = getRedis();
    const [isBanned, allowedSet] = await Promise.all([
      redis.sismember(this.bannedKey(clientId), phone),
      redis.smembers(this.allowedKey(clientId)),
    ]);

    if (isBanned) {
      logger.warn({ clientId, deviceId, phone }, 'Banned phone attempted to connect — disconnecting');
      return false;
    }

    if (allowedSet.length > 0 && !allowedSet.includes(phone)) {
      logger.warn({ clientId, deviceId, phone }, 'Phone not in allowlist — disconnecting');
      return false;
    }

    // Persist phone to device info
    const info = this.infos.get(deviceId);
    if (info && info.phone !== phone) {
      info.phone = phone;
      await redis.set(this.deviceRedisKey(deviceId), JSON.stringify(info));
    }

    return true;
  }

  private attachPhoneVerifier(manager: IWhatsAppAdapter, clientId: string, deviceId: string): void {
    manager.setPhoneVerifier((phone) => this.handlePhoneConnected(clientId, deviceId, phone));
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Called once on startup — restores all previously registered devices. */
  async loadFromRedis(): Promise<void> {
    const redis = getRedis();
    const config = loadConfig();

    const keys = await redis.keys('wa:device:*');
    await Promise.all(
      keys.map(async (key) => {
        const raw = await redis.get(key);
        if (!raw) return;
        const info: StoredDeviceInfo = JSON.parse(raw);
        const authDir = path.join(config.AUTH_BASE_DIR, info.id);
        await fs.mkdir(authDir, { recursive: true });

        const cache = new DeviceCache(info.id);
        await cache.loadFromRedis();

        const manager = new BaileysAdapter(info.id, info.clientId, authDir, cache);
        this.attachPhoneVerifier(manager, info.clientId, info.id);

        this.infos.set(info.id, info);
        this.caches.set(info.id, cache);
        this.managers.set(info.id, manager);

        manager.start().catch((err) =>
          logger.error({ err, deviceId: info.id }, 'Failed to start device on load'),
        );
      }),
    );

    logger.info({ count: this.managers.size }, 'Devices loaded from Redis');

    // Preload per-client configs for all known clients
    const uniqueClientIds = [...new Set([...this.infos.values()].map((i) => i.clientId))];
    await Promise.all(uniqueClientIds.map((cid) => clientConfigManager.loadConfig(cid)));
  }

  /** Register a new device for a client. Returns the new device info. */
  async createDevice(clientId: string, name: string): Promise<StoredDeviceInfo> {
    const existing = this.getClientInfos(clientId);
    const cfg = clientConfigManager.getConfig(clientId);
    if (existing.length >= cfg.maxDevices) {
      throw new Error(`Max ${cfg.maxDevices} devices per client reached`);
    }

    const config = loadConfig();
    const deviceId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const authDir = path.join(config.AUTH_BASE_DIR, deviceId);
    await fs.mkdir(authDir, { recursive: true });

    const info: StoredDeviceInfo = { id: deviceId, clientId, name, createdAt: Date.now(), phone: null };

    const redis = getRedis();
    await Promise.all([
      redis.set(this.deviceRedisKey(deviceId), JSON.stringify(info)),
      redis.sadd(this.clientDevicesKey(clientId), deviceId),
    ]);

    const cache = new DeviceCache(deviceId);
    await cache.loadFromRedis();

    // Ensure this client's config is in memory (no-op if already loaded)
    await clientConfigManager.loadConfig(clientId);

    const manager = new BaileysAdapter(deviceId, clientId, authDir, cache);
    this.attachPhoneVerifier(manager, clientId, deviceId);

    this.infos.set(deviceId, info);
    this.caches.set(deviceId, cache);
    this.managers.set(deviceId, manager);

    manager.start().catch((err) =>
      logger.error({ err, deviceId }, 'Failed to start new device'),
    );

    logger.info({ deviceId, clientId, name }, 'Device created');
    return info;
  }

  /** Remove a device, stop its connection, clean up Redis and auth files. */
  async removeDevice(clientId: string, deviceId: string): Promise<void> {
    this.assertOwnership(clientId, deviceId);
    const config = loadConfig();

    const manager = this.managers.get(deviceId);
    if (manager) await manager.close();

    const cache = this.caches.get(deviceId);
    if (cache) {
      cache.shutdown();
      await cache.deleteFromRedis();
    }

    const redis = getRedis();
    await Promise.all([
      redis.del(this.deviceRedisKey(deviceId)),
      redis.srem(this.clientDevicesKey(clientId), deviceId),
    ]);

    const authDir = path.join(config.AUTH_BASE_DIR, deviceId);
    await fs.rm(authDir, { recursive: true, force: true });

    this.managers.delete(deviceId);
    this.caches.delete(deviceId);
    this.infos.delete(deviceId);

    logger.info({ deviceId, clientId }, 'Device removed');
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  getManager(deviceId: string): IWhatsAppAdapter | undefined {
    return this.managers.get(deviceId);
  }

  getInfo(deviceId: string): StoredDeviceInfo | undefined {
    return this.infos.get(deviceId);
  }

  getClientInfos(clientId: string): StoredDeviceInfo[] {
    return [...this.infos.values()].filter((i) => i.clientId === clientId);
  }

  getAllInfos(): StoredDeviceInfo[] {
    return [...this.infos.values()];
  }

  /** Throws if device doesn't belong to this client. Returns the adapter. */
  assertManager(clientId: string, deviceId: string): IWhatsAppAdapter {
    this.assertOwnership(clientId, deviceId);
    const manager = this.managers.get(deviceId);
    if (!manager) throw new Error('Device manager not found');
    return manager;
  }

  /**
   * Wipe the in-memory + Redis chat cache for a device so it is rebuilt from
   * scratch on the next Baileys connection (contacts.upsert / messaging-history.set).
   * Does NOT disconnect the device.
   */
  async flushChatCache(clientId: string, deviceId: string): Promise<void> {
    this.assertOwnership(clientId, deviceId);
    const cache = this.caches.get(deviceId);
    if (!cache) throw new Error('Cache not found for device');
    await cache.clearChats();
    logger.info({ clientId, deviceId }, 'Chat cache flushed');
  }

  /**
   * Resolve a batch of JIDs (possibly LIDs) to their canonical phone JIDs.
   * Returns a map of input JID → resolved phone JID, or null if unknown.
   */
  resolveLids(clientId: string, deviceId: string, jids: string[]): Record<string, string | null> {
    this.assertOwnership(clientId, deviceId);
    const cache = this.caches.get(deviceId);
    if (!cache) throw new Error('Cache not found for device');
    return cache.resolveLidBulk(jids);
  }

  private assertOwnership(clientId: string, deviceId: string): void {
    const info = this.infos.get(deviceId);
    if (!info || info.clientId !== clientId) {
      throw new Error('Device not found or access denied');
    }
  }

  // ── Ban list ───────────────────────────────────────────────────────────────

  async getBannedNumbers(clientId: string): Promise<string[]> {
    return getRedis().smembers(this.bannedKey(clientId));
  }

  /**
   * Ban a phone number. Any currently connected device using that number is
   * immediately disconnected (auth files kept — user must reconnect via QR if
   * they want to use a different number).
   */
  async addBannedNumber(clientId: string, phone: string): Promise<void> {
    await getRedis().sadd(this.bannedKey(clientId), phone);

    // Disconnect any live device already using this phone
    for (const info of this.infos.values()) {
      if (info.clientId === clientId && info.phone === phone) {
        const manager = this.managers.get(info.id);
        if (manager) {
          await manager.close();
          logger.info({ clientId, deviceId: info.id, phone }, 'Device disconnected due to newly banned number');
        }
      }
    }
  }

  async removeBannedNumber(clientId: string, phone: string): Promise<void> {
    await getRedis().srem(this.bannedKey(clientId), phone);
  }

  // ── Allow list ─────────────────────────────────────────────────────────────

  /**
   * Returns the allowlist. Empty list = all numbers permitted (open mode).
   * Non-empty = only listed numbers may connect.
   */
  async getAllowedNumbers(clientId: string): Promise<string[]> {
    return getRedis().smembers(this.allowedKey(clientId));
  }

  async addAllowedNumber(clientId: string, phone: string): Promise<void> {
    await getRedis().sadd(this.allowedKey(clientId), phone);
  }

  /**
   * Remove a number from the allowlist. If the allowlist is still non-empty
   * afterward, connected devices using the removed number are disconnected.
   */
  async removeAllowedNumber(clientId: string, phone: string): Promise<void> {
    const redis = getRedis();
    await redis.srem(this.allowedKey(clientId), phone);
    const remaining = await redis.smembers(this.allowedKey(clientId));

    if (remaining.length > 0) {
      for (const info of this.infos.values()) {
        if (info.clientId === clientId && info.phone === phone) {
          const manager = this.managers.get(info.id);
          if (manager) {
            await manager.close();
            logger.info({ clientId, deviceId: info.id, phone }, 'Device disconnected — removed from allowlist');
          }
        }
      }
    }
  }

  // ── Batch lifecycle ────────────────────────────────────────────────────────

  async flushAll(): Promise<void> {
    await Promise.all([...this.caches.values()].map((c) => c.flushChats()));
  }

  async shutdownAll(): Promise<void> {
    await this.flushAll();
    for (const cache of this.caches.values()) cache.shutdown();
    await Promise.all([...this.managers.values()].map((m) => m.close()));
  }
}

export const deviceManager = new DeviceManager();
