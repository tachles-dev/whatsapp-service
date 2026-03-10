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

const sendMessageSchema = z.object({
  jid: z.string().regex(jidPattern, 'Invalid JID format. Use number@s.whatsapp.net or number@g.us'),
  text: z.string().min(1).max(10_000),
  quotedId: z.string().optional(),
});

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

    const { jid, text, quotedId } = parsed.data;

    try {
      const msgId = await connectionManager.sendMessage(jid, text, quotedId);
      return ok({ msgId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err, jid }, 'Failed to send message');
      return reply.code(503).send(fail('SEND_FAILED', message));
    }
  });

  // GET /api/chats — list available chats (groups)
  app.get('/api/chats', async (_req, reply) => {
    try {
      const chats = await connectionManager.getChats();
      return ok(chats);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err }, 'Failed to fetch chats');
      return reply.code(503).send(fail('CHATS_FAILED', message));
    }
  });
}
