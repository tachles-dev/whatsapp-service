// routes.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { deviceManager } from './device-manager';
import { loadConfig } from './config';
import { getRedis } from './redis';
import { ServiceStatus, ApiResponse } from './types';
import { logger } from './logger';

// JID validation: must end with @s.whatsapp.net or @g.us
const jidPattern = /^[\d]+@(s\.whatsapp\.net|g\.us)$/;
// Phone number: digits only, 7-15 chars (E.164 without +)
const phonePattern = /^\d{7,15}$/;

const createDeviceSchema = z.object({
  name: z.string().min(1).max(100),
});

const sendMessageSchema = z
  .object({
    jid: z
      .string()
      .regex(jidPattern, 'Invalid JID format. Use number@s.whatsapp.net or number@g.us')
      .optional(),
    phone: z
      .string()
      .regex(phonePattern, 'Phone must be digits only (E.164 without +), e.g. 972501234567')
      .optional(),
    text: z.string().min(1).max(10_000),
    quotedId: z.string().optional(),
  })
  .refine((d) => d.jid || d.phone, { message: 'Provide either jid or phone' });

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, timestamp: Date.now(), data };
}

function fail(code: string, message: string): ApiResponse {
  return { success: false, timestamp: Date.now(), error: { code, message } };
}

