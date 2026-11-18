/**
 * Payment confirmation gate — enforced in CODE, not left to the LLM (guide 5.2, 5.3).
 *
 *   1. query_bill first (fresh balance); no bill / already paid / amount too high → answered
 *      without asking the user.
 *   2. Show subscriber, period, amount, remaining balance; the user must type exactly EVET or
 *      YES (case-insensitive). Anything else → { status: "cancelled_by_user" }, no API call.
 *   3. One transactionId (UUID) per confirmed payment. Network errors and 502/503/504 are
 *      retried with the SAME id; a 409 carrying existingPayment means an earlier attempt
 *      already succeeded → success (idempotent replay).
 *   4. "paid" only when the API confirmed it.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NetworkError, type BillingClient, type Session } from '../clients/billing';
import { errorOutcome, UNAVAILABLE, type ToolOutcome } from './results';

export interface PaymentSummary {
  subscriberNo: string;
  month: number;
  year: number;
  amount: number;
  total: number;
  remainingBalance: number;
  dueDate: string;
}

/** Shows the summary and returns what the user typed. */
export type ConfirmFn = (summary: PaymentSummary) => Promise<string>;

export const CONFIRM_WORDS = /^(evet|yes)$/i;

export function isConfirmation(answer: string): boolean {
  return CONFIRM_WORDS.test(answer.trim());
}

const payArgs = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
  amount: z.coerce.number().positive().max(1_000_000),
});

const toCents = (dollars: number): number => Math.round(dollars * 100);
const hasTwoDecimals = (x: number): boolean => Math.round(x * 100) / 100 === x;

export interface PaymentGateDeps {
  billing: BillingClient;
  session: Session;
  confirm: ConfirmFn;
  newTransactionId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt, all with the same transactionId. */
  retries?: number;
}

const RETRIABLE_STATUS = new Set([502, 503, 504]);

/** Gate steps, reported as they happen (console) and stored in the pay_bill trace step. */
export type GateEvent = { elapsedMs: number } & (
  | {
      event: 'balance_check';
      httpStatus: number | 'network_error';
      total?: number;
      remainingBalance?: number;
      billStatus?: string;
    }
  | { event: 'precheck_rejected'; outcome: string }
  | { event: 'confirmation_shown'; summary: PaymentSummary }
  | { event: 'user_answer'; answer: string; confirmed: boolean }
  | { event: 'transaction_id'; transactionId: string }
  | { event: 'pay_attempt'; attempt: number; transactionId: string; result: string }
  | { event: 'retry_wait'; attempt: number; delayMs: number; reason: string }
  | {
      event: 'api_result';
      httpStatus: number | 'network_error';
      outcome: string;
      idempotentReplay?: boolean;
    }
);

type GateEventInput = GateEvent extends infer E
  ? E extends GateEvent
    ? Omit<E, 'elapsedMs'>
    : never
  : never;

export async function payWithConfirmation(
  deps: PaymentGateDeps,
  rawArgs: Record<string, unknown>,
  onEvent: (e: GateEvent) => void = () => undefined,
): Promise<ToolOutcome> {
  const started = Date.now();
  const emit = (e: GateEventInput) =>
    onEvent({ ...e, elapsedMs: Date.now() - started });
  const reject = (outcome: ToolOutcome): ToolOutcome => {
    emit({ event: 'precheck_rejected', outcome: outcome.status });
    return outcome;
  };

  const parsed = payArgs.safeParse(rawArgs);
  if (!parsed.success || !hasTwoDecimals(parsed.data.amount)) {
    return reject({
      status: 'invalid_amount',
      message: 'Amount must be a positive number of dollars with at most 2 decimals.',
    });
  }
  const { month, year, amount } = parsed.data;
  const { billing, session } = deps;

  // 1. Fresh balance first.
  let bill;
  try {
    bill = await billing.queryBill(session, { month, year });
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
    emit({ event: 'balance_check', httpStatus: 'network_error' });
    return reject(UNAVAILABLE);
  }
  emit({
    event: 'balance_check',
    httpStatus: bill.status,
    ...(bill.status === 200
      ? {
          total: Number(bill.body.total),
          remainingBalance: Number(bill.body.remainingBalance),
          billStatus: String(bill.body.status),
        }
      : {}),
  });
  if (bill.status !== 200) return reject(errorOutcome(bill, session));
  const remaining = Number(bill.body.remainingBalance);
  if (remaining <= 0) return reject({ status: 'already_paid', bill: bill.body });
  if (toCents(amount) > toCents(remaining)) {
    return reject({
      status: 'rejected',
      reason: 'amount_exceeds_balance',
      remainingBalance: remaining,
    });
  }

  // 2. Explicit confirmation by the user.
  const summary: PaymentSummary = {
    subscriberNo: session.subscriberNo,
    month,
    year,
    amount,
    total: Number(bill.body.total),
    remainingBalance: remaining,
    dueDate: String(bill.body.dueDate),
  };
  emit({ event: 'confirmation_shown', summary });
  const answer = await deps.confirm(summary);
  const confirmed = isConfirmation(answer);
  emit({ event: 'user_answer', answer: answer.trim(), confirmed });
  if (!confirmed) {
    return {
      status: 'cancelled_by_user',
      message: 'The user did not confirm. No payment was made.',
    };
  }

  // 3. One id, retried unchanged.
  const transactionId = (deps.newTransactionId ?? randomUUID)();
  emit({ event: 'transaction_id', transactionId });
  const retries = deps.retries ?? 3;
  const wait = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await billing.pay(session, { month, year, amount, transactionId });
    } catch (err) {
      if (!(err instanceof NetworkError)) throw err;
      res = undefined;
    }
    const result = res ? `HTTP ${res.status}` : 'network_error';
    emit({ event: 'pay_attempt', attempt: attempt + 1, transactionId, result });
    if (res && !RETRIABLE_STATUS.has(res.status)) {
      let outcome: ToolOutcome;
      const existing = (res.body.error as { existingPayment?: unknown } | undefined)
        ?.existingPayment;
      if (res.status === 200) outcome = { status: 'paid', transactionId, payment: res.body };
      else if (res.status === 409 && existing) {
        outcome = { status: 'paid', idempotentReplay: true, transactionId, payment: existing };
      } else outcome = errorOutcome(res, session);
      emit({
        event: 'api_result',
        httpStatus: res.status,
        outcome: outcome.status,
        ...(outcome.idempotentReplay ? { idempotentReplay: true } : {}),
      });
      return outcome;
    }
    if (attempt >= retries) {
      emit({
        event: 'api_result',
        httpStatus: res?.status ?? 'network_error',
        outcome: 'payment_unknown',
      });
      return {
        status: 'payment_unknown',
        transactionId,
        message:
          'The billing service could not be reached to confirm the payment. Do NOT report success; tell the user to check their bill later.',
      };
    }
    const delayMs = 500 * 2 ** attempt;
    emit({ event: 'retry_wait', attempt: attempt + 1, delayMs, reason: result });
    await wait(delayMs);
  }
}
