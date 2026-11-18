import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { z } from 'zod';
import { AppError, errorBody } from './errors';

declare module 'express-serve-static-core' {
  interface Request {
    traceId: string;
  }
}

const GCP_TRACE_RE = /^([0-9a-fA-F]{32})(?:\/|$)/; // X-Cloud-Trace-Context: TRACE_ID/SPAN_ID;o=1

/** Reuse the GCP trace id when present (logs line up in Cloud Logging), else a fresh UUID. */
export const traceId: RequestHandler = (req, res, next) => {
  const gcp = GCP_TRACE_RE.exec(req.get('x-cloud-trace-context') ?? '');
  req.traceId = gcp?.[1] ?? randomUUID();
  res.setHeader('X-Trace-Id', req.traceId);
  next();
};

/** Parse with zod or throw a 400 VALIDATION_ERROR naming the first offending field. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  throw new AppError('VALIDATION_ERROR', `${where}${issue?.message ?? 'invalid request'}`);
}

export const notFound: RequestHandler = (req) => {
  throw new AppError('NOT_FOUND', `No route for ${req.method} ${req.path}`);
};

interface HttpLikeError {
  type?: string;
  status?: number;
}

/** Last middleware: everything becomes { error: { code, message, traceId } }. */
export function errorHandler(log: (msg: string, err: unknown) => void): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    void _next;
    const id = req.traceId ?? randomUUID();
    let appErr: AppError;
    if (err instanceof AppError) {
      appErr = err;
    } else if (isBodyParserError(err)) {
      appErr = new AppError(
        'VALIDATION_ERROR',
        err.type === 'entity.parse.failed' ? 'Malformed JSON body' : 'Invalid request body',
      );
    } else {
      log(`[${id}] unhandled error`, err);
      appErr = new AppError('INTERNAL_ERROR', 'Unexpected server error'); // no internals leak
    }
    res.status(appErr.status).json(errorBody(appErr, id));
  };
}

function isBodyParserError(err: unknown): err is HttpLikeError {
  const e = err as HttpLikeError | null;
  return typeof e?.type === 'string' && typeof e.status === 'number' && e.status < 500;
}
