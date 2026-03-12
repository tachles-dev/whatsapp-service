// core/client-config.ts — Per-client runtime configuration, stored in Redis and cached in memory.
import * as crypto from 'crypto';
import { getRedis } from '../redis';
import { logger } from '../logger';
import { ClientConfig } from '../types';
import { loadConfig } from '../config';

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  events: {
    messages: true,
    reactions: true,
    receipts: false,
    groupParticipants: true,
    presenceUpdates: false,
    groupUpdates: true,
    calls: false,
  },
  chats: {
    hideUnnamed: false,
  },
  maxDevices: 5,
};

export type ClientConfigPatch = {
  webhookUrl?: string | null;     // null = clear (revert to global env)
  webhookApiKey?: string | null;  // null = clear
  events?: Partial<ClientConfig['events']>;
  chats?: {
    defaultKind?: 'CONTACT' | 'GROUP' | null; // null = clear (all chats)
    hideUnnamed?: boolean;
  };
  maxDevices?: number;
};

function mergeConfig(base: ClientConfig, patch: ClientConfigPatch): ClientConfig {
  const webhookUrl =
    patch.webhookUrl === null ? undefined : (patch.webhookUrl ?? base.webhookUrl);
  const webhookApiKey =
    patch.webhookApiKey === null ? undefined : (patch.webhookApiKey ?? base.webhookApiKey);

  const result: ClientConfig = {
    events: { ...base.events, ...(patch.events ?? {}) },
    chats: {
      ...base.chats,
      ...(patch.chats ?? {}),
      defaultKind:
        patch.chats?.defaultKind === null
          ? undefined
          : (patch.chats?.defaultKind ?? base.chats.defaultKind),
    },
    maxDevices: patch.maxDevices ?? base.maxDevices,
  };
  if (webhookUrl) result.webhookUrl = webhookUrl;
  if (webhookApiKey) result.webhookApiKey = webhookApiKey;
  return result;
}

class ClientConfigManager {
  private configs = new Map<string, ClientConfig>();

  private key(clientId: string): string {
    return `wa:client:${clientId}:config`;
  }

  /** Sync access — returns defaults if this client's config hasn't been loaded yet. */
  getConfig(clientId: string): ClientConfig {
    return this.configs.get(clientId) ?? DEFAULT_CLIENT_CONFIG;
  }

  /** Load (or reload) config for a client from Redis, caching the result in memory. */
  async loadConfig(clientId: string): Promise<ClientConfig> {
    const raw = await getRedis().get(this.key(clientId));
    const cfg = raw
      ? mergeConfig(DEFAULT_CLIENT_CONFIG, JSON.parse(raw))
      : { ...DEFAULT_CLIENT_CONFIG, events: { ...DEFAULT_CLIENT_CONFIG.events }, chats: { ...DEFAULT_CLIENT_CONFIG.chats } };
    this.configs.set(clientId, cfg);
    return cfg;
  }

  /** Deep-merge a patch into the existing config and persist to Redis. */
  async setConfig(clientId: string, patch: ClientConfigPatch): Promise<ClientConfig> {
    const current = this.configs.get(clientId) ?? DEFAULT_CLIENT_CONFIG;
    const updated = mergeConfig(current, patch);
    await getRedis().set(this.key(clientId), JSON.stringify(updated));
    this.configs.set(clientId, updated);
    logger.info({ clientId }, 'Client config updated');
    return updated;
  }

  /** Remove overrides for a client — reverts to DEFAULT_CLIENT_CONFIG. */
  async resetConfig(clientId: string): Promise<void> {
    await getRedis().del(this.key(clientId));
    this.configs.delete(clientId);
    logger.info({ clientId }, 'Client config reset to defaults');
  }

  /** Internal: directly overwrite the in-memory config (used by key management). */
  _setRaw(clientId: string, cfg: ClientConfig): void {
    this.configs.set(clientId, cfg);
  }
}

export const clientConfigManager = new ClientConfigManager();

// ── Key management ────────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 of a plaintext key using KEY_SECRET.
 * Without KEY_SECRET, stored hashes reveal nothing even if Redis is compromised.
 */
function hashKey(plaintext: string): string {
  return crypto.createHmac('sha256', loadConfig().KEY_SECRET).update(plaintext).digest('hex');
}

