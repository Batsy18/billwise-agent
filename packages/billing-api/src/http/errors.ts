/**
 * The one error shape used everywhere: { "error": { "code", "message", "traceId", ...details } }.
 * Codes and statuses: vault note "API ve Veri Modeli" → Hata formatı (+ the extra codes in ADR #20).
 */
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  BILL_NOT_FOUND: 404,
  SUBSCRIBER_NOT_FOUND: 404,
  NOT_FOUND: 404,
  DUPLICATE_TRANSACTION: 409,
  AMOUNT_EXCEEDS_BALANCE: 422,
  BILL_ALREADY_PAID: 422,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Extra fields merged into the error object (e.g. existingPayment on a 409). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_STATUS[code];
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; traceId: string } & Record<string, unknown>;
}

export function errorBody(err: AppError, traceId: string): ErrorBody {
  return { error: { code: err.code, message: err.message, traceId, ...err.details } };
}
