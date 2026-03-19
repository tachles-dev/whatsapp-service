// core/device-manager.ts — Manages all per-client WhatsApp device instances.
import * as fs from 'fs/promises';
import * as path from 'path';
import { BaileysAdapter } from '../adapters/baileys';
import { DeviceCache } from './cache';
import { DeviceInfo, ErrorCode, IWhatsAppAdapter } from '../types';
import { getRedis } from '../redis';
import { loadConfig } from '../config';
import { logger } from '../logger';
import { clientConfigManager } from './client-config';
import { AppError } from '../errors';
import { clientMetadataManager } from './client-metadata';

const MAX_DEVICES_PER_CLIENT = 5;
void MAX_DEVICES_PER_CLIENT; // used via clientConfig.maxDevices

interface StoredDeviceInfo extends DeviceInfo {
  clientId: string;
}

class DeviceManager {
  private managers = new Map<string, IWhatsAppAdapter>();
  private caches = new Map<string, DeviceCache>();
  private infos = new Map<string, StoredDeviceInfo>();
  private clientDeviceIds = new Map<string, Set<string>>();
  private ownedDeviceIds = new Set<string>();
  private leaseRenewTimer: ReturnType<typeof setInterval> | null = null;
  private leaseReconcileTimer: ReturnType<typeof setInterval> | null = null;

  // ── Redis key helpers ──────────────────────────────────────────────────────

  private deviceRedisKey(deviceId: string): string {
    return `wa:device:${deviceId}`;
  }

  private clientDevicesKey(clientId: string): string {
    return `wa:client:${clientId}:devices`;
  }

  private allDevicesKey(): string {
    return 'wa:devices';
  }

  private deviceLeaseKey(deviceId: string): string {
    return `wa:device:${deviceId}:lease`;
  }

  private clientsKey(): string {
    return 'wa:clients';
  }

  private bannedKey(clientId: string): string {
    return `wa:client:${clientId}:banned`;
  }

  private allowedKey(clientId: string): string {
    return `wa:client:${clientId}:allowed`;
  }

  private trackClientDevice(clientId: string, deviceId: string): void {
    const existing = this.clientDeviceIds.get(clientId);
    if (existing) {
      existing.add(deviceId);
      return;
    }
    this.clientDeviceIds.set(clientId, new Set([deviceId]));
  }

  private untrackClientDevice(clientId: string, deviceId: string): void {
    const existing = this.clientDeviceIds.get(clientId);
    if (!existing) return;
    existing.delete(deviceId);
    if (existing.size === 0) this.clientDeviceIds.delete(clientId);
  }

  private async claimLease(deviceId: string): Promise<boolean> {
    if (!loadConfig().modules.multiInstanceLeasing) return true;
    const redis = getRedis();
    const config = loadConfig();
    const currentOwner = await redis.get(this.deviceLeaseKey(deviceId));
    if (currentOwner === config.INSTANCE_ID) {
      await redis.pexpire(this.deviceLeaseKey(deviceId), config.DEVICE_LEASE_TTL_MS);
      return true;
    }
    const claimed = await redis.set(this.deviceLeaseKey(deviceId), config.INSTANCE_ID, 'PX', config.DEVICE_LEASE_TTL_MS, 'NX');
    return claimed === 'OK';
  }

  private async releaseLease(deviceId: string): Promise<void> {
    if (!loadConfig().modules.multiInstanceLeasing) return;
    const redis = getRedis();
    const key = this.deviceLeaseKey(deviceId);
    const config = loadConfig();
    const currentOwner = await redis.get(key);
    if (currentOwner === config.INSTANCE_ID) {
      await redis.del(key);
    }
  }

  private async ensureLocalDevice(info: StoredDeviceInfo): Promise<IWhatsAppAdapter> {
    const existing = this.managers.get(info.id);
    if (existing) return existing;

    const config = loadConfig();
    const authDir = path.join(config.AUTH_BASE_DIR, info.id);
    await fs.mkdir(authDir, { recursive: true });

    const cache = new DeviceCache(info.id);
    await cache.loadFromRedis();

    const manager = new BaileysAdapter(info.id, info.clientId, authDir, cache);
    this.attachPhoneVerifier(manager, info.clientId, info.id);
    this.caches.set(info.id, cache);
    this.managers.set(info.id, manager);
    return manager;
  }

