import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getApiOverview, getApiReference, getOpenApiDocument, LEGACY_API_BASE, renderApiDocsHtml, VERSIONED_API_BASE } from '../api-reference';
import { isValidAdminSession } from '../admin-auth';
import { loadConfig } from '../config';
import { verifyClientKey } from '../core/client-config';
import { deviceManager } from '../core/device-manager';
import { resolveInstanceBaseUrl } from '../instance-registry';
import { getLoadSnapshot } from '../load-monitor';
import { logger } from '../logger';
import { registerAccessRoutes } from './access';
import { registerAdminRoutes } from './admin';
import { registerChatRoutes } from './chats';
import { registerConfigRoutes } from './config';
import { registerContactRoutes } from './contacts';
import { registerDeviceRoutes } from './devices';
import { fail, ok } from './helpers';
import { registerGroupRoutes } from './groups';
import { registerMessageRoutes } from './messages';

const API_BASES = [LEGACY_API_BASE, VERSIONED_API_BASE] as const;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const ipHits = new Map<string, number[]>();

setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of ipHits) {
    const recent = timestamps.filter((timestamp) => timestamp > cutoff);
    if (recent.length === 0) ipHits.delete(ip);
    else ipHits.set(ip, recent);
  }
}, 120_000).unref();

function checkRateLimit(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  let timestamps = ipHits.get(ip);
  if (!timestamps) {
    timestamps = [];
    ipHits.set(ip, timestamps);
  }

  while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift();
  if (timestamps.length >= RATE_LIMIT_MAX) return { allowed: false, remaining: 0 };

  timestamps.push(now);
  return { allowed: true, remaining: RATE_LIMIT_MAX - timestamps.length };
}

function getPathname(request: FastifyRequest): string {
  const rawUrl = request.raw.url ?? request.url;
  const [pathname] = rawUrl.split('?');
  return pathname || '/';
}

function isPublicPath(pathname: string, adminEnabled: boolean): boolean {
  if (pathname === '/') return true;
  for (const apiBase of API_BASES) {
    if (pathname === apiBase) return true;
    if (pathname === `${apiBase}/reference`) return true;
    if (pathname === `${apiBase}/openapi.json`) return true;
    if (pathname === `${apiBase}/status`) return true;
    if (pathname === `${apiBase}/status/live`) return true;
    if (pathname === `${apiBase}/status/ready`) return true;
    if (pathname === `${apiBase}/admin/login`) return true;
  }
  if (pathname === '/admin' && adminEnabled) return true;
  return false;
}

function isAdminApiPath(pathname: string): boolean {
  return API_BASES.some((apiBase) => pathname.startsWith(`${apiBase}/admin/`));
}

function matchClientId(pathname: string): string | null {
  const match = pathname.match(/^\/api(?:\/v1)?\/clients\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function isDeviceScopedApiPath(pathname: string): boolean {
  return /^\/api(?:\/v1)?\/clients\//.test(pathname) && pathname.includes('/devices/');
}

async function registerDiscoveryRoutes(app: FastifyInstance, apiBase: typeof API_BASES[number]): Promise<void> {
  app.get(apiBase, async () => ok(getApiOverview(loadConfig().modules, apiBase, VERSIONED_API_BASE)));

  app.get(`${apiBase}/reference`, async () => ok(getApiReference(loadConfig().modules, apiBase, VERSIONED_API_BASE)));

  app.get(`${apiBase}/openapi.json`, async (_request, reply) => {
    reply.type('application/json').send(getOpenApiDocument(loadConfig().modules, apiBase, VERSIONED_API_BASE));
  });

  app.get(`${apiBase}/status`, async () => {
    const snapshot = await getLoadSnapshot();
    return ok(snapshot);
  });

  app.get(`${apiBase}/status/live`, async () => ok({ live: true, timestamp: Date.now() }));

  app.get(`${apiBase}/status/ready`, async (_request, reply) => {
    const snapshot = await getLoadSnapshot();
    if (!snapshot.ready) {
      return reply.code(503).send(fail('SERVICE_UNAVAILABLE', `Service not ready: ${snapshot.reasons.join(', ') || 'overloaded'}`));
    }
    return ok(snapshot);
  });
}

export async function maybeForwardDeviceRequest(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const config = loadConfig();
  if (!config.modules.ownerForwarding) return false;
  if (request.headers['x-wga-forwarded'] === '1') return false;

  const params = request.params as { clientId?: string; deviceId?: string };
  const clientId = params?.clientId;
  const deviceId = params?.deviceId;
  if (!clientId || !deviceId) return false;

  const info = deviceManager.getInfo(deviceId);
  if (!info || info.clientId !== clientId) return false;
  if (deviceManager.isOwnedLocally(deviceId)) return false;

  const ownerInstanceId = await deviceManager.getOwnerInstanceId(deviceId);
  if (!ownerInstanceId || ownerInstanceId === config.INSTANCE_ID) return false;

  const ownerBaseUrl = await resolveInstanceBaseUrl(ownerInstanceId);
  if (!ownerBaseUrl) {
    reply.code(503).send(fail('SERVICE_UNAVAILABLE', `Device ${deviceId} is owned by ${ownerInstanceId} but its instance endpoint is unavailable`));
    return true;
  }

  const url = new URL(request.raw.url || request.url, ownerBaseUrl).toString();
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (!value) continue;
    if (['host', 'content-length', 'connection'].includes(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  headers.set('x-wga-forwarded', '1');
  headers.set('x-wga-forwarded-by', config.INSTANCE_ID);

  const body = request.body === undefined
    ? undefined
    : typeof request.body === 'string'
      ? request.body
      : JSON.stringify(request.body);

  try {
    const upstream = await fetch(url, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
      signal: AbortSignal.timeout(10_000),
    });

    const contentType = upstream.headers.get('content-type');
    if (contentType) reply.header('content-type', contentType);
    reply.header('x-forwarded-to-instance', ownerInstanceId);
    reply.code(upstream.status);

    const text = await upstream.text();
    if (contentType?.includes('application/json')) {
      try {
        reply.send(JSON.parse(text));
      } catch {
        reply.send({ success: false, error: { code: 'BAD_UPSTREAM_RESPONSE', message: 'Owning instance returned invalid JSON' } });
      }
    } else {
      reply.send(text);
    }
    return true;
  } catch (err) {
    logger.error({ err, deviceId, ownerInstanceId, url }, 'Failed to forward request to owning instance');
    reply.code(503).send(fail('SERVICE_UNAVAILABLE', `Owning instance ${ownerInstanceId} is unavailable`));
    return true;
  }
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const config = loadConfig();

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-instance-id', config.INSTANCE_ID);

    const clientIp = request.ip;
    const { allowed, remaining } = checkRateLimit(clientIp);
    reply.header('x-ratelimit-limit', RATE_LIMIT_MAX);
    reply.header('x-ratelimit-remaining', remaining);
    if (!allowed) {
      logger.warn({ ip: clientIp, url: request.url }, 'Rate limit exceeded');
      reply.code(429).send(fail('RATE_LIMITED', 'Too many requests - try again later'));
      return;
    }

    const pathname = getPathname(request);
    if (isPublicPath(pathname, config.modules.admin)) return;

    const masterKey = config.API_KEY;
    const providedKey = request.headers['x-api-key'] as string | undefined;

    if (isAdminApiPath(pathname)) {
      if (providedKey === masterKey) return;
      if (await isValidAdminSession(request)) return;
      reply.code(401).send(fail('UNAUTHORIZED', 'Invalid admin session'));
      return;
    }

    if (providedKey === masterKey) return;

    const clientId = matchClientId(pathname);
    if (clientId && providedKey) {
      if (await verifyClientKey(clientId, providedKey, request.ip)) return;
    }

    reply.code(401).send(fail('UNAUTHORIZED', 'Invalid or missing API key'));
  });

  app.addHook('preHandler', async (request, reply) => {
    const pathname = getPathname(request);
    if (!isDeviceScopedApiPath(pathname)) return;
    if (reply.sent) return;
    await maybeForwardDeviceRequest(request, reply);
  });

  for (const apiBase of API_BASES) {
    await registerDiscoveryRoutes(app, apiBase);
    await registerConfigRoutes(app, apiBase);
    await registerDeviceRoutes(app, apiBase);
    await registerMessageRoutes(app, apiBase);
    await registerContactRoutes(app, apiBase);
    await registerChatRoutes(app, apiBase);
    await registerGroupRoutes(app, apiBase);
    await registerAccessRoutes(app, apiBase);
    if (config.modules.admin) {
      await registerAdminRoutes(app, apiBase, apiBase === LEGACY_API_BASE);
    }
  }

  app.get('/', async (_request, reply) => {
    reply.type('text/html').send(renderApiDocsHtml(config.modules, VERSIONED_API_BASE, VERSIONED_API_BASE));
  });
}

