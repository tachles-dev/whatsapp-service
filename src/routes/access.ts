// routes/access.ts — Per-client phone number ban / allow lists.
//
// Banned-numbers  (block individual phones from sending you messages via the gateway):
//   GET    /api/clients/:clientId/banned-numbers
//   POST   /api/clients/:clientId/banned-numbers          body: { phone }
//   DELETE /api/clients/:clientId/banned-numbers/:phone
//
// Allowed-numbers (allowlist mode — empty list = open mode):
//   GET    /api/clients/:clientId/allowed-numbers
//   POST   /api/clients/:clientId/allowed-numbers         body: { phone }
//   DELETE /api/clients/:clientId/allowed-numbers/:phone
import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deviceManager } from '../core/device-manager';
import { ok, fail, sendError, phonePattern } from './helpers';

type ClientParams = { clientId: string };
type PhoneParams = ClientParams & { phone: string };

const phoneSchema = z.object({
  phone: z.string().regex(phonePattern, 'Phone must be digits only (E.164 without +)'),
});

export async function registerAccessRoutes(app: FastifyInstance): Promise<void> {
  // ── Banned numbers ─────────────────────────────────────────────────────────

  app.get('/api/clients/:clientId/banned-numbers', async (request: FastifyRequest) => {
    const { clientId } = request.params as ClientParams;
    const numbers = await deviceManager.getBannedNumbers(clientId);
    return ok(numbers);
  });

  app.post('/api/clients/:clientId/banned-numbers', async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as ClientParams;
    const parsed = phoneSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      await deviceManager.addBannedNumber(clientId, parsed.data.phone);
      return ok({ phone: parsed.data.phone, banned: true });
    } catch (err) { sendError(err, reply); }
  });

  app.delete('/api/clients/:clientId/banned-numbers/:phone', async (request: FastifyRequest, reply) => {
    const { clientId, phone } = request.params as PhoneParams;
    try {
      await deviceManager.removeBannedNumber(clientId, phone);
      return ok({ phone, banned: false });
    } catch (err) { sendError(err, reply); }
  });

  // ── Allowed numbers ────────────────────────────────────────────────────────

  app.get('/api/clients/:clientId/allowed-numbers', async (request: FastifyRequest) => {
    const { clientId } = request.params as ClientParams;
    const numbers = await deviceManager.getAllowedNumbers(clientId);
    return ok(numbers);
  });

  app.post('/api/clients/:clientId/allowed-numbers', async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as ClientParams;
    const parsed = phoneSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      await deviceManager.addAllowedNumber(clientId, parsed.data.phone);
      return ok({ phone: parsed.data.phone, allowed: true });
    } catch (err) { sendError(err, reply); }
  });

  app.delete('/api/clients/:clientId/allowed-numbers/:phone', async (request: FastifyRequest, reply) => {
    const { clientId, phone } = request.params as PhoneParams;
    try {
      await deviceManager.removeAllowedNumber(clientId, phone);
      return ok({ phone, allowed: false });
    } catch (err) { sendError(err, reply); }
  });
}