/** Persist a config object to Redis and update the in-memory cache. */
async function persistConfig(clientId: string, cfg: ClientConfig): Promise<void> {
  await getRedis().set(`wa:client:${clientId}:config`, JSON.stringify(cfg));
  clientConfigManager._setRaw(clientId, cfg);
}

/**
 * Returns a safe view of the config for API responses.
 * Strips the raw hash; exposes key metadata (expiry, last-used) instead.
 */
export function safeConfig(cfg: ClientConfig): object {
  const { apiKeyHash, apiKeyExpiresAt, apiKeyLastUsedAt, apiKeyLastUsedIp, ...rest } = cfg;
  return {
    ...rest,
    key: {
      hasKey: !!apiKeyHash,
      ...(apiKeyExpiresAt  !== undefined && { expiresAt:  apiKeyExpiresAt }),
      ...(apiKeyLastUsedAt !== undefined && { lastUsedAt: apiKeyLastUsedAt }),
      ...(apiKeyLastUsedIp !== undefined && { lastUsedIp: apiKeyLastUsedIp }),
    },
  };
}

/**
 * Generate a new API key for a client.
 * Stores only the HMAC hash + expiry. Returns the plaintext key ONCE — it is never stored.
 * @param ttlDays How many days until the key expires (default 90, max 365).
 */
export async function generateClientKey(clientId: string, ttlDays = 90): Promise<string> {
  const days = Math.min(Math.max(ttlDays, 1), 365);
  const plaintext = crypto.randomBytes(32).toString('hex');
  const current = clientConfigManager.getConfig(clientId);
  const updated: ClientConfig = {
    ...current,
    apiKeyHash: hashKey(plaintext),
    apiKeyExpiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
  };
  delete updated.apiKeyLastUsedAt;
  delete updated.apiKeyLastUsedIp;
  await persistConfig(clientId, updated);
  logger.info({ clientId, days, expiresAt: updated.apiKeyExpiresAt }, 'Client API key generated');
  return plaintext;
}

/**
 * Verify a provided plaintext key against the stored hash.
 * Checks HMAC match AND expiry. On success, updates last-used metadata.
 * Returns true if the key is valid and not expired.
 */
export async function verifyClientKey(clientId: string, plaintext: string, ip?: string): Promise<boolean> {
  const cfg = clientConfigManager.getConfig(clientId);
  if (!cfg.apiKeyHash || !cfg.apiKeyExpiresAt) return false;
  if (Date.now() > cfg.apiKeyExpiresAt) return false;

  const provided = hashKey(plaintext);
  // Both strings are hex digests of the same HMAC, so lengths are always equal.
  // timingSafeEqual guards against timing-based hash oracle attacks.
  const match = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(cfg.apiKeyHash));
  if (!match) return false;

  // Update last-used metadata asynchronously — do not let Redis errors block auth.
  const updated: ClientConfig = { ...cfg, apiKeyLastUsedAt: Date.now(), apiKeyLastUsedIp: ip };
  persistConfig(clientId, updated).catch((err) =>
    logger.warn({ clientId, err }, 'Failed to update key last-used metadata'),
  );
  return true;
}

/**
 * Rotate a client's key using their current valid key.
 * The old key is invalidated immediately; the new plaintext is returned once.
 * Returns null if the current key is invalid or expired (master key needed to re-issue).
 */
export async function rotateClientKey(clientId: string, currentPlaintext: string, ttlDays = 90): Promise<string | null> {
  const cfg = clientConfigManager.getConfig(clientId);
  if (!cfg.apiKeyHash || !cfg.apiKeyExpiresAt) return null;
  if (Date.now() > cfg.apiKeyExpiresAt) return null;

  const provided = hashKey(currentPlaintext);
  const match = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(cfg.apiKeyHash));
  if (!match) return null;

  return generateClientKey(clientId, ttlDays);
}

/** Revoke a client's API key immediately. Any in-flight requests will still complete. */
export async function revokeClientKey(clientId: string): Promise<void> {
  const current = clientConfigManager.getConfig(clientId);
  const updated: ClientConfig = { ...current };
  delete updated.apiKeyHash;
  delete updated.apiKeyExpiresAt;
  delete updated.apiKeyLastUsedAt;
  delete updated.apiKeyLastUsedIp;
  await persistConfig(clientId, updated);
  logger.info({ clientId }, 'Client API key revoked');
}
