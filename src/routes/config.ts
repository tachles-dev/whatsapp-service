// routes/config.ts — Per-client configuration endpoints.
//
// Layer 1 — Basic CRUD:
//   GET    /api/clients/:clientId/config          Read current config
//   PUT    /api/clients/:clientId/config          Partial update (merged)
//   DELETE /api/clients/:clientId/config          Reset to defaults
import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadConfig } from '../config';
import { logger } from '../logger';
import { clientConfigManager, ClientConfigPatch, generateClientKey, revokeClientKey, rotateClientKey, safeConfig } from '../core/client-config';
import { ok, fail } from './helpers';
import { recordAuditEvent } from '../audit-log';

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

export async function registerConfigRoutes(app: FastifyInstance, basePath = '/api'): Promise<void> {
  app.get(`${basePath}/clients/:clientId/config`, async (request: FastifyRequest) => {
    const { clientId } = request.params as { clientId: string };
    return ok(safeConfig(clientConfigManager.getConfig(clientId)));
  });

  app.put(`${basePath}/clients/:clientId/config`, async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = clientConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    }
    const updated = await clientConfigManager.setConfig(clientId, parsed.data as ClientConfigPatch);
    await recordAuditEvent({
      action: 'client.config.updated',
      actorType: 'master-key',
      actorId: 'master',
      ip: request.ip,
      clientId,
      metadata: { fields: Object.keys(parsed.data) },
    });
    return ok(safeConfig(updated));
  });

  app.delete(`${basePath}/clients/:clientId/config`, async (request: FastifyRequest) => {
    const { clientId } = request.params as { clientId: string };
    await clientConfigManager.resetConfig(clientId);
    await recordAuditEvent({ action: 'client.config.reset', actorType: 'master-key', actorId: 'master', ip: request.ip, clientId });
    return ok({ reset: true });
  });

  // POST /api/clients/:clientId/key
  // Issues a new API key. Returns the plaintext key ONCE — it is never stored.
  // Optional body: { ttlDays: number }  (default 90, max 365)
  // Requires master API key.
  app.post(`${basePath}/clients/:clientId/key`, async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as { clientId: string };
    const { ttlDays = 90 } = (request.body as { ttlDays?: number }) ?? {};
    const plaintext = await generateClientKey(clientId, ttlDays);
    logger.info({ clientId, ttlDays }, 'Client API key created');
    await recordAuditEvent({ action: 'client.key.created', actorType: 'master-key', actorId: 'master', ip: request.ip, clientId, metadata: { ttlDays } });
    return reply.code(201).send(ok({
      key: plaintext,
      warning: 'Store this key securely. It will never be shown again.',
    }));
  });

  // POST /api/clients/:clientId/key/rotate
  // Rotates the key using the current valid key (x-api-key header).
  // The old key is invalidated immediately. Returns a new plaintext key ONCE.
  // Optional body: { ttlDays: number }  (default 90, max 365)
  // Can be called with either the master key or the client's own current key.
  app.post(`${basePath}/clients/:clientId/key/rotate`, async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as { clientId: string };
    const { ttlDays = 90 } = (request.body as { ttlDays?: number }) ?? {};
    const provided = request.headers['x-api-key'] as string | undefined;

    // Master key path — full override without needing the current client key.
    if (provided === loadConfig().API_KEY) {
      const plaintext = await generateClientKey(clientId, ttlDays);
      logger.info({ clientId, ttlDays }, 'Client API key rotated (master key)');
      await recordAuditEvent({ action: 'client.key.rotated', actorType: 'master-key', actorId: 'master', ip: request.ip, clientId, metadata: { ttlDays } });
      return reply.code(201).send(ok({
        key: plaintext,
        warning: 'Store this key securely. It will never be shown again.',
      }));
    }

    // Client key path — must provide the current valid key to get a new one.
    if (!provided) return reply.code(401).send(fail('UNAUTHORIZED', 'Missing API key'));
    const plaintext = await rotateClientKey(clientId, provided, ttlDays);
    if (!plaintext) {
      return reply.code(401).send(fail('UNAUTHORIZED', 'Key invalid or expired — use master key to re-issue'));
    }
    logger.info({ clientId }, 'Client API key rotated (client key)');
    await recordAuditEvent({ action: 'client.key.rotated', actorType: 'client-key', actorId: clientId, ip: request.ip, clientId, metadata: { ttlDays } });
    return reply.code(201).send(ok({
      key: plaintext,
      warning: 'Store this key securely. It will never be shown again.',
    }));
  });

  // DELETE /api/clients/:clientId/key
  // Revokes the client API key immediately. Requires master key.
  app.delete(`${basePath}/clients/:clientId/key`, async (request: FastifyRequest) => {
    const { clientId } = request.params as { clientId: string };
    await revokeClientKey(clientId);
    logger.info({ clientId }, 'Client API key revoked');
    await recordAuditEvent({ action: 'client.key.revoked', actorType: 'master-key', actorId: 'master', ip: request.ip, clientId });
    return ok({ revoked: true });
  });
}
