/**
 * In-memory fakes of the repository contracts, used by the unit tests (no database).
 * They honour the same semantics as the Prisma versions: stable (createdAt, id) ordering,
 * UNIQUE transactionId, paid_amount untouched by recalculation, all-or-nothing payments.
 */
import { randomUUID } from 'node:crypto';
import {
  DuplicateTransactionError,
  type BillRecord,
  type BillRepository,
  type BillValues,
  type Page,
  type PaymentDecision,
  type PaymentRecord,
  type PaymentRepository,
  type Period,
  type Repositories,
  type SubscriberRecord,
  type SubscriberRepository,
  type UsageEventRecord,
  type UsageRepository,
  type UsageTotals,
  type UsageType,
} from './types';

const key = (p: Period): string => `${p.subscriberNo}|${p.year}|${p.month}`;

export class MemorySubscriberRepository implements SubscriberRepository {
  readonly rows = new Map<string, SubscriberRecord>();

  findByNo(subscriberNo: string): Promise<SubscriberRecord | null> {
    return Promise.resolve(this.rows.get(subscriberNo) ?? null);
  }
}

interface StoredEvent extends UsageEventRecord {
  periodKey: string;
}

export class MemoryUsageRepository implements UsageRepository {
  readonly rows: StoredEvent[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  add(period: Period, usageType: UsageType, amount: number): Promise<UsageEventRecord> {
    const row: StoredEvent = {
      id: randomUUID(),
      usageType,
      amount,
      createdAt: this.now(),
      periodKey: key(period),
    };
    this.rows.push(row);
    return Promise.resolve(strip(row));
  }

  totals(period: Period): Promise<UsageTotals> {
    const totals = { phoneMinutes: 0, internetMb: 0 };
    for (const r of this.forPeriod(period)) {
      if (r.usageType === 'PHONE') totals.phoneMinutes += r.amount;
      else totals.internetMb += r.amount;
    }
    return Promise.resolve(totals);
  }

  list(period: Period, page: number, pageSize: number): Promise<Page<UsageEventRecord>> {
    const all = this.forPeriod(period).sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const start = (page - 1) * pageSize;
    return Promise.resolve({
      items: all.slice(start, start + pageSize).map(strip),
      totalItems: all.length,
    });
  }

  private forPeriod(period: Period): StoredEvent[] {
    const k = key(period);
    return this.rows.filter((r) => r.periodKey === k);
  }
}

function strip({ id, usageType, amount, createdAt }: StoredEvent): UsageEventRecord {
  return { id, usageType, amount, createdAt };
}

export class MemoryBillRepository implements BillRepository {
  readonly rows = new Map<string, BillRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  find(period: Period): Promise<BillRecord | null> {
    const row = this.rows.get(key(period));
    return Promise.resolve(row ? { ...row } : null);
  }

  saveCalculated(
    period: Period,
    decide: (existing: BillRecord | null) => BillValues,
  ): Promise<BillRecord> {
    const existing = this.rows.get(key(period)) ?? null;
    const values = decide(existing ? { ...existing } : null);
    const row: BillRecord = {
      id: existing?.id ?? randomUUID(),
      ...period,
      ...values,
      paidCents: existing?.paidCents ?? 0,
      calculatedAt: this.now(),
    };
    this.rows.set(key(period), row);
    return Promise.resolve({ ...row });
  }

  /** Test helper: insert a bill directly. */
  insert(row: BillRecord): void {
    this.rows.set(key(row), { ...row });
  }
}

export class MemoryPaymentRepository implements PaymentRepository {
  readonly rows: PaymentRecord[] = [];

  constructor(
    private readonly bills: MemoryBillRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  findByTransactionId(
    transactionId: string,
  ): Promise<{ payment: PaymentRecord; bill: BillRecord } | null> {
    const payment = this.rows.find((p) => p.transactionId === transactionId);
    if (!payment) return Promise.resolve(null);
    const bill = [...this.bills.rows.values()].find((b) => b.id === payment.billId);
    if (!bill) throw new Error('payment without bill');
    return Promise.resolve({ payment: { ...payment }, bill: { ...bill } });
  }

  pay(
    period: Period,
    transactionId: string,
    amountCents: number,
    decide: (bill: BillRecord | null) => PaymentDecision,
  ): Promise<{ payment: PaymentRecord; bill: BillRecord }> {
    try {
      // Same order as the Prisma version: missing bill (404) → duplicate (409) → rules (422).
      const bill = this.bills.rows.get(key(period)) ?? null;
      if (!bill) {
        decide(null); // throws BILL_NOT_FOUND
        throw new Error('decide must reject a missing bill');
      }
      if (this.rows.some((p) => p.transactionId === transactionId)) {
        throw new DuplicateTransactionError(transactionId);
      }
      const decision = decide({ ...bill }); // may throw 422
      // Commit: both writes or neither (nothing above mutated state).
      const payment: PaymentRecord = {
        id: randomUUID(),
        billId: bill.id,
        transactionId,
        amountCents,
        createdAt: this.now(),
      };
      this.rows.push(payment);
      const updated = { ...bill, paidCents: decision.paidCents, status: decision.status };
      this.bills.rows.set(key(period), updated);
      return Promise.resolve({ payment: { ...payment }, bill: { ...updated } });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export interface MemoryRepositories extends Repositories {
  subscribers: MemorySubscriberRepository;
  usage: MemoryUsageRepository;
  bills: MemoryBillRepository;
  payments: MemoryPaymentRepository;
}

export function createMemoryRepositories(now?: () => Date): MemoryRepositories {
  const bills = new MemoryBillRepository(now);
  return {
    subscribers: new MemorySubscriberRepository(),
    usage: new MemoryUsageRepository(now),
    bills,
    payments: new MemoryPaymentRepository(bills, now),
  };
}
