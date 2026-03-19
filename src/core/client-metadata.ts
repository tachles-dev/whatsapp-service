import { getRedis } from '../redis';
import { logger } from '../logger';
import { ClientMetadata } from '../types';
import { loadConfig } from '../config';
import { AppError } from '../errors';
import { ErrorCode } from '../types';

export const DEFAULT_CLIENT_METADATA: ClientMetadata = {
  status: 'active',
  tags: [],
  limits: {},
};

export type ClientMetadataPatch = {
  status?: ClientMetadata['status'];
  externalRef?: string | null;
  notes?: string | null;
  tags?: string[];
  plan?: {
    code?: string | null;
    name?: string | null;
    storageSoftLimitMb?: number | null;
  };
  contact?: {
    companyName?: string | null;
    personName?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  limits?: {
    clientSendsPerWindow?: number | null;
    deviceSendsPerWindow?: number | null;
  };
};

export type ClientLifecycleStatus = ClientMetadata['status'];

function key(clientId: string): string {
  return `wa:client:${clientId}:metadata`;
}

function mergeMetadata(base: ClientMetadata, patch: ClientMetadataPatch): ClientMetadata {
  return {
    status: patch.status ?? base.status,
    externalRef: patch.externalRef === null ? undefined : (patch.externalRef ?? base.externalRef),
    notes: patch.notes === null ? undefined : (patch.notes ?? base.notes),
    tags: patch.tags ?? base.tags,
    plan: {
      code: patch.plan?.code === null ? undefined : (patch.plan?.code ?? base.plan?.code),
      name: patch.plan?.name === null ? undefined : (patch.plan?.name ?? base.plan?.name),
      storageSoftLimitMb: patch.plan?.storageSoftLimitMb === null ? undefined : (patch.plan?.storageSoftLimitMb ?? base.plan?.storageSoftLimitMb),
    },
    contact: {
      companyName: patch.contact?.companyName === null ? undefined : (patch.contact?.companyName ?? base.contact?.companyName),
      personName: patch.contact?.personName === null ? undefined : (patch.contact?.personName ?? base.contact?.personName),
      email: patch.contact?.email === null ? undefined : (patch.contact?.email ?? base.contact?.email),
      phone: patch.contact?.phone === null ? undefined : (patch.contact?.phone ?? base.contact?.phone),
    },
    limits: {
      clientSendsPerWindow: patch.limits?.clientSendsPerWindow === null ? undefined : (patch.limits?.clientSendsPerWindow ?? base.limits?.clientSendsPerWindow),
      deviceSendsPerWindow: patch.limits?.deviceSendsPerWindow === null ? undefined : (patch.limits?.deviceSendsPerWindow ?? base.limits?.deviceSendsPerWindow),
    },
  };
}

class ClientMetadataManager {
  private cache = new Map<string, ClientMetadata>();

  get(clientId: string): ClientMetadata {
    return this.cache.get(clientId) ?? DEFAULT_CLIENT_METADATA;
  }

  async load(clientId: string): Promise<ClientMetadata> {
    const raw = await getRedis().get(key(clientId));
    const metadata = raw
      ? mergeMetadata(DEFAULT_CLIENT_METADATA, JSON.parse(raw) as ClientMetadataPatch)
      : { ...DEFAULT_CLIENT_METADATA, tags: [], plan: {}, contact: {}, limits: {} };
    this.cache.set(clientId, metadata);
    return metadata;
  }

  async set(clientId: string, patch: ClientMetadataPatch): Promise<ClientMetadata> {
    const current = this.cache.get(clientId) ?? await this.load(clientId);
    const updated = mergeMetadata(current, patch);
    await getRedis().set(key(clientId), JSON.stringify(updated));
    this.cache.set(clientId, updated);
    logger.info({ clientId }, 'Client metadata updated');
    return updated;
  }

  async reset(clientId: string): Promise<void> {
    await getRedis().del(key(clientId));
    this.cache.delete(clientId);
    logger.info({ clientId }, 'Client metadata reset');
  }

  async getEffectiveLimits(clientId: string): Promise<{ clientSendsPerWindow: number; deviceSendsPerWindow: number }> {
    const metadata = this.cache.get(clientId) ?? await this.load(clientId);
    const config = loadConfig();
    return {
      clientSendsPerWindow: metadata.limits?.clientSendsPerWindow ?? config.CLIENT_SENDS_PER_WINDOW,
      deviceSendsPerWindow: metadata.limits?.deviceSendsPerWindow ?? config.DEVICE_SENDS_PER_WINDOW,
    };
  }
}

export const clientMetadataManager = new ClientMetadataManager();

export async function getClientLifecycleStatus(clientId: string): Promise<ClientLifecycleStatus> {
  return (await clientMetadataManager.load(clientId)).status;
}

export async function assertClientRuntimeAccess(clientId: string): Promise<void> {
  const status = await getClientLifecycleStatus(clientId);
  if (status === 'active') return;

  const message = status === 'suspended'
    ? `Client ${clientId} is suspended. Runtime API access is disabled until the client is reactivated.`
    : `Client ${clientId} is offboarding. Runtime API access is disabled until the offboarding state is cleared.`;

  throw new AppError(ErrorCode.FORBIDDEN, message, 403, false);
}