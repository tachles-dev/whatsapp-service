// routes/messages.ts — Message sending endpoints.
//
// Layer 1 — Single-message send:
//   POST .../messages/send-text       Plain text (+ optional quote/mention)
//   POST .../messages/send-image      Image (url or base64, optional caption)
//   POST .../messages/send-video      Video (url or base64, optional caption)
//   POST .../messages/send-audio      Audio/voice note (url or base64)
//   POST .../messages/send-document   File attachment (url or base64)
//   POST .../messages/send-location   GPS coordinates
//   POST .../messages/send-reaction   Emoji reaction to a message
//   DELETE .../messages/:messageId    Delete a message (own; optionally for everyone)
//
// Layer 2 — Cross-chat operations:
//   POST .../messages/broadcast       Send the same text to multiple JIDs
//
// Backward compat:
//   POST .../send                     (legacy) text-only endpoint kept for existing integrations
import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deviceManager } from '../core/device-manager';
import { logger } from '../logger';
import { ok, fail, sendError, jidPattern, phonePattern, isBlockedMediaUrl, validateJid } from './helpers';

type DeviceParams = { clientId: string; deviceId: string };
type MessageParams = DeviceParams & { messageId: string };

const jidOrPhone = z
  .object({
    jid: z.string().regex(jidPattern, 'Invalid JID. Use number@s.whatsapp.net or number@g.us').optional(),
    phone: z.string().regex(phonePattern, 'Phone must be digits only (E.164 without +)').optional(),
  })
  .refine((d) => d.jid || d.phone, { message: 'Provide either jid or phone' });

const mediaSource = z.object({
  url: z.string().url().optional(),
  base64: z.string().max(20_000_000).optional(),
}).refine((d) => d.url || d.base64, { message: 'Provide either url or base64' })
  .refine((d) => !d.url || !isBlockedMediaUrl(d.url), { message: 'Media URL points to a restricted address' });

const sendOptions = z.object({
  quotedMessageId: z.string().optional(),
  mentionedJids: z.array(z.string()).optional(),
}).optional();

const sendTextSchema = jidOrPhone.and(z.object({
  text: z.string().min(1).max(10_000),
  options: sendOptions,
}));

const sendImageSchema = jidOrPhone.and(z.object({
  media: mediaSource,
  caption: z.string().max(1024).optional(),
  options: sendOptions,
}));

const sendVideoSchema = jidOrPhone.and(z.object({
  media: mediaSource,
  caption: z.string().max(1024).optional(),
  options: sendOptions,
}));

const sendAudioSchema = jidOrPhone.and(z.object({
  media: mediaSource,
  ptt: z.boolean().optional(),
  options: sendOptions,
}));

const sendDocumentSchema = jidOrPhone.and(z.object({
  media: mediaSource,
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  options: sendOptions,
}));

const sendLocationSchema = jidOrPhone.and(z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name: z.string().optional(),
  address: z.string().optional(),
}));

const sendReactionSchema = jidOrPhone.and(z.object({
  targetMessageId: z.string().min(1),
  emoji: z.string().max(8),
}));

const broadcastSchema = z.object({
  jids: z.array(z.string()).min(1).max(100),
  text: z.string().min(1).max(10_000),
});

// Legacy schema kept for backward compatibility with existing integrations
const legacySendSchema = jidOrPhone.and(z.object({
  text: z.string().min(1).max(10_000),
  quotedId: z.string().optional(),
}));

function resolveJid(data: { jid?: string; phone?: string }): string {
  return data.jid ?? `${data.phone}@s.whatsapp.net`;
}

export async function registerMessageRoutes(app: FastifyInstance): Promise<void> {
  // ── Layer 1: single sends ──────────────────────────────────────────────────

  // POST .../messages/send-text
  app.post('/api/clients/:clientId/devices/:deviceId/messages/send-text', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = sendTextSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const result = await manager.sendTextMessage(resolveJid(parsed.data), parsed.data.text, parsed.data.options ?? undefined);
      return ok(result);
    } catch (err) { sendError(err, reply); }
  });

  // POST .../messages/send-image
  app.post('/api/clients/:clientId/devices/:deviceId/messages/send-image', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = sendImageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const result = await manager.sendImageMessage(resolveJid(parsed.data), parsed.data.media, {
        caption: parsed.data.caption,
        ...(parsed.data.options ?? {}),
      });
      return ok(result);
    } catch (err) { sendError(err, reply); }
  });

  // POST .../messages/send-video
  app.post('/api/clients/:clientId/devices/:deviceId/messages/send-video', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = sendVideoSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const result = await manager.sendVideoMessage(resolveJid(parsed.data), parsed.data.media, {
        caption: parsed.data.caption,
        ...(parsed.data.options ?? {}),
      });
      return ok(result);
    } catch (err) { sendError(err, reply); }
  });

  // POST .../messages/send-audio
  app.post('/api/clients/:clientId/devices/:deviceId/messages/send-audio', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = sendAudioSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const result = await manager.sendAudioMessage(resolveJid(parsed.data), parsed.data.media, {
        ptt: parsed.data.ptt,
        ...(parsed.data.options ?? {}),
      });
      return ok(result);
    } catch (err) { sendError(err, reply); }
  });

  // POST .../messages/send-document
  app.post('/api/clients/:clientId/devices/:deviceId/messages/send-document', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = sendDocumentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const result = await manager.sendDocumentMessage(resolveJid(parsed.data), parsed.data.media, {
        fileName: parsed.data.fileName,
        mimeType: parsed.data.mimeType,
        ...(parsed.data.options ?? {}),
      });
      return ok(result);
    } catch (err) { sendError(err, reply); }
  });

  // POST .../messages/send-location
  app.post('/api/clients/:clientId/devices/:deviceId/messages/send-location', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = sendLocationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const result = await manager.sendLocationMessage(resolveJid(parsed.data), {
        degreesLatitude: parsed.data.latitude,
        degreesLongitude: parsed.data.longitude,
        name: parsed.data.name,
        address: parsed.data.address,
      });
      return ok(result);
    } catch (err) { sendError(err, reply); }
  });

  // POST .../messages/send-reaction
  app.post('/api/clients/:clientId/devices/:deviceId/messages/send-reaction', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = sendReactionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.sendReactionMessage(resolveJid(parsed.data), parsed.data.targetMessageId, parsed.data.emoji);
      return ok({ sent: true });
    } catch (err) { sendError(err, reply); }
  });

  // DELETE .../messages/:messageId
  app.delete('/api/clients/:clientId/devices/:deviceId/messages/:messageId', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId, messageId } = request.params as MessageParams;
    const { jid, phone, forEveryone } = request.query as { jid?: string; phone?: string; forEveryone?: string };
    const resolvedJid = jid ?? (phone ? `${phone}@s.whatsapp.net` : null);
    if (!resolvedJid) return reply.code(400).send(fail('VALIDATION_ERROR', 'Provide jid or phone query param'));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      await manager.deleteMessage(resolvedJid, messageId, forEveryone === '1' || forEveryone === 'true');
      return ok({ deleted: true });
    } catch (err) { sendError(err, reply); }
  });

  // ── Layer 2: broadcast ─────────────────────────────────────────────────────

  /**
   * POST .../messages/broadcast
   * Fan-out: sends the same text to up to 100 JIDs in parallel (best-effort).
   * Returns per-JID results so callers can handle partial failures.
   */
  app.post('/api/clients/:clientId/devices/:deviceId/messages/broadcast', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = broadcastSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const results = await Promise.allSettled(
        parsed.data.jids.map((jid) => manager.sendTextMessage(jid, parsed.data.text)),
      );
      const response = parsed.data.jids.map((jid, i) => {
        const r = results[i];
        if (r.status === 'fulfilled') return { jid, success: true, messageId: r.value.messageId };
        logger.warn({ deviceId, jid, err: r.reason?.message }, 'Broadcast partial failure');
        return { jid, success: false, error: r.reason?.message ?? 'unknown' };
      });
      return ok(response);
    } catch (err) { sendError(err, reply); }
  });

  // ── Backward compat: legacy /send endpoint ─────────────────────────────────

  app.post('/api/clients/:clientId/devices/:deviceId/send', async (request: FastifyRequest, reply) => {
    const { clientId, deviceId } = request.params as DeviceParams;
    const parsed = legacySendSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    try {
      const manager = deviceManager.assertManager(clientId, deviceId);
      const msgId = await manager.sendMessage(resolveJid(parsed.data), parsed.data.text, (parsed.data as any).quotedId);
      return ok({ msgId });
    } catch (err) { sendError(err, reply); }
  });
}