  private async shutdownLocalDevice(deviceId: string): Promise<void> {
    const manager = this.managers.get(deviceId);
    if (manager) await manager.close();
    const cache = this.caches.get(deviceId);
    if (cache) cache.shutdown();
    this.managers.delete(deviceId);
    this.caches.delete(deviceId);
    this.ownedDeviceIds.delete(deviceId);
  }

  private startLeaseMaintenance(): void {
    if (!loadConfig().modules.multiInstanceLeasing) return;
    if (!this.leaseRenewTimer) {
      this.leaseRenewTimer = setInterval(() => {
        void this.renewLeases();
      }, loadConfig().DEVICE_LEASE_RENEW_INTERVAL_MS);
      this.leaseRenewTimer.unref();
    }
    if (!this.leaseReconcileTimer) {
      this.leaseReconcileTimer = setInterval(() => {
        void this.reconcileLeases();
      }, loadConfig().DEVICE_LEASE_RECONCILE_INTERVAL_MS);
      this.leaseReconcileTimer.unref();
    }
  }

  private stopLeaseMaintenance(): void {
    if (this.leaseRenewTimer) {
      clearInterval(this.leaseRenewTimer);
      this.leaseRenewTimer = null;
    }
    if (this.leaseReconcileTimer) {
      clearInterval(this.leaseReconcileTimer);
      this.leaseReconcileTimer = null;
    }
  }

  private async renewLeases(): Promise<void> {
    for (const deviceId of [...this.ownedDeviceIds]) {
      const stillOwned = await this.claimLease(deviceId);
      if (!stillOwned) {
        logger.warn({ deviceId, instanceId: loadConfig().INSTANCE_ID }, 'Lost device lease to another instance; shutting down local manager');
        await this.shutdownLocalDevice(deviceId);
      }
    }
  }

