import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { FastifyRequest } from 'fastify';
import { loadConfig } from './config';
import { getRedis } from './redis';

const COOKIE_PATH = '/';

function sessionKey(hash: string): string {
  return `wa:admin:session:${hash}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secureCompare(left: string, right: string): boolean {
  const l = Buffer.from(left);
  const r = Buffer.from(right);
  if (l.length !== r.length) return false;
  return timingSafeEqual(l, r);
}

export function adminPasswordConfigured(): boolean {
  const config = loadConfig();
  return !!config.ADMIN_USERNAME && !!config.ADMIN_PASSWORD;
}

export function parseCookies(headerValue: string | undefined): Record<string, string> {
  if (!headerValue) return {};
  return headerValue.split(';').reduce<Record<string, string>>((acc, part) => {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return acc;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

export async function createAdminSession(): Promise<string> {
  const config = loadConfig();
  const token = randomBytes(32).toString('hex');
  const hash = sha256(token);
  await getRedis().set(sessionKey(hash), JSON.stringify({ createdAt: Date.now() }), 'PX', config.ADMIN_SESSION_TTL_MS);
  return token;
}

export async function revokeAdminSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await getRedis().del(sessionKey(sha256(token)));
}

export function buildAdminSessionCookie(token: string, secure: boolean): string {
  const config = loadConfig();
  return [
    `${config.ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    `Max-Age=${Math.floor(config.ADMIN_SESSION_TTL_MS / 1000)}`,
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export function buildAdminSessionClearCookie(secure: boolean): string {
  const config = loadConfig();
  return [
    `${config.ADMIN_SESSION_COOKIE}=`,
    'Max-Age=0',
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export async function isValidAdminSession(request: FastifyRequest): Promise<boolean> {
  const config = loadConfig();
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[config.ADMIN_SESSION_COOKIE];
  if (!token) return false;
  const raw = await getRedis().get(sessionKey(sha256(token)));
  return !!raw;
}

export function validateAdminCredentials(username: string, password: string): boolean {
  const config = loadConfig();
  if (!config.ADMIN_USERNAME || !config.ADMIN_PASSWORD) return false;
  return secureCompare(username, config.ADMIN_USERNAME) && secureCompare(password, config.ADMIN_PASSWORD);
}

export function isSecureRequest(request: FastifyRequest): boolean {
  const forwardedProto = request.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') return forwardedProto.includes('https');
  return request.protocol === 'https';
}