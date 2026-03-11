// core/client-config.ts — Per-client runtime configuration, stored in Redis and cached in memory.
import { getRedis } from '../redis';
import { logger } from '../logger';
import { ClientConfig } from '../types';

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
}

export const clientConfigManager = new ClientConfigManager();
