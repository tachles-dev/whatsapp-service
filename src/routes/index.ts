// routes/index.ts — Entry point: registers the global auth hook and all route sub-modules.
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../config';
import { fail, ok } from './helpers';
import { registerConfigRoutes } from './config';
import { registerDeviceRoutes } from './devices';
import { registerMessageRoutes } from './messages';
import { registerContactRoutes } from './contacts';
import { registerChatRoutes } from './chats';
import { registerGroupRoutes } from './groups';
import { registerAccessRoutes } from './access';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const config = loadConfig();

  // ── Global auth guard ────────────────────────────────────────────────────
  // All routes require x-api-key except the public health check.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/api/status') return;
    const apiKey = request.headers['x-api-key'];
    if (apiKey !== config.API_KEY) {
      reply.code(401).send(fail('UNAUTHORIZED', 'Invalid or missing API key'));
    }
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
}