  private async reconcileLeases(): Promise<void> {
    const config = loadConfig();
    if (!config.modules.multiInstanceLeasing) {
      const deviceInfos = [...this.infos.values()].filter((info) => !this.ownedDeviceIds.has(info.id));
      for (let index = 0; index < deviceInfos.length; index += config.DEVICE_START_BATCH_SIZE) {
        const batch = deviceInfos.slice(index, index + config.DEVICE_START_BATCH_SIZE);
        await Promise.all(batch.map(async (info) => {
          try {
            const manager = await this.ensureLocalDevice(info);
            this.ownedDeviceIds.add(info.id);
            await manager.start();
          } catch (err) {
            logger.error({ err, deviceId: info.id }, 'Failed to start device without leasing');
          }
        }));
        if (index + config.DEVICE_START_BATCH_SIZE < deviceInfos.length && config.DEVICE_START_BATCH_DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, config.DEVICE_START_BATCH_DELAY_MS));
        }
      }
      return;
    }
    const deviceInfos = [...this.infos.values()].filter((info) => !this.ownedDeviceIds.has(info.id));
    for (let index = 0; index < deviceInfos.length; index += config.DEVICE_START_BATCH_SIZE) {
      const batch = deviceInfos.slice(index, index + config.DEVICE_START_BATCH_SIZE);
      await Promise.all(batch.map(async (info) => {
        const claimed = await this.claimLease(info.id);
        if (!claimed) return;
        try {
          const manager = await this.ensureLocalDevice(info);
          this.ownedDeviceIds.add(info.id);
          await manager.start();
          logger.info({ deviceId: info.id, clientId: info.clientId, instanceId: config.INSTANCE_ID }, 'Device lease claimed and manager started');
        } catch (err) {
          this.ownedDeviceIds.delete(info.id);
          logger.error({ err, deviceId: info.id }, 'Failed to start claimed device');
        }
      }));

      if (index + config.DEVICE_START_BATCH_SIZE < deviceInfos.length && config.DEVICE_START_BATCH_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.DEVICE_START_BATCH_DELAY_MS));
      }
    }
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

    let deviceIds = await redis.smembers(this.allDevicesKey());
    if (deviceIds.length === 0) {
      const legacyKeys = await redis.keys('wa:device:*');
      deviceIds = legacyKeys.map((key) => key.slice('wa:device:'.length));
      if (deviceIds.length > 0) {
        await redis.sadd(this.allDevicesKey(), ...deviceIds);
      }
    }

    const infos = (await redis.mget(deviceIds.map((deviceId) => this.deviceRedisKey(deviceId))))
      .filter((raw): raw is string => !!raw)
      .map((raw) => JSON.parse(raw) as StoredDeviceInfo);

    for (const info of infos) {
      this.infos.set(info.id, info);
      this.trackClientDevice(info.clientId, info.id);
    }

    await this.reconcileLeases();
    this.startLeaseMaintenance();

    logger.info({ count: this.infos.size, owned: this.ownedDeviceIds.size, instanceId: config.INSTANCE_ID }, 'Devices loaded from Redis');

    // Preload per-client configs for all known clients
    const uniqueClientIds = [...new Set([...this.infos.values()].map((i) => i.clientId))];
    await Promise.all(uniqueClientIds.map((cid) => clientConfigManager.loadConfig(cid)));
    await Promise.all(uniqueClientIds.map((cid) => clientMetadataManager.load(cid)));
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
      redis.sadd(this.allDevicesKey(), deviceId),
      redis.sadd(this.clientsKey(), clientId),
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
    this.ownedDeviceIds.add(deviceId);
    this.trackClientDevice(clientId, deviceId);
    await this.claimLease(deviceId);
    this.startLeaseMaintenance();

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
      redis.srem(this.allDevicesKey(), deviceId),
      redis.del(this.deviceLeaseKey(deviceId)),
    ]);

    const remainingClientDevices = await redis.scard(this.clientDevicesKey(clientId));
    if (remainingClientDevices === 0) {
      await redis.srem(this.clientsKey(), clientId);
    }

    const authDir = path.join(config.AUTH_BASE_DIR, deviceId);
    await fs.rm(authDir, { recursive: true, force: true });

    this.managers.delete(deviceId);
    this.caches.delete(deviceId);
    this.infos.delete(deviceId);
    this.ownedDeviceIds.delete(deviceId);
    this.untrackClientDevice(clientId, deviceId);

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
    const deviceIds = this.clientDeviceIds.get(clientId);
    if (!deviceIds) return [];
    return [...deviceIds].map((deviceId) => this.infos.get(deviceId)).filter((info): info is StoredDeviceInfo => !!info);
  }

  getAllInfos(): StoredDeviceInfo[] {
    return [...this.infos.values()];
  }

  getClientIds(): string[] {
    return [...this.clientDeviceIds.keys()];
  }

  isOwnedLocally(deviceId: string): boolean {
    return this.ownedDeviceIds.has(deviceId);
  }

  async getOwnerInstanceId(deviceId: string): Promise<string | null> {
    if (!this.infos.has(deviceId)) return null;
    if (!loadConfig().modules.multiInstanceLeasing) {
      return loadConfig().INSTANCE_ID;
    }
    return getRedis().get(this.deviceLeaseKey(deviceId));
  }

  /** Throws if device doesn't belong to this client. Returns the adapter. */
  assertManager(clientId: string, deviceId: string): IWhatsAppAdapter {
    this.assertOwnership(clientId, deviceId);
    const manager = this.managers.get(deviceId);
    if (!manager) {
      throw new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        `Device ${deviceId} is owned by another instance or still recovering`,
        503,
        true,
      );
    }
    return manager;
  }

  /**
   * Wipe the in-memory + Redis chat cache for a device, then reconnect so Baileys
   * replays contacts.upsert / messaging-history.set and rebuilds the cache.
   */
  async flushChatCache(clientId: string, deviceId: string): Promise<void> {
    this.assertOwnership(clientId, deviceId);
    const cache = this.caches.get(deviceId);
    if (!cache) throw new Error('Cache not found for device');
    await cache.clearChats();
    // Reconnect so Baileys re-fires contacts.upsert and messaging-history.set.
    // Without reconnecting, those events won't fire again on an already-open socket.
    const manager = this.managers.get(deviceId);
    if (manager) {
      manager.start().catch((err) => logger.error({ err, deviceId }, 'Reconnect after cache flush failed'));
    }
    logger.info({ clientId, deviceId }, 'Chat cache flushed — reconnecting to rebuild contact cache');
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
    this.stopLeaseMaintenance();
    await this.flushAll();
    for (const cache of this.caches.values()) cache.shutdown();
    await Promise.all([...this.managers.values()].map((m) => m.close()));
    await Promise.all([...this.ownedDeviceIds].map((deviceId) => this.releaseLease(deviceId)));
    this.ownedDeviceIds.clear();
  }
}

export const deviceManager = new DeviceManager();
