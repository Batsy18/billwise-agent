/** Maps billing-api responses onto tool results the LLM can explain (never throws). */
import type { HttpResult, Session } from '../clients/billing';

export type ToolOutcome = Record<string, unknown> & { status: string };

export function apiErrorCode(r: HttpResult): string | undefined {
  return (r.body.error as { code?: string } | undefined)?.code;
}

function apiMessage(r: HttpResult): string | undefined {
  return (r.body.error as { message?: string } | undefined)?.message;
}

/** Non-2xx → outcome. 401 also marks the session expired so the CLI can re-login. */
export function errorOutcome(r: HttpResult, session: Session): ToolOutcome {
  if (r.status === 401) {
    session.expired = true;
    return {
      status: 'session_expired',
      message: 'The login session has expired. Ask the user to log in again; do not retry.',
    };
  }
  if (r.status === 404 && apiErrorCode(r) === 'BILL_NOT_FOUND') {
    return {
      status: 'not_calculated',
      message: 'No bill has been calculated for this period yet. Do not estimate one.',
    };
  }
  if (r.status === 403) return { status: 'forbidden', message: 'Access denied.' };
  if (r.status === 400)
    return { status: 'invalid_request', message: apiMessage(r) ?? 'Invalid request.' };
  if (r.status === 422)
    return { status: 'rejected', code: apiErrorCode(r), message: apiMessage(r) };
  if (r.status >= 500) {
    return {
      status: 'service_unavailable',
      message: 'The billing service is temporarily unavailable.',
    };
  }
  return { status: 'error', httpStatus: r.status, code: apiErrorCode(r), message: apiMessage(r) };
}

export const UNAVAILABLE: ToolOutcome = {
  status: 'service_unavailable',
  message: 'The billing service cannot be reached right now.',
};
