/**
 * Retries for LLM calls: 429 (rate limit) and 5xx with exponential backoff, honouring the
 * server's retryDelay when it sends one. A DAILY quota error is not retried — waiting seconds
 * will not help — and becomes a clear message instead.
 */
import { LlmUnavailableError } from './types';

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; status: number }) => void;
  /** Shown when the daily quota is gone. */
  quotaHint?: string;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RETRIABLE = new Set([429, 500, 502, 503, 504]);

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

/** Gemini puts a RetryInfo with e.g. "retryDelay": "17s" in the error details. */
export function retryDelayMs(err: unknown): number | undefined {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(String((err as Error)?.message ?? ''));
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
}

/** A per-day quota violation (vs. a per-minute one). */
export function isDailyQuota(err: unknown): boolean {
  return statusOf(err) === 429 && /per ?day|PerDay/i.test(String((err as Error)?.message ?? ''));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 2_000;
  const max = opts.maxDelayMs ?? 60_000;
  const wait = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);
      if (isDailyQuota(err)) {
        throw new LlmUnavailableError(
          `The Gemini daily free-tier quota is used up. ${opts.quotaHint ?? ''}`.trim(),
          { cause: err },
        );
      }
      if (status === undefined || !RETRIABLE.has(status)) throw err;
      if (attempt >= retries) {
        throw new LlmUnavailableError(
          status === 429
            ? 'Gemini is rate-limiting requests right now. Please wait a minute and try again.'
            : `Gemini is temporarily unavailable (HTTP ${status}). Please try again shortly.`,
          { cause: err },
        );
      }
      const delayMs = Math.min(max, retryDelayMs(err) ?? base * 2 ** attempt);
      opts.onRetry?.({ attempt: attempt + 1, delayMs, status });
      await wait(delayMs);
    }
  }
}
