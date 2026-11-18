/**
 * Structured request logs for Cloud Logging (LOG_FORMAT=json): one JSON line per request on
 * stdout. Cloud Run turns each line into a log entry and reads `severity`, `httpRequest` and
 * `logging.googleapis.com/trace` from it.
 *
 * `auth` records WHICH header the bearer token was read from — never the token itself — so the
 * logs show that GCP API Gateway forwarded the user's token as X-Forwarded-Authorization.
 */
import type { Request, RequestHandler } from 'express';

export type TokenSource = 'x-forwarded-authorization' | 'authorization' | 'none';

/** Same precedence as bearerToken() in auth/middleware.ts. */
export function tokenSource(req: Request): TokenSource {
  if (req.get('x-forwarded-authorization')) return 'x-forwarded-authorization';
  if (req.get('authorization')) return 'authorization';
  return 'none';
}

export interface RequestLogOptions {
  /** GCP project id; links the entry to Cloud Trace when the request carried a trace header. */
  projectId?: string;
  write?: (line: string) => void;
  now?: () => bigint;
}

const severityOf = (status: number): 'INFO' | 'WARNING' | 'ERROR' =>
  status >= 500 ? 'ERROR' : status >= 400 ? 'WARNING' : 'INFO';

export function requestLog(opts: RequestLogOptions = {}): RequestHandler {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = opts.now ?? (() => process.hrtime.bigint());
  return (req, res, next) => {
    const started = now();
    const auth = tokenSource(req);
    res.on('finish', () => {
      const ms = Number(now() - started) / 1e6;
      const path = req.originalUrl.split('?')[0] ?? req.originalUrl;
      const fromGcp = req.get('x-cloud-trace-context') !== undefined;
      write(
        JSON.stringify({
          severity: severityOf(res.statusCode),
          message: `${req.method} ${path} ${res.statusCode} ${ms.toFixed(1)} ms`,
          httpRequest: {
            requestMethod: req.method,
            requestUrl: path, // no query string
            status: res.statusCode,
            latency: `${(ms / 1000).toFixed(4)}s`,
            userAgent: req.get('user-agent'),
          },
          traceId: req.traceId,
          auth,
          ...(opts.projectId && fromGcp
            ? { 'logging.googleapis.com/trace': `projects/${opts.projectId}/traces/${req.traceId}` }
            : {}),
        }),
      );
    });
    next();
  };
}

/** Unhandled errors as one structured ERROR entry (stack included, no request data). */
export function jsonErrorLog(
  write: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
) {
  return (msg: string, err: unknown): void => {
    write(
      JSON.stringify({
        severity: 'ERROR',
        message: `${msg}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      }),
    );
  };
}
