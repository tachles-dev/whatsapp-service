// routes/helpers.ts — Shared utilities for all route modules.
import { FastifyReply } from 'fastify';
import { ApiResponse, ErrorCode } from '../types';
import { AppError } from '../errors';
import { logger } from '../logger';

export function ok<T>(data: T): ApiResponse<T> {
  return { success: true, timestamp: Date.now(), data };
}

export function fail(code: string, message: string): ApiResponse {
  return { success: false, timestamp: Date.now(), error: { code, message } };
}

/** Converts any thrown error to a Fastify reply, preserving AppError HTTP status/code. */
export function sendError(err: unknown, reply: FastifyReply): void {
  if (err instanceof AppError) {
    reply.code(err.httpStatus).send(fail(err.code, err.message));
    return;
  }
  logger.error({ err }, 'Unhandled error in route handler');
  reply.code(500).send(fail(ErrorCode.INTERNAL_ERROR, 'An internal error occurred'));
}

// JID validation: supports group JIDs (digits@g.us, digits-digits@g.us) and phone JIDs
export const jidPattern = /^(\d+-\d+|\d+)@(s\.whatsapp\.net|g\.us)$/;
// Phone number: digits only, 7–15 chars (E.164 without leading +)
export const phonePattern = /^\d{7,15}$/;

/** Decodes a URL-encoded JID path param and validates its format. Throws 400 on invalid JID. */
export function validateJid(rawJid: string): string {
  const jid = decodeURIComponent(rawJid);
  if (!jidPattern.test(jid)) {
    throw new AppError(ErrorCode.INVALID_JID, 'Invalid JID format', 400, false);
  }
  return jid;
}

/** Returns true if the URL points to a private/internal address that must not be fetched. */
export function isBlockedMediaUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === '0.0.0.0') return true;
    if (/^10\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    if (/^0\./.test(host)) return true;
    if (/^0x[0-9a-f]+$/i.test(host) || /^0[0-7]+$/.test(host)) return true;
    if (host === 'metadata.google.internal' || host.endsWith('.internal') || host.endsWith('.local')) return true;
    if (/^\[?fe80:/i.test(host) || /^\[?fc00:/i.test(host) || /^\[?fd[0-9a-f]{2}:/i.test(host)) return true;
    const dockerHosts = ['app', 'redis', 'caddy', 'redisinsight'];
    if (dockerHosts.includes(host)) return true;
    return false;
  } catch {
    return true;
  }
}