type DeviceParams = { clientId: string; deviceId: string };
type JidParams = DeviceParams & { jid: string };

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const config = loadConfig();

  // API key guard — all routes except /api/status require it
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/api/status') return; // public

    const apiKey = request.headers['x-api-key'];
    if (apiKey !== config.API_KEY) {
      reply.code(401).send(fail('UNAUTHORIZED', 'Invalid or missing API key'));
    }
  });

  // ── Server-level ───────────────────────────────────────────────────────────

  // GET /api/status — public health check
  app.get('/api/status', async () => ok({ status: 'ok', timestamp: Date.now() }));

  // ── Device management ──────────────────────────────────────────────────────

  // GET /api/clients/:clientId/devices — list all devices for a client
  app.get('/api/clients/:clientId/devices', async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as { clientId: string };
    const infos = deviceManager.getClientInfos(clientId);
    const result = infos.map((info) => ({
      ...info,
      status: deviceManager.getManager(info.id)?.getStatusData() ?? null,
    }));
    return ok(result);
  });

  // POST /api/clients/:clientId/devices — register a new device (starts QR flow)
  app.post('/api/clients/:clientId/devices', async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = createDeviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    }

    try {
      const info = await deviceManager.createDevice(clientId, parsed.data.name);
      return reply.code(201).send(ok(info));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send(fail('CREATE_FAILED', message));
    }
  });

  // DELETE /api/clients/:clientId/devices/:deviceId — remove a device
  app.delete(
    '/api/clients/:clientId/devices/:deviceId',
    async (request: FastifyRequest, reply) => {
      const { clientId, deviceId } = request.params as DeviceParams;
      try {
        await deviceManager.removeDevice(clientId, deviceId);
        return ok({ deleted: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send(fail('NOT_FOUND', message));
      }
    },
  );

  // ── Device status / auth ───────────────────────────────────────────────────

  // GET /api/clients/:clientId/devices/:deviceId/status
  app.get(
    '/api/clients/:clientId/devices/:deviceId/status',
    async (request: FastifyRequest, reply) => {
      const { clientId, deviceId } = request.params as DeviceParams;
      try {
        const manager = deviceManager.assertManager(clientId, deviceId);
        return ok(manager.getStatusData());
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send(fail('NOT_FOUND', message));
      }
    },
  );

  // GET /api/clients/:clientId/devices/:deviceId/auth/qr
  app.get(
    '/api/clients/:clientId/devices/:deviceId/auth/qr',
    async (request: FastifyRequest, reply) => {
      const { clientId, deviceId } = request.params as DeviceParams;
      try {
        const manager = deviceManager.assertManager(clientId, deviceId);
        if (manager.getStatus() === ServiceStatus.CONNECTED) {
          return ok({ qr: null, message: 'Already connected' });
        }

        let qr = manager.getQr();
        if (!qr) {
          const redis = getRedis();
          qr = await redis.get(`wa:qr:${deviceId}`);
        }

        if (!qr) {
          return reply
            .code(404)
            .send(fail('QR_NOT_AVAILABLE', 'QR not yet generated. Wait for initialization.'));
        }

        return ok({ qr });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send(fail('NOT_FOUND', message));
      }
    },
  );

  // POST /api/clients/:clientId/devices/:deviceId/auth/reset
  app.post(
    '/api/clients/:clientId/devices/:deviceId/auth/reset',
    async (request: FastifyRequest, reply) => {
      const { clientId, deviceId } = request.params as DeviceParams;
      try {
        const manager = deviceManager.assertManager(clientId, deviceId);
        await manager.resetAuth();
        return ok({ message: 'Auth cleared. New QR will be generated shortly.' });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send(fail('RESET_FAILED', message));
      }
    },
  );

  // ── Messaging ──────────────────────────────────────────────────────────────

  // POST /api/clients/:clientId/devices/:deviceId/send
  app.post(
    '/api/clients/:clientId/devices/:deviceId/send',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { clientId, deviceId } = request.params as DeviceParams;
      const parsed = sendMessageSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
      }

      const { jid, phone, text, quotedId } = parsed.data;
      const resolvedJid = jid ?? `${phone}@s.whatsapp.net`;

      try {
        const manager = deviceManager.assertManager(clientId, deviceId);
        const msgId = await manager.sendMessage(resolvedJid, text, quotedId);
        return ok({ msgId });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, jid: resolvedJid, deviceId }, 'Failed to send message');
        return reply.code(503).send(fail('SEND_FAILED', message));
      }
    },
  );

  // ── Chats ──────────────────────────────────────────────────────────────────

  // GET /api/clients/:clientId/devices/:deviceId/chats?q=
  app.get(
    '/api/clients/:clientId/devices/:deviceId/chats',
    async (request: FastifyRequest, reply) => {
      const { clientId, deviceId } = request.params as DeviceParams;
      try {
        const manager = deviceManager.assertManager(clientId, deviceId);
        const q = ((request.query as Record<string, string>).q ?? '').trim() || undefined;
        const chats = await manager.getChats(q);
        return ok(chats);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, deviceId }, 'Failed to fetch chats');
        return reply.code(503).send(fail('CHATS_FAILED', message));
      }
    },
  );

  // ── Subscriptions ──────────────────────────────────────────────────────────

  // GET /api/clients/:clientId/devices/:deviceId/groups/subscribed
  app.get(
    '/api/clients/:clientId/devices/:deviceId/groups/subscribed',
    async (request: FastifyRequest, reply) => {
      const { clientId, deviceId } = request.params as DeviceParams;
      try {
        const manager = deviceManager.assertManager(clientId, deviceId);
        const jids = await manager.getSubscribed();
        return ok(jids);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(503).send(fail('SUBSCRIBE_FAILED', message));
      }
    },
  );

  // POST /api/clients/:clientId/devices/:deviceId/groups/:jid/subscribe
  app.post(
    '/api/clients/:clientId/devices/:deviceId/groups/:jid/subscribe',
    async (request: FastifyRequest, reply) => {
      const { clientId, deviceId, jid } = request.params as JidParams;
      if (!jidPattern.test(jid)) {
        return reply.code(400).send(fail('VALIDATION_ERROR', 'Invalid JID'));
      }
      try {
        const manager = deviceManager.assertManager(clientId, deviceId);
        await manager.subscribe(jid);
        return ok({ jid, subscribed: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send(fail('NOT_FOUND', message));
      }
    },
  );

  // DELETE /api/clients/:clientId/devices/:deviceId/groups/:jid/subscribe
  app.delete(
    '/api/clients/:clientId/devices/:deviceId/groups/:jid/subscribe',
    async (request: FastifyRequest, reply) => {
      const { clientId, deviceId, jid } = request.params as JidParams;
      try {
        const manager = deviceManager.assertManager(clientId, deviceId);
        await manager.unsubscribe(jid);
        return ok({ jid, subscribed: false });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send(fail('NOT_FOUND', message));
      }
    },
  );

  // ── Disconnect / Reconnect ─────────────────────────────────────────────────

  // POST /api/clients/:clientId/devices/:deviceId/disconnect
  // Stops the socket (no auto-reconnect). Device registration + auth files kept.
  app.post(
    '/api/clients/:clientId/devices/:deviceId/disconnect',
    async (request: FastifyRequest, reply) => {
      const { clientId, deviceId } = request.params as DeviceParams;
      try {
        const manager = deviceManager.assertManager(clientId, deviceId);
        await manager.close();
        return ok({ disconnected: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send(fail('NOT_FOUND', message));
      }
    },
  );

  // POST /api/clients/:clientId/devices/:deviceId/reconnect
  // Re-initiates the connection (will show QR if not yet paired).
  app.post(
    '/api/clients/:clientId/devices/:deviceId/reconnect',
    async (request: FastifyRequest, reply) => {
      const { clientId, deviceId } = request.params as DeviceParams;
      try {
        const manager = deviceManager.assertManager(clientId, deviceId);
        await manager.start();
        return ok({ reconnecting: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send(fail('NOT_FOUND', message));
      }
    },
  );

  // ── Ban list ───────────────────────────────────────────────────────────────

  const phoneBodySchema = z.object({
    phone: z.string().regex(phonePattern, 'Phone must be digits only (E.164 without +), e.g. 972501234567'),
  });

  // GET /api/clients/:clientId/banned-numbers
  app.get('/api/clients/:clientId/banned-numbers', async (request: FastifyRequest) => {
    const { clientId } = request.params as { clientId: string };
    const numbers = await deviceManager.getBannedNumbers(clientId);
    return ok(numbers);
  });

  // POST /api/clients/:clientId/banned-numbers — add a number to the ban list
  app.post('/api/clients/:clientId/banned-numbers', async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = phoneBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    }
    await deviceManager.addBannedNumber(clientId, parsed.data.phone);
    return ok({ phone: parsed.data.phone, banned: true });
  });

  // DELETE /api/clients/:clientId/banned-numbers/:phone — lift a ban
  app.delete('/api/clients/:clientId/banned-numbers/:phone', async (request: FastifyRequest, reply) => {
    const { clientId, phone } = request.params as { clientId: string; phone: string };
    if (!phonePattern.test(phone)) {
      return reply.code(400).send(fail('VALIDATION_ERROR', 'Invalid phone number format'));
    }
    await deviceManager.removeBannedNumber(clientId, phone);
    return ok({ phone, banned: false });
  });

  // ── Allow list ─────────────────────────────────────────────────────────────

  // GET /api/clients/:clientId/allowed-numbers
  // Empty array = open mode (all non-banned numbers allowed).
  // Non-empty = whitelist; only listed numbers may connect.
  app.get('/api/clients/:clientId/allowed-numbers', async (request: FastifyRequest) => {
    const { clientId } = request.params as { clientId: string };
    const numbers = await deviceManager.getAllowedNumbers(clientId);
    return ok(numbers);
  });

  // POST /api/clients/:clientId/allowed-numbers — add a number to the allowlist
  app.post('/api/clients/:clientId/allowed-numbers', async (request: FastifyRequest, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = phoneBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(fail('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; ')));
    }
    await deviceManager.addAllowedNumber(clientId, parsed.data.phone);
    return ok({ phone: parsed.data.phone, allowed: true });
  });

  // DELETE /api/clients/:clientId/allowed-numbers/:phone — remove from allowlist
  app.delete('/api/clients/:clientId/allowed-numbers/:phone', async (request: FastifyRequest, reply) => {
    const { clientId, phone } = request.params as { clientId: string; phone: string };
    if (!phonePattern.test(phone)) {
      return reply.code(400).send(fail('VALIDATION_ERROR', 'Invalid phone number format'));
    }
    await deviceManager.removeAllowedNumber(clientId, phone);
    return ok({ phone, allowed: false });
  });
}
