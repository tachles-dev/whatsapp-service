// routes.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { connectionManager } from './connection';
import { loadConfig } from './config';
import { getRedis } from './redis';
import { ServiceStatus, ApiResponse } from './types';
import { logger } from './logger';

// JID validation: must end with @s.whatsapp.net or @g.us
const jidPattern = /^[\d]+@(s\.whatsapp\.net|g\.us)$/;
// Phone number: digits only, 7-15 chars (E.164 without +)
const phonePattern = /^\d{7,15}$/;

const sendMessageSchema = z.object({
  jid: z.string().regex(jidPattern, 'Invalid JID format. Use number@s.whatsapp.net or number@g.us').optional(),
  phone: z.string().regex(phonePattern, 'Phone must be digits only (E.164 without +), e.g. 972501234567').optional(),
  text: z.string().min(1).max(10_000),
  quotedId: z.string().optional(),
}).refine((d) => d.jid || d.phone, { message: 'Provide either jid or phone' });

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, timestamp: Date.now(), data };
}

function fail(code: string, message: string): ApiResponse {
  return { success: false, timestamp: Date.now(), error: { code, message } };
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const config = loadConfig();

  // API key guard — all routes except /api/status require it
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url;
    if (path === '/api/status') return; // public

    const apiKey = request.headers['x-api-key'];
    if (apiKey !== config.API_KEY) {
      reply.code(401).send(fail('UNAUTHORIZED', 'Invalid or missing API key'));
    }
  });

  // GET /api/status — public health check
  app.get('/api/status', async () => {
    const data = connectionManager.getStatusData();
    // Augment with Redis QR fallback when memory QR is null
    if (data.qr === null && data.status !== ServiceStatus.CONNECTED) {
      const redis = getRedis();
      data.qr = await redis.get('wa:qr');
    }
    return ok(data);
  });

  // POST /api/auth/reset — clear auth files and force a fresh QR
  app.post('/api/auth/reset', async (_req, reply) => {
    try {
      await connectionManager.resetAuth();
      return ok({ message: 'Auth cleared. New QR will be generated shortly.' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send(fail('RESET_FAILED', msg));
    }
  });

  // GET /api/auth/qr — returns QR code for initial pairing
  app.get('/api/auth/qr', async (_req, reply) => {
    const status = connectionManager.getStatus();
    if (status === ServiceStatus.CONNECTED) {
      return reply.code(200).send(ok({ qr: null, message: 'Already connected' }));
    }

    // Try in-memory first, then Redis fallback
    let qr = connectionManager.getQr();
    if (!qr) {
      const redis = getRedis();
      qr = await redis.get('wa:qr');
    }

    if (!qr) {
      return reply.code(404).send(fail('QR_NOT_AVAILABLE', 'QR code not yet generated. Wait for initialization.'));
    }

    return ok({ qr });
  });

  // POST /api/send — send a message
  app.post('/api/send', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')),
      );
    }

    const { jid, phone, text, quotedId } = parsed.data;
    const resolvedJid = jid ?? `${phone}@s.whatsapp.net`;

    try {
      const msgId = await connectionManager.sendMessage(resolvedJid, text, quotedId);
      return ok({ msgId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err, jid: resolvedJid }, 'Failed to send message');
      return reply.code(503).send(fail('SEND_FAILED', message));
    }
  });

  // GET /api/groups/subscribed — list subscribed chats
  app.get('/api/groups/subscribed', async (_req, reply) => {
    try {
      const jids = await connectionManager.getSubscribed();
      return ok(jids);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(503).send(fail('SUBSCRIBE_FAILED', message));
    }
  });

  // POST /api/groups/:jid/subscribe — start receiving messages from a chat
  app.post('/api/groups/:jid/subscribe', async (request: FastifyRequest, reply) => {
    const jid = (request.params as { jid: string }).jid;
    if (!jidPattern.test(jid)) {
      return reply.code(400).send(fail('VALIDATION_ERROR', 'Invalid JID'));
    }
    await connectionManager.subscribe(jid);
    return ok({ jid, subscribed: true });
  });

  // DELETE /api/groups/:jid/subscribe — stop receiving messages from a chat
  app.delete('/api/groups/:jid/subscribe', async (request: FastifyRequest, reply) => {
    const jid = (request.params as { jid: string }).jid;
    await connectionManager.unsubscribe(jid);
    return ok({ jid, subscribed: false });
  });

  // GET /api/chats — list chats, optional ?q= filter by name or phone
  app.get('/api/chats', async (request: FastifyRequest, reply) => {
    try {
      const q = ((request.query as Record<string, string>).q ?? '').trim().toLowerCase();
      let chats = await connectionManager.getChats();
      if (q) {
        chats = chats.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            (c.phone && c.phone.includes(q)),
        );
      }
      return ok(chats);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err }, 'Failed to fetch chats');
      return reply.code(503).send(fail('CHATS_FAILED', message));
    }
  });
}
