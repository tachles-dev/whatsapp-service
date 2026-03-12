// routes/contacts.ts — Contact management endpoints.
//
// Layer 1 — Existing operations:
//   GET  .../contacts/check?phone=    Check if a phone number is on WhatsApp
//   GET  .../contacts/:jid/profile-picture
//   GET  .../contacts/:jid/status
//   POST .../contacts/:jid/block
//   DELETE .../contacts/:jid/block
//   GET  .../contacts/blocklist
//
// Layer 2 — Extended operations:
//   POST .../contacts/check-bulk      Check multiple phones at once (max 100)
//   POST .../contacts/:jid/subscribe-presence
import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deviceManager } from '../core/device-manager';
import { ok, fail, sendError, phonePattern, jidPattern, validateJid } from './helpers';

type DeviceParams = { clientId: string; deviceId: string };
type ContactParams = DeviceParams & { jid: string };

const checkBulkSchema = z.object({
  phones: z.array(z.string().regex(phonePattern, 'Phone must be digits only')).min(1).max(100),
});

export async function registerContactRoutes(app: FastifyInstance): Promise<void> {
  // GET .../contacts/check?phone=<number>
  app.get('/api/clients/:clientId/devices/:deviceId/contacts/check', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const { phone } = request.query as { phone?: string };
    if (!phone || !phonePattern.test(phone)) {
      return reply.code(400).send(fail('VALIDATION_ERROR', 'Provide phone as E.164 digits without +'));
    }
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const result = await manager.checkPhone(phone);
      return ok(result);
    } catch (err) { sendError(err, reply); }
  });

  // POST .../contacts/check-bulk   — Layer 2
  app.post('/api/clients/:clientId/devices/:deviceId/contacts/check-bulk', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = checkBulkSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const results = await Promise.all(parsed.data.phones.map((phone) => manager.checkPhone(phone)));
      return ok(results);
    } catch (err) { sendError(err, reply); }
  });

  // GET .../contacts/blocklist
  app.get('/api/clients/:clientId/devices/:deviceId/contacts/blocklist', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const blocklist = await manager.getBlocklist();
      return ok(blocklist);
    } catch (err) { sendError(err, reply); }
  });

  // GET .../contacts/:jid/profile-picture
  app.get('/api/clients/:clientId/devices/:deviceId/contacts/:jid/profile-picture', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ContactParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const url = await manager.getProfilePicture(validateJid(jid));
      return ok({ url });
    } catch (err) { sendError(err, reply); }
  });

  // GET .../contacts/:jid/status
  app.get('/api/clients/:clientId/devices/:deviceId/contacts/:jid/status', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ContactParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const result = await manager.getContactStatus(validateJid(jid));
      return ok(result);
    } catch (err) { sendError(err, reply); }
  });

  // POST .../contacts/:jid/block
  app.post('/api/clients/:clientId/devices/:deviceId/contacts/:jid/block', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ContactParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.blockContact(validateJid(jid));
      return ok({ blocked: true });
    } catch (err) { sendError(err, reply); }
  });

  // DELETE .../contacts/:jid/block
  app.delete('/api/clients/:clientId/devices/:deviceId/contacts/:jid/block', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ContactParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.unblockContact(validateJid(jid));
      return ok({ unblocked: true });
    } catch (err) { sendError(err, reply); }
  });

  // POST .../contacts/:jid/subscribe-presence
  app.post('/api/clients/:clientId/devices/:deviceId/contacts/:jid/subscribe-presence', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, jid } = request.params as ContactParams;
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.subscribeToPresence(validateJid(jid));
      return ok({ subscribed: true });
    } catch (err) { sendError(err, reply); }
  });
}
