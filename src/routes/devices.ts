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

type DeviceParams = { clientId: string; deviceId: string };

const createDeviceSchema = z.object({ name: z.string().min(1).max(100) });
const profileNameSchema = z.object({ name: z.string().min(1).max(25) });
const profileStatusSchema = z.object({ status: z.string().max(139) });
const presenceSchema = z.object({
  presence: z.nativeEnum(PresenceType),
  toJid: z.string().optional(),
});

export async function registerDeviceRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/clients/:clientId/devices
  app.get('/api/clients/:clientId/devices', async (request: FastifyRequest) => {
    const { clientId } = request.params as { clientId: string };
    const infos = deviceManager.getClientInfos(clientId);
    const result = infos.map((info) => ({
      ...info,
      status: deviceManager.getManager(info.id)?.getStatusData() ?? null,
    }));
    return ok(result);
  });

  // POST /api/clients/:clientId/devices
  app.post('/api/clients/:clientId/devices', async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = createDeviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    }
    try {
      const info = await deviceManager.createDevice(clientId, parsed.data.name);
      return reply.code(201).send(ok(info));
    } catch (err) {
      sendError(err, reply);
    }
  });

  // DELETE /api/clients/:clientId/devices/:deviceId
  app.delete('/api/clients/:clientId/devices/:deviceId', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      await deviceManager.removeDevice(clientId, deviceId);
      return ok({ deleted: true });
    } catch (err) {
      sendError(err, reply);
    }
  });

  // GET /api/clients/:clientId/devices/:deviceId/status
  app.get('/api/clients/:clientId/devices/:deviceId/status', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      return ok(manager.getStatusData());
    } catch (err) {
      sendError(err, reply);
    }
  });

  // GET /api/clients/:clientId/devices/:deviceId/auth/qr
  app.get('/api/clients/:clientId/devices/:deviceId/auth/qr', async (request: FastifyRequest, reply) => {
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

  // POST /api/clients/:clientId/devices/:deviceId/auth/reset
  app.post('/api/clients/:clientId/devices/:deviceId/auth/reset', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.resetAuth();
      return ok({ message: 'Auth cleared. New QR will be generated shortly.' });
    } catch (err) {
      sendError(err, reply);
    }
  });

  // POST /api/clients/:clientId/devices/:deviceId/disconnect
  app.post('/api/clients/:clientId/devices/:deviceId/disconnect', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.close();
      return ok({ disconnected: true });
    } catch (err) {
      sendError(err, reply);
    }
  });

  // POST /api/clients/:clientId/devices/:deviceId/reconnect
  app.post('/api/clients/:clientId/devices/:deviceId/reconnect', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.start();
      return ok({ reconnecting: true });
    } catch (err) {
      sendError(err, reply);
    }
  });

  // GET /api/clients/:clientId/devices/:deviceId/profile
  app.get('/api/clients/:clientId/devices/:deviceId/profile', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const profile = await manager.getOwnProfile();
      return ok(profile);
    } catch (err) {
      sendError(err, reply);
    }
  });

  // PUT /api/clients/:clientId/devices/:deviceId/profile/name
  app.put('/api/clients/:clientId/devices/:deviceId/profile/name', async (request: FastifyRequest, reply) => {
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

  // PUT /api/clients/:clientId/devices/:deviceId/profile/status
  app.put('/api/clients/:clientId/devices/:deviceId/profile/status', async (request: FastifyRequest, reply) => {
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

  // POST /api/clients/:clientId/devices/:deviceId/presence
  app.post('/api/clients/:clientId/devices/:deviceId/presence', async (request: FastifyRequest, reply) => {
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
