// errors.ts — Typed application error class.
import { ErrorCode, ServiceStatus } from './types';

/**
 * Application error with a typed code, HTTP status, and retryability hint.
 *
 * Throw AppError from any layer (adapter, route handler, service) for errors that
 * should be serialised as structured JSON responses. Route handlers catch it and
 * forward the code + status verbatim to the client.
 *
 * @example
 *   throw new AppError(ErrorCode.DEVICE_NOT_CONNECTED, 'Device is offline', 503, true);
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  /** Whether the client should retry after a brief pause. */
  readonly retryable: boolean;
  /** Optional field name for validation errors. */
  readonly field?: string;

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus: number,
    retryable: boolean,
    field?: string,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.field = field;
  }
}

/** Throws DEVICE_NOT_CONNECTED (503, retryable) if the device isn't in CONNECTED state. */
export function assertConnected(status: ServiceStatus, deviceId: string): void {
  if (status !== ServiceStatus.CONNECTED) {
    throw new AppError(
      ErrorCode.DEVICE_NOT_CONNECTED,
      `Device ${deviceId} is not connected (current status: ${status}). Scan the QR or wait for reconnection.`,
      503,
      true,
    );
  }
}
