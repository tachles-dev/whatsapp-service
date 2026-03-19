// routes/devices.ts — Device management, lifecycle, profile, and presence.
//
// Layer 1 — Basic CRUD & lifecycle:
//   GET    /api/clients/:clientId/devices                           List devices
//   POST   /api/clients/:clientId/devices                           Register new device
//   DELETE /api/clients/:clientId/devices/:deviceId                 Remove device
//   GET    /api/clients/:clientId/devices/:deviceId/status          Connection status
//   GET    /api/clients/:clientId/devices/:deviceId/auth/qr         QR code
//   POST   /api/clients/:clientId/devices/:deviceId/auth/reset      Clear credentials/re-QR
//   POST   /api/clients/:clientId/devices/:deviceId/disconnect      Graceful disconnect
//   POST   /api/clients/:clientId/devices/:deviceId/reconnect       Re-initiate connection
//   POST   /api/clients/:clientId/devices/:deviceId/cache/flush     Wipe chat cache (force re-sync)
//   GET    /api/clients/:clientId/devices/:deviceId/profile         Own WhatsApp profile
//   PUT    /api/clients/:clientId/devices/:deviceId/profile/name    Update display name
//   PUT    /api/clients/:clientId/devices/:deviceId/profile/status  Update status text
//   POST   /api/clients/:clientId/devices/:deviceId/presence        Broadcast presence
import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deviceManager } from '../core/device-manager';
import { getRedis } from '../redis';
import { ServiceStatus, PresenceType } from '../types';
import { ok, fail, sendError } from './helpers';
import { scheduledMessageService } from '../services/scheduled-messages';
import { recordAuditEvent } from '../audit-log';

type DeviceParams = { clientId: string; deviceId: string };

const createDeviceSchema = z.object({ name: z.string().min(1).max(100) });
const profileNameSchema = z.object({ name: z.string().min(1).max(25) });
const profileStatusSchema = z.object({ status: z.string().max(139) });
const presenceSchema = z.object({
  presence: z.nativeEnum(PresenceType),
  toJid: z.string().optional(),
});

export async function registerDeviceRoutes(app: FastifyInstance, basePath = '/api'): Promise<void> {
  app.get(`${basePath}/clients/:clientId/devices`, async (request: FastifyRequest) => {
    const { clientId } = request.params as { clientId: string };
    const infos = deviceManager.getClientInfos(clientId);
    const result = infos.map((info) => ({
      ...info,
      status: deviceManager.getManager(info.id)?.getStatusData() ?? null,
    }));
    return ok(result);
  });

  app.post(`${basePath}/clients/:clientId/devices`, async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = createDeviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    }
    try {
      const info = await deviceManager.createDevice(clientId, parsed.data.name);
      await recordAuditEvent({ action: 'device.created', actorType: 'master-key', actorId: 'master', ip: request.ip, clientId, deviceId: info.id, metadata: { name: parsed.data.name } });
      return reply.code(201).send(ok(info));
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.delete(`${basePath}/clients/:clientId/devices/:deviceId`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      await scheduledMessageService.purgeDeviceScheduledMessages(clientId, deviceId);
      await deviceManager.removeDevice(clientId, deviceId);
      await recordAuditEvent({ action: 'device.deleted', actorType: 'master-key', actorId: 'master', ip: request.ip, clientId, deviceId });
      return ok({ deleted: true });
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.get(`${basePath}/clients/:clientId/devices/:deviceId/status`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      return ok(manager.getStatusData());
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.get(`${basePath}/clients/:clientId/devices/:deviceId/auth/qr`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      if (manager.getStatus() === ServiceStatus.CONNECTED) {
        return ok({ qr: null, message: 'Already connected' });
      }
      let qr = manager.getQr();
      if (!qr) {
        qr = await getRedis().get(`wa:qr:${deviceId}`);
      }
      if (!qr) {
        return reply.code(404).send(fail('QR_NOT_AVAILABLE', 'QR not yet generated. Wait for initialization.'));
      }
      return ok({ qr });
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.post(`${basePath}/clients/:clientId/devices/:deviceId/auth/reset`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.resetAuth();
      await recordAuditEvent({ action: 'device.auth.reset', actorType: 'master-key', actorId: 'master', ip: request.ip, clientId, deviceId });
      return ok({ message: 'Auth cleared. New QR will be generated shortly.' });
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.post(`${basePath}/clients/:clientId/devices/:deviceId/disconnect`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.close();
      await recordAuditEvent({ action: 'device.disconnected', actorType: 'master-key', actorId: 'master', ip: request.ip, clientId, deviceId });
      return ok({ disconnected: true });
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.post(`${basePath}/clients/:clientId/devices/:deviceId/reconnect`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.start();
      await recordAuditEvent({ action: 'device.reconnect.requested', actorType: 'master-key', actorId: 'master', ip: request.ip, clientId, deviceId });
      return ok({ reconnecting: true });
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.post(`${basePath}/clients/:clientId/devices/:deviceId/cache/flush`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      await deviceManager.flushChatCache(clientId, deviceId);
      await recordAuditEvent({ action: 'device.cache.flushed', actorType: 'master-key', actorId: 'master', ip: request.ip, clientId, deviceId });
      return ok({ flushed: true, message: 'Chat cache cleared. It will be rebuilt on the next WhatsApp sync event.' });
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.get(`${basePath}/clients/:clientId/devices/:deviceId/profile`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const profile = await manager.getOwnProfile();
      return ok(profile);
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.put(`${basePath}/clients/:clientId/devices/:deviceId/profile/name`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = profileNameSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    }
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.updateDisplayName(parsed.data.name);
      return ok({ updated: true });
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.put(`${basePath}/clients/:clientId/devices/:deviceId/profile/status`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = profileStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    }
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.updateStatusText(parsed.data.status);
      return ok({ updated: true });
    } catch (err) {
      sendError(err, reply);
    }
  });

  app.post(`${basePath}/clients/:clientId/devices/:deviceId/presence`, async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = presenceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    }
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.sendPresence(parsed.data.presence, parsed.data.toJid);
      return ok({ sent: true });
    } catch (err) {
      sendError(err, reply);
    }
  });
}
