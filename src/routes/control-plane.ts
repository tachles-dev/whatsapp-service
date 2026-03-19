import { FastifyInstance, FastifyRequest } from 'fastify';
import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { clientConfigManager, ClientConfigPatch, generateClientKey, safeConfig } from '../core/client-config';
import { clientMetadataManager, ClientMetadataPatch } from '../core/client-metadata';
import { deviceManager } from '../core/device-manager';
import { getRedis } from '../redis';
import { recordAuditEvent } from '../audit-log';
import { fail, ok, sendError } from './helpers';
import { ServiceStatus } from '../types';
import { loadConfig } from '../config';
import { getSendQuotaSnapshot } from '../send-throttle';
import { SERVICE_VERSION } from '../version';

type ClientParams = { clientId: string };
type DeviceParams = ClientParams & { deviceId: string };

const metadataPatchSchema = z.object({
  status: z.enum(['active', 'suspended', 'offboarding']).optional(),
  externalRef: z.string().min(1).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(50).optional(),
  plan: z.object({
    code: z.string().min(1).max(100).nullable().optional(),
    name: z.string().min(1).max(200).nullable().optional(),
    storageSoftLimitMb: z.coerce.number().int().min(1).max(1_000_000).nullable().optional(),
  }).optional(),
  contact: z.object({
    companyName: z.string().min(1).max(200).nullable().optional(),
    personName: z.string().min(1).max(200).nullable().optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().min(5).max(50).nullable().optional(),
  }).optional(),
  limits: z.object({
    clientSendsPerWindow: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
    deviceSendsPerWindow: z.coerce.number().int().min(1).max(10_000).nullable().optional(),
  }).optional(),
});

const clientConfigPatchSchema = z.object({
  webhookUrl: z.string().url().nullable().optional(),
  webhookApiKey: z.string().min(1).nullable().optional(),
  events: z
    .object({
      messages: z.boolean(),
      reactions: z.boolean(),
      receipts: z.boolean(),
      groupParticipants: z.boolean(),
      presenceUpdates: z.boolean(),
      groupUpdates: z.boolean(),
      calls: z.boolean(),
    })
    .partial()
    .optional(),
  chats: z
    .object({
      defaultKind: z.enum(['CONTACT', 'GROUP']).nullable(),
      hideUnnamed: z.boolean(),
    })
    .partial()
    .optional(),
  maxDevices: z.coerce.number().int().min(1).max(20).optional(),
});

const bootstrapSchema = z.object({
  deviceName: z.string().min(1).max(100),
  ttlDays: z.coerce.number().int().min(1).max(365).default(90),
  rotateKey: z.boolean().default(false),
  config: clientConfigPatchSchema.optional(),
});

async function getQrSnapshot(clientId: string, deviceId: string): Promise<{ qr: string | null; status: ReturnType<ReturnType<typeof deviceManager.assertManager>['getStatusData']> }> {
  const manager = deviceManager.assertManager(clientId, deviceId);
  const status = manager.getStatusData();
  if (manager.getStatus() === ServiceStatus.CONNECTED) {
    return { qr: null, status };
  }

  let qr = manager.getQr();
  if (!qr) {
    qr = await getRedis().get(`wa:qr:${deviceId}`);
  }

  return { qr: qr ?? null, status };
}

async function getDirectorySize(targetPath: string): Promise<number> {
  let stats;
  try {
    stats = await fs.stat(targetPath);
  } catch {
    return 0;
  }

  if (!stats.isDirectory()) return stats.size;
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    total += await getDirectorySize(path.join(targetPath, entry.name));
  }
  return total;
}

async function buildManagedClientDetail(clientId: string) {
  const infos = deviceManager.getClientInfos(clientId);
  const [config, metadata, allowedNumbers, bannedNumbers, quotas, ownerInstanceIds, authBytesByDevice] = await Promise.all([
    clientConfigManager.loadConfig(clientId),
    clientMetadataManager.load(clientId),
    deviceManager.getAllowedNumbers(clientId),
    deviceManager.getBannedNumbers(clientId),
    getSendQuotaSnapshot(clientId, infos.map((info) => info.id)),
    Promise.all(infos.map((info) => deviceManager.getOwnerInstanceId(info.id))),
    Promise.all(infos.map((info) => getDirectorySize(path.join(loadConfig().AUTH_BASE_DIR, info.id)))),
  ]);

  const devices = infos.map((info, index) => ({
    deviceId: info.id,
    name: info.name,
    phone: info.phone ?? null,
    status: deviceManager.getManager(info.id)?.getStatusData().status ?? ServiceStatus.DISCONNECTED,
    ownerInstanceId: ownerInstanceIds[index],
  }));

  const authBytes = authBytesByDevice.reduce((sum, value) => sum + value, 0);

  return {
    clientId,
    metadata,
    config: safeConfig(config),
    deviceCount: devices.length,
    devices,
    storage: {
      authBytes,
      storageSoftLimitMb: metadata.plan?.storageSoftLimitMb ?? null,
    },
    quotas,
    allowedNumbers,
    bannedNumbers,
  };
}

