// routes/helpers.ts — Shared utilities for all route modules.
import { FastifyReply } from 'fastify';
import { ApiResponse, ErrorCode } from '../types';
import { AppError } from '../errors';

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
  const message = err instanceof Error ? err.message : String(err);
  reply.code(500).send(fail(ErrorCode.INTERNAL_ERROR, message));
}

// JID validation: supports group JIDs (digits@g.us, digits-digits@g.us) and phone JIDs
export const jidPattern = /^(\d+-\d+|\d+)@(s\.whatsapp\.net|g\.us)$/;
// Phone number: digits only, 7–15 chars (E.164 without leading +)
export const phonePattern = /^\d{7,15}$/;
