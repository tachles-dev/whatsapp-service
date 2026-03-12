// routes/chats.ts — Chat-level operations.
//
// Layer 1 — List + basic actions:
//   GET    .../chats                  List chats (kind=all|individual|group, hideUnnamed=true, q=<search term>)
//                                     Supports ?q= text search across name/phone. Named contacts are ranked first.
//                                     Use ?hideUnnamed=true to exclude contacts whose name is just the raw phone/JID number.
//                                     Paginate with ?limit=<n>&offset=<n> (default limit=50, max=200).
//                                     Response: { items, total, limit, offset }
//   POST   .../chats/:jid/archive
//   DELETE .../chats/:jid/archive
//   POST   .../chats/:jid/mute       body: { duration: seconds | 0 = until manual unmute }
//   DELETE .../chats/:jid/mute
//   POST   .../chats/:jid/pin
//   DELETE .../chats/:jid/pin
//   POST   .../chats/:jid/read
//   DELETE .../chats/:jid            Delete chat history (own side only)
//
// Layer 3 — Advanced:
//   PUT    .../chats/:jid/ephemeral  body: { expiration: 0|86400|604800|7776000 }
import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deviceManager } from '../core/device-manager';
import { ok, fail, sendError, validateJid } from './helpers';

type DeviceParams = { clientId: string; deviceId: string };
type ChatParams = DeviceParams & { jid: string };

const muteSchema = z.object({
  duration: z.number().int().min(0),
});

const ephemeralSchema = z.object({
  expiration: z.union([z.literal(0), z.literal(86400), z.literal(604800), z.literal(7776000)]),
});

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  // GET .../chats
  app.get('/api/clients/:clientId/devices/:deviceId/chats', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const { kind, hideUnnamed, q, limit: limitStr, offset: offsetStr } = request.query as {
      kind?: string; hideUnnamed?: string; q?: string; limit?: string; offset?: string;
    };
    const limit = Math.min(200, Math.max(1, parseInt(limitStr ?? '50', 10) || 50));
    const offset = Math.max(0, parseInt(offsetStr ?? '0', 10) || 0);
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const kindParam = kind === 'individual' ? 'CONTACT' : kind === 'group' ? 'GROUP' : undefined;
      const hideUnnamedParam = hideUnnamed === '1' || hideUnnamed === 'true';
      const all = await manager.getChats(q, kindParam, hideUnnamedParam);
      return ok({ items: all.slice(offset, offset + limit), total: all.length, limit, offset });
    } catch (err) { sendError(err, reply); }
  });

  // POST .../chats/:jid/archive
  app.post('/api/clients/:clientId/devices/:deviceId/chats/:jid/archive', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ChatParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.archiveChat(validateJid(jid), true);
      return ok({ archived: true });
    } catch (err) { sendError(err, reply); }
  });

  // DELETE .../chats/:jid/archive
  app.delete('/api/clients/:clientId/devices/:deviceId/chats/:jid/archive', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ChatParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.archiveChat(validateJid(jid), false);
      return ok({ archived: false });
    } catch (err) { sendError(err, reply); }
  });

  // POST .../chats/:jid/mute
  app.post('/api/clients/:clientId/devices/:deviceId/chats/:jid/mute', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ChatParams;
    const parsed = muteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      // duration=0 means unmute (null); any positive value is converted from seconds to ms
      const muteDurationMs = parsed.data.duration === 0 ? null : parsed.data.duration * 1000;
      await manager.muteChat(validateJid(jid), muteDurationMs);
      return ok({ muted: muteDurationMs !== null, duration: parsed.data.duration });
    } catch (err) { sendError(err, reply); }
  });

  // DELETE .../chats/:jid/mute
  app.delete('/api/clients/:clientId/devices/:deviceId/chats/:jid/mute', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ChatParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.muteChat(validateJid(jid), null);
      return ok({ muted: false });
    } catch (err) { sendError(err, reply); }
  });

  // POST .../chats/:jid/pin
  app.post('/api/clients/:clientId/devices/:deviceId/chats/:jid/pin', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ChatParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.pinChat(validateJid(jid), true);
      return ok({ pinned: true });
    } catch (err) { sendError(err, reply); }
  });

  // DELETE .../chats/:jid/pin
  app.delete('/api/clients/:clientId/devices/:deviceId/chats/:jid/pin', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ChatParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.pinChat(validateJid(jid), false);
      return ok({ pinned: false });
    } catch (err) { sendError(err, reply); }
  });

  // POST .../chats/:jid/read
  app.post('/api/clients/:clientId/devices/:deviceId/chats/:jid/read', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ChatParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.markRead(validateJid(jid), []);
      return ok({ read: true });
    } catch (err) { sendError(err, reply); }
  });

  // DELETE .../chats/:jid
  app.delete('/api/clients/:clientId/devices/:deviceId/chats/:jid', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ChatParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.deleteChat(validateJid(jid));
      return ok({ deleted: true });
    } catch (err) { sendError(err, reply); }
  });

  // PUT .../chats/:jid/ephemeral  — Layer 3
  app.put('/api/clients/:clientId/devices/:deviceId/chats/:jid/ephemeral', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ChatParams;
    const parsed = ephemeralSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.setEphemeralExpiration(validateJid(jid), parsed.data.expiration);
      return ok({ expiration: parsed.data.expiration });
    } catch (err) { sendError(err, reply); }
  });
}