export async function registerControlPlaneRoutes(app: FastifyInstance, basePath = '/api'): Promise<void> {
  app.get(`${basePath}/control-plane/instance`, async () => {
    const config = loadConfig();
    const allInfos = deviceManager.getAllInfos();
    const authSizes = await Promise.all(allInfos.map((info) => getDirectorySize(path.join(config.AUTH_BASE_DIR, info.id))));

    return ok({
      instance: {
        instanceId: config.INSTANCE_ID,
        version: SERVICE_VERSION,
        basePath,
        profile: config.MODULE_PROFILE ?? null,
      },
      totals: {
        clients: deviceManager.getClientIds().length,
        devices: allInfos.length,
        authStorageBytes: authSizes.reduce((sum, value) => sum + value, 0),
      },
      limits: {
        defaultClientSendsPerWindow: config.CLIENT_SENDS_PER_WINDOW,
        defaultDeviceSendsPerWindow: config.DEVICE_SENDS_PER_WINDOW,
        windowMs: config.SEND_THROTTLE_WINDOW_MS,
      },
    });
  });

  app.get(`${basePath}/control-plane/clients`, async () => {
    const clientIds = deviceManager.getClientIds();
    const details = await Promise.all(clientIds.map((clientId) => buildManagedClientDetail(clientId)));
    return ok(details.map(({ allowedNumbers, bannedNumbers, ...summary }) => summary));
  });

  app.get(`${basePath}/control-plane/clients/:clientId`, async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as ClientParams;
    try {
      return ok(await buildManagedClientDetail(clientId));
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.put(`${basePath}/control-plane/clients/:clientId/metadata`, async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as ClientParams;
    const parsed = metadataPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((issue) => issue.message).join('; ')));
    }

    try {
      await clientMetadataManager.set(clientId, parsed.data as ClientMetadataPatch);
      await recordAuditEvent({
        action: 'control-plane.client.metadata.updated',
        actorType: 'control-plane',
        actorId: 'control-plane',
        ip: request.ip,
        clientId,
        metadata: { fields: Object.keys(parsed.data) },
      });
      return ok(await buildManagedClientDetail(clientId));
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.post(`${basePath}/control-plane/clients/:clientId/bootstrap`, async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as ClientParams;
    const parsed = bootstrapSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((issue) => issue.message).join('; ')));
    }

    const currentConfig = await clientConfigManager.loadConfig(clientId);
    const hasActiveKey = !!currentConfig.apiKeyHash && !!currentConfig.apiKeyExpiresAt && currentConfig.apiKeyExpiresAt > Date.now();
    if (hasActiveKey && !parsed.data.rotateKey) {
      return reply.code(409).send(fail('CLIENT_KEY_EXISTS', 'Client already has an active API key. Set rotateKey=true to issue a new plaintext key.'));
    }

    try {
      const updatedConfig = parsed.data.config
        ? await clientConfigManager.setConfig(clientId, parsed.data.config as ClientConfigPatch)
        : currentConfig;

      const device = await deviceManager.createDevice(clientId, parsed.data.deviceName);
      const key = await generateClientKey(clientId, parsed.data.ttlDays);

      await recordAuditEvent({
        action: 'control-plane.bootstrap',
        actorType: 'control-plane',
        actorId: 'control-plane',
        ip: request.ip,
        clientId,
        deviceId: device.id,
        metadata: {
          deviceName: parsed.data.deviceName,
          rotateKey: parsed.data.rotateKey,
          ttlDays: parsed.data.ttlDays,
          configuredFields: Object.keys(parsed.data.config ?? {}),
        },
      });

      return reply.code(201).send(ok({
        clientId,
        key: {
          key,
          warning: 'Store this key securely. It will never be shown again.',
        },
        device,
        config: safeConfig(updatedConfig),
        onboardingPath: `${basePath}/control-plane/clients/${encodeURIComponent(clientId)}/devices/${encodeURIComponent(device.id)}/onboarding`,
      }));
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.delete(`${basePath}/control-plane/clients/:clientId`, async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as ClientParams;
    try {
      const devices = deviceManager.getClientInfos(clientId);
      for (const device of devices) {
        await deviceManager.removeDevice(clientId, device.id);
      }
      await Promise.all([
        clientConfigManager.resetConfig(clientId),
        clientMetadataManager.reset(clientId),
        getRedis().del(`wa:client:${clientId}:allowed`),
        getRedis().del(`wa:client:${clientId}:banned`),
      ]);

      await recordAuditEvent({
        action: 'control-plane.client.deleted',
        actorType: 'control-plane',
        actorId: 'control-plane',
        ip: request.ip,
        clientId,
        metadata: { removedDevices: devices.length },
      });

      return ok({ deleted: true, removedDevices: devices.length });
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.get(`${basePath}/control-plane/clients/:clientId/devices/:deviceId/onboarding`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const config = await clientConfigManager.loadConfig(clientId);
      const metadata = await clientMetadataManager.load(clientId);
      const { qr, status } = await getQrSnapshot(clientId, deviceId);
      return ok({
        clientId,
        deviceId,
        status,
        qr,
        config: safeConfig(config),
        metadata,
        links: {
          status: `${basePath}/clients/${encodeURIComponent(clientId)}/devices/${encodeURIComponent(deviceId)}/status`,
          qr: `${basePath}/clients/${encodeURIComponent(clientId)}/devices/${encodeURIComponent(deviceId)}/auth/qr`,
          resetAuth: `${basePath}/clients/${encodeURIComponent(clientId)}/devices/${encodeURIComponent(deviceId)}/auth/reset`,
        },
      });
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.post(`${basePath}/control-plane/clients/:clientId/devices/:deviceId/reissue-qr`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.resetAuth();
      await recordAuditEvent({
        action: 'control-plane.reissue-qr',
        actorType: 'control-plane',
        actorId: 'control-plane',
        ip: request.ip,
        clientId,
        deviceId,
      });

      return ok({
        message: 'Auth cleared. A fresh QR will be generated shortly.',
        onboardingPath: `${basePath}/control-plane/clients/${encodeURIComponent(clientId)}/devices/${encodeURIComponent(deviceId)}/onboarding`,
      });
    } catch (err) {
      sendError(err, reply);
    }
  });
}