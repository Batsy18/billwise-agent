/**
 * Executes the LLM's tool calls. The LLM only chooses; this code decides what is sent:
 *   - REST tools always use the session's own subscriber number (JWT `sub`); arguments are
 *     parsed with zod and anything extra (e.g. an invented subscriberNo) is dropped.
 *   - pay_bill goes through the payment gate.
 *   - Documentation search: after an empty result one retry is allowed per user message;
 *     further searches are answered without calling MCP (prompt says the same — belt and braces).
 */
import { z } from 'zod';
import { NetworkError, type BillingClient, type Session } from '../clients/billing';
import { DOCS_TOOL, type DocsClient } from '../clients/docs';
import type { ToolCall, ToolDeclaration } from '../llm/types';
import { payWithConfirmation, type ConfirmFn, type GateEvent } from './payment-gate';
import { REST_TOOLS } from './rest-tools';
import { errorOutcome, UNAVAILABLE, type ToolOutcome } from './results';

export const DETAILED_PAGE_SIZE = 10;

const periodArgs = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
});
const detailedArgs = periodArgs.extend({
  page: z.coerce.number().int().min(1).default(1),
});

export interface ExecutorDeps {
  billing: BillingClient;
  docs: DocsClient;
  session: Session;
  confirm: ConfirmFn;
  newTransactionId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

type SearchState = 'normal' | 'retry_allowed' | 'exhausted';

export class ToolExecutor {
  private searchState: SearchState = 'normal';

  constructor(private readonly deps: ExecutorDeps) {}

  get session(): Session {
    return this.deps.session;
  }

  declarations(): ToolDeclaration[] {
    return [this.deps.docs.tool, ...REST_TOOLS];
  }

  /** Called at the start of every user message. */
  startUserMessage(): void {
    this.searchState = 'normal';
  }

  async run(call: ToolCall, onGateEvent?: (e: GateEvent) => void): Promise<unknown> {
    switch (call.name) {
      case DOCS_TOOL:
        return this.search(call.args);
      case 'query_bill':
        return this.rest(periodArgs, call.args, (p) =>
          this.deps.billing.queryBill(this.session, p),
        );
      case 'query_bill_detailed':
        return this.rest(detailedArgs, call.args, ({ page, ...p }) =>
          this.deps.billing.queryBillDetailed(this.session, p, page, DETAILED_PAGE_SIZE),
        );
      case 'pay_bill':
        return payWithConfirmation(this.deps, call.args, onGateEvent);
      default:
        return { status: 'unknown_tool', message: `There is no tool named ${call.name}.` };
    }
  }

  private async rest<S extends z.ZodType>(
    schema: S,
    args: Record<string, unknown>,
    send: (a: z.output<S>) => ReturnType<BillingClient['queryBill']>,
  ): Promise<ToolOutcome> {
    const parsed = schema.safeParse(args); // z.object strips unknown keys (e.g. subscriberNo)
    if (!parsed.success) {
      return { status: 'invalid_arguments', message: parsed.error.issues[0]?.message ?? 'invalid' };
    }
    try {
      const r = await send(parsed.data);
      return r.status === 200 ? { status: 'ok', bill: r.body } : errorOutcome(r, this.session);
    } catch (err) {
      if (err instanceof NetworkError) return UNAVAILABLE;
      throw err;
    }
  }

  private async search(args: Record<string, unknown>): Promise<unknown> {
    if (this.searchState === 'exhausted') {
      return {
        status: 'no_more_retries',
        matches: [],
        message:
          'The guide was already searched again without results. Tell the user the billing guide does not cover this; do not answer from general knowledge.',
      };
    }
    let result: unknown;
    try {
      result = await this.deps.docs.call(args);
    } catch {
      return {
        status: 'docs_unavailable',
        matches: [],
        message: 'The documentation service is unavailable.',
      };
    }
    const empty = ((result as { matches?: unknown[] } | null)?.matches ?? []).length === 0;
    if (!empty) this.searchState = 'normal';
    else this.searchState = this.searchState === 'normal' ? 'retry_allowed' : 'exhausted';
    return result;
  }
}
