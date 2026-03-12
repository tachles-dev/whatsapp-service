// routes/index.ts — Entry point: registers the global auth hook and all route sub-modules.
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../config';
import { verifyClientKey } from '../core/client-config';
import { fail, ok } from './helpers';
import { registerConfigRoutes } from './config';
import { registerDeviceRoutes } from './devices';
import { registerMessageRoutes } from './messages';
import { registerContactRoutes } from './contacts';
import { registerChatRoutes } from './chats';
import { registerGroupRoutes } from './groups';
import { registerAccessRoutes } from './access';
import { registerAdminRoutes } from './admin';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const config = loadConfig();

  // ── Global auth guard ────────────────────────────────────────────────────
  // All routes require x-api-key except the public health check.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/api/status') return;
    if (request.url === '/admin') return;

    const masterKey = config.API_KEY;
    const providedKey = request.headers['x-api-key'] as string | undefined;

    // Master key: unrestricted access
    if (providedKey === masterKey) return;

    // Client key: allowed only on /api/clients/:clientId/* routes, for that specific client.
    // The key is verified by re-hashing the provided value — plaintext is never stored.
    const clientMatch = request.url.match(/^\/api\/clients\/([^/]+)/);
    if (clientMatch && providedKey) {
      const clientId = decodeURIComponent(clientMatch[1]);
      if (await verifyClientKey(clientId, providedKey, request.ip)) return;
    }

    reply.code(401).send(fail('UNAUTHORIZED', 'Invalid or missing API key'));
  });

  // ── Health check (public) ────────────────────────────────────────────────
  app.get('/api/status', async () => ok({ status: 'ok', timestamp: Date.now() }));

  // ── Domain route modules ─────────────────────────────────────────────────
  await registerConfigRoutes(app);
  await registerDeviceRoutes(app);
  await registerMessageRoutes(app);
  await registerContactRoutes(app);
  await registerChatRoutes(app);
  await registerGroupRoutes(app);
  await registerAccessRoutes(app);
  await registerAdminRoutes(app);
}
