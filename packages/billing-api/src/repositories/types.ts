/**
 * Repository contracts. Everything above this layer works in integer cents and plain types;
 * Prisma (and Decimal) never leaks past the Prisma implementations.
 *
 * Transactions and row locks are the repositories' job; business rules are the services'.
 * Where both meet (calculate, pay) the service passes a pure `decide` callback that the
 * repository runs inside its transaction, after locking the bill row.
 */
import type { BillStatus } from '../domain/billing';

export type Role = 'SUBSCRIBER' | 'ADMIN';
export type UsageType = 'PHONE' | 'INTERNET';

export interface Period {
  subscriberNo: string;
  year: number;
  month: number;
}

export interface SubscriberRecord {
  subscriberNo: string;
  fullName: string;
  passwordHash: string;
  role: Role;
}

export interface UsageEventRecord {
  id: string;
  usageType: UsageType;
  amount: number;
  createdAt: Date;
}

export interface UsageTotals {
  phoneMinutes: number;
  internetMb: number;
}

export interface Page<T> {
  items: T[];
  totalItems: number;
}

export interface BillValues {
  phoneMinutes: number;
  internetMb: number;
  phoneChargeCents: number;
  internetChargeCents: number;
  totalCents: number;
  status: BillStatus;
  dueDate: Date;
}

export interface BillRecord extends Period, BillValues {
  id: string;
  paidCents: number;
  calculatedAt: Date;
}

export interface PaymentRecord {
  id: string;
  billId: string;
  transactionId: string;
  amountCents: number;
  createdAt: Date;
}

export interface SubscriberRepository {
  findByNo(subscriberNo: string): Promise<SubscriberRecord | null>;
}

export interface UsageRepository {
  add(period: Period, usageType: UsageType, amount: number): Promise<UsageEventRecord>;
  totals(period: Period): Promise<UsageTotals>;
  /** Ordered by (createdAt, id) so pages are stable. `page` is 1-based. */
  list(period: Period, page: number, pageSize: number): Promise<Page<UsageEventRecord>>;
}

export interface BillRepository {
  find(period: Period): Promise<BillRecord | null>;
  /**
   * Insert or update the bill for `period` in one transaction. The existing row (if any) is
   * locked first; `decide` receives it and returns the values to store. paid_amount is never
   * written here — it only changes through payments.
   */
  saveCalculated(
    period: Period,
    decide: (existing: BillRecord | null) => BillValues,
  ): Promise<BillRecord>;
}

export interface PaymentDecision {
  paidCents: number;
  status: BillStatus;
}

/** Thrown by PaymentRepository.pay when the transactionId already exists. */
export class DuplicateTransactionError extends Error {
  constructor(readonly transactionId: string) {
    super(`transactionId ${transactionId} already exists`);
    this.name = 'DuplicateTransactionError';
  }
}

export interface PaymentRepository {
  findByTransactionId(
    transactionId: string,
  ): Promise<{ payment: PaymentRecord; bill: BillRecord } | null>;
  /**
   * In ONE transaction, in this order:
   *   1. lock the bill row; if there is none call `decide(null)` (throws BILL_NOT_FOUND)
   *   2. transactionId already used → DuplicateTransactionError (also enforced by UNIQUE)
   *   3. `decide(bill)` → may throw 422, else the new paid amount + status
   *   4. insert the payment and update the bill
   * Duplicate comes before the 422 rules so that retrying a payment that already settled the
   * bill reports "duplicate" (with the earlier result), not BILL_ALREADY_PAID.
   */
  pay(
    period: Period,
    transactionId: string,
    amountCents: number,
    decide: (bill: BillRecord | null) => PaymentDecision,
  ): Promise<{ payment: PaymentRecord; bill: BillRecord }>;
}

export interface Repositories {
  subscribers: SubscriberRepository;
  usage: UsageRepository;
  bills: BillRepository;
  payments: PaymentRepository;
}
