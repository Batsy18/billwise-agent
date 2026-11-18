/**
 * Tool trace: every step to the console (compact) and to traces/<timestamp>.json (full).
 * Never receives the password or the JWT, so they cannot end up in a trace.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LlmTiming, Usage } from './llm/types';
import type { GateEvent } from './tools/payment-gate';

export const DEFAULT_TRACE_DIR = path.resolve(__dirname, '../traces');

export type TraceStep =
  | {
      type: 'llm';
      turn: number;
      /** Wall clock of the whole turn = timing.pacingMs + Σ retries + timing.apiMs (+ overhead). */
      durationMs: number;
      usage?: Usage;
      timing?: LlmTiming;
      toolCalls: string[];
    }
  | {
      type: 'tool';
      name: string;
      input: Record<string, unknown>;
      result: unknown;
      durationMs: number;
      /** pay_bill only: the payment gate's steps in order. */
      events?: GateEvent[];
    }
  | { type: 'final'; answer: string; reason: 'llm' | 'max_turns' | 'llm_unavailable' };

export interface Exchange {
  question: string;
  startedAt: string;
  steps: TraceStep[];
}

export interface TraceOptions {
  dir?: string;
  print?: (line: string) => void;
  now?: () => Date;
  meta?: Record<string, unknown>;
}

/** One-line summary of a tool result for the console. */
export function summarizeResult(name: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  if (name === 'search_billing_documentation') {
    const m = (r.matches as { section: string }[] | undefined) ?? [];
    return m.length
      ? `sections ${m.map((x) => x.section).join(', ')}`
      : `no matches${r.status ? ` (${str(r.status)})` : ''}`;
  }
  const bill = r.bill as Record<string, unknown> | undefined;
  if (r.status === 'ok' && bill) {
    return `total ${String(bill.total)}, paid ${String(bill.paidAmount)}, remaining ${String(bill.remainingBalance)}, ${String(bill.status)}`;
  }
  if (r.status === 'paid') {
    const p = r.payment as Record<string, unknown>;
    return `paid${r.idempotentReplay ? ' (idempotent replay)' : ''}, remaining ${String(p.remainingBalance)}, ${String(p.billStatus)}`;
  }
  return str(r.status ?? 'done');
}

export class Trace {
  readonly exchanges: Exchange[] = [];
  readonly file: string;
  private readonly print: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly opts: TraceOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.print = opts.print ?? ((l) => console.log(l));
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    this.file = path.join(opts.dir ?? DEFAULT_TRACE_DIR, `${stamp}.json`);
  }

  private get current(): Exchange {
    const e = this.exchanges[this.exchanges.length - 1];
    if (!e) throw new Error('trace: no question started');
    return e;
  }

  question(text: string): void {
    this.exchanges.push({ question: text, startedAt: this.now().toISOString(), steps: [] });
  }

  llm(step: Omit<Extract<TraceStep, { type: 'llm' }>, 'type'>): void {
    this.current.steps.push({ type: 'llm', ...step });
    const u = step.usage;
    this.print(
      `  · LLM turn ${step.turn} (${step.durationMs} ms${step.timing ? `: ${formatTiming(step.timing)}` : ''}` +
        `${u ? ` | ${u.inputTokens} in / ${u.outputTokens} out${u.thinkingTokens ? ` / ${u.thinkingTokens} thinking` : ''}` : ''})` +
        (step.toolCalls.length ? ` → ${step.toolCalls.join(', ')}` : ''),
    );
  }

  /** Payment gate step, printed while it happens (before the tool line). */
  gateEvent(e: GateEvent): void {
    this.print(`    ↳ ${formatGateEvent(e)}`);
  }

  tool(step: Omit<Extract<TraceStep, { type: 'tool' }>, 'type'>): void {
    this.current.steps.push({ type: 'tool', ...step });
    this.print(
      `  ▶ ${step.name} ${JSON.stringify(step.input)} (${step.durationMs} ms) → ${summarizeResult(step.name, step.result)}`,
    );
  }

  final(answer: string, reason: Extract<TraceStep, { type: 'final' }>['reason']): void {
    this.current.steps.push({ type: 'final', answer, reason });
  }

  totalUsage(): Usage & { requests: number } {
    const t = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, requests: 0 };
    for (const e of this.exchanges) {
      for (const s of e.steps) {
        if (s.type !== 'llm') continue;
        t.requests += 1;
        t.inputTokens += s.usage?.inputTokens ?? 0;
        t.outputTokens += s.usage?.outputTokens ?? 0;
        t.thinkingTokens += s.usage?.thinkingTokens ?? 0;
      }
    }
    return t;
  }

  save(): string {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(
      this.file,
      JSON.stringify(
        { ...this.opts.meta, usage: this.totalUsage(), exchanges: this.exchanges },
        null,
        2,
      ),
    );
    return this.file;
  }
}

/** Readable string for any JSON value (no "[object Object]"). */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** "Gemini 1210 ms, pacing 3900 ms, retry 6000 ms [503, 429]" — only the non-zero parts. */
export function formatTiming(t: LlmTiming): string {
  const retryMs = t.retries.reduce((s, r) => s + r.delayMs, 0);
  const parts = [`Gemini ${t.apiMs} ms${t.attempts > 1 ? ` over ${t.attempts} attempts` : ''}`];
  if (t.pacingMs > 0) parts.push(`pacing ${t.pacingMs} ms`);
  if (t.retries.length)
    parts.push(`retry wait ${retryMs} ms [${t.retries.map((r) => r.status).join(', ')}]`);
  return parts.join(', ');
}

const money = (n: number | undefined) => (n === undefined ? '?' : `$${n.toFixed(2)}`);

export function formatGateEvent(e: GateEvent): string {
  const at = `+${e.elapsedMs} ms`;
  switch (e.event) {
    case 'balance_check':
      return e.httpStatus === 200
        ? `balance check (query_bill): total ${money(e.total)}, remaining ${money(e.remainingBalance)}, ${e.billStatus ?? ''} ${at}`
        : `balance check (query_bill): ${str(e.httpStatus)} ${at}`;
    case 'precheck_rejected':
      return `rejected before asking the user: ${e.outcome} ${at}`;
    case 'confirmation_shown':
      return `confirmation shown: ${money(e.summary.amount)} for ${e.summary.month}/${e.summary.year}, remaining ${money(e.summary.remainingBalance)} ${at}`;
    case 'user_answer':
      return `user answered "${e.answer}" → ${e.confirmed ? 'confirmed' : 'NOT confirmed'} ${at}`;
    case 'transaction_id':
      return `transactionId ${e.transactionId} ${at}`;
    case 'pay_attempt':
      return `POST /payments attempt ${e.attempt} (${e.transactionId}) → ${e.result} ${at}`;
    case 'retry_wait':
      return `retry ${e.attempt} in ${e.delayMs} ms (same transactionId) after ${e.reason} ${at}`;
    case 'api_result':
      return `API result: ${str(e.httpStatus)} → ${e.outcome}${e.idempotentReplay ? ' (idempotent replay)' : ''} ${at}`;
  }
}
