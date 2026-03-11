// routes/config.ts — Per-client configuration endpoints.
//
// Layer 1 — Basic CRUD:
//   GET    /api/clients/:clientId/config          Read current config
//   PUT    /api/clients/:clientId/config          Partial update (merged)
//   DELETE /api/clients/:clientId/config          Reset to defaults
import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clientConfigManager, ClientConfigPatch } from '../core/client-config';
import { ok, fail } from './helpers';

const clientConfigSchema = z.object({
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

export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/clients/:clientId/config
  app.get('/api/clients/:clientId/config', async (request: FastifyRequest) => {
    const { clientId } = request.params as { clientId: string };
    return ok(clientConfigManager.getConfig(clientId));
  });

  // PUT /api/clients/:clientId/config
  app.put('/api/clients/:clientId/config', async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = clientConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    }
    const updated = await clientConfigManager.setConfig(clientId, parsed.data as ClientConfigPatch);
    return ok(updated);
  });

  // DELETE /api/clients/:clientId/config
  app.delete('/api/clients/:clientId/config', async (request: FastifyRequest) => {
    const { clientId } = request.params as { clientId: string };
    await clientConfigManager.resetConfig(clientId);
    return ok({ reset: true });
  });
}
