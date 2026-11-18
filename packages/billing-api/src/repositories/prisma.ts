/**
 * Prisma implementations of the repository contracts. This is the only place where Prisma
 * types and Decimal appear; everything returned is in integer cents.
 */
import { centsToDecimalString, decimalStringToCents } from '../domain/money';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
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

type Tx = Prisma.TransactionClient;
type BillRow = Awaited<ReturnType<PrismaClient['bill']['findUniqueOrThrow']>>;
type PaymentRow = Awaited<ReturnType<PrismaClient['payment']['findUniqueOrThrow']>>;

/** Decimal(10,2) → cents via its string form ("80" / "30.5"): no float arithmetic. */
const cents = (d: { toFixed(dp: number): string }): number => decimalStringToCents(d.toFixed(2));

const periodWhere = (p: Period) => ({
  subscriberNo_year_month: { subscriberNo: p.subscriberNo, year: p.year, month: p.month },
});

function toBill(row: BillRow): BillRecord {
  return {
    id: row.id,
    subscriberNo: row.subscriberNo,
    year: row.year,
    month: row.month,
    phoneMinutes: row.phoneMinutes,
    internetMb: row.internetMb,
    phoneChargeCents: cents(row.phoneCharge),
    internetChargeCents: cents(row.internetCharge),
    totalCents: cents(row.total),
    paidCents: cents(row.paidAmount),
    status: row.status,
    dueDate: row.dueDate,
    calculatedAt: row.calculatedAt,
  };
}

function toPayment(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    billId: row.billId,
    transactionId: row.transactionId,
    amountCents: cents(row.amount),
    createdAt: row.createdAt,
  };
}

/** Row lock on the period's bill (if it exists) until the transaction ends. */
async function lockBill(tx: Tx, p: Period): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "bill" WHERE "subscriber_no" = ${p.subscriberNo} AND "year" = ${p.year} AND "month" = ${p.month} FOR UPDATE`;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

export class PrismaSubscriberRepository implements SubscriberRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByNo(subscriberNo: string): Promise<SubscriberRecord | null> {
    return this.prisma.subscriber.findUnique({ where: { subscriberNo } });
  }
}

export class PrismaUsageRepository implements UsageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async add(period: Period, usageType: UsageType, amount: number): Promise<UsageEventRecord> {
    const row = await this.prisma.usageEvent.create({ data: { ...period, usageType, amount } });
    return { id: row.id, usageType: row.usageType, amount: row.amount, createdAt: row.createdAt };
  }

  async totals(period: Period): Promise<UsageTotals> {
    const groups = await this.prisma.usageEvent.groupBy({
      by: ['usageType'],
      where: period,
      _sum: { amount: true },
    });
    const sum = (t: UsageType) => groups.find((g) => g.usageType === t)?._sum.amount ?? 0;
    return { phoneMinutes: sum('PHONE'), internetMb: sum('INTERNET') };
  }

  async list(period: Period, page: number, pageSize: number): Promise<Page<UsageEventRecord>> {
    // Served by the (subscriber_no, year, month, created_at, id) index: no sort of 35k rows.
    const [rows, totalItems] = await this.prisma.$transaction([
      this.prisma.usageEvent.findMany({
        where: period,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, usageType: true, amount: true, createdAt: true },
      }),
      this.prisma.usageEvent.count({ where: period }),
    ]);
    return { items: rows, totalItems };
  }
}

export class PrismaBillRepository implements BillRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async find(period: Period): Promise<BillRecord | null> {
    const row = await this.prisma.bill.findUnique({ where: periodWhere(period) });
    return row ? toBill(row) : null;
  }

  async saveCalculated(
    period: Period,
    decide: (existing: BillRecord | null) => BillValues,
  ): Promise<BillRecord> {
    try {
      return await this.saveOnce(period, decide);
    } catch (err) {
      // Two first-time calculations raced and both tried to INSERT: the loser retries as UPDATE.
      if (isUniqueViolation(err)) return this.saveOnce(period, decide);
      throw err;
    }
  }

  private saveOnce(period: Period, decide: (existing: BillRecord | null) => BillValues) {
    return this.prisma.$transaction(async (tx) => {
      await lockBill(tx, period);
      const existing = await tx.bill.findUnique({ where: periodWhere(period) });
      const v = decide(existing ? toBill(existing) : null);
      const data = {
        phoneMinutes: v.phoneMinutes,
        internetMb: v.internetMb,
        phoneCharge: centsToDecimalString(v.phoneChargeCents),
        internetCharge: centsToDecimalString(v.internetChargeCents),
        total: centsToDecimalString(v.totalCents),
        status: v.status,
        dueDate: v.dueDate,
        calculatedAt: new Date(),
      }; // paidAmount is deliberately absent: only payments change it
      const row = existing
        ? await tx.bill.update({ where: { id: existing.id }, data })
        : await tx.bill.create({ data: { ...period, ...data } });
      return toBill(row);
    });
  }
}

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByTransactionId(
    transactionId: string,
  ): Promise<{ payment: PaymentRecord; bill: BillRecord } | null> {
    const row = await this.prisma.payment.findUnique({
      where: { transactionId },
      include: { bill: true },
    });
    return row ? { payment: toPayment(row), bill: toBill(row.bill) } : null;
  }

  async pay(
    period: Period,
    transactionId: string,
    amountCents: number,
    decide: (bill: BillRecord | null) => PaymentDecision,
  ): Promise<{ payment: PaymentRecord; bill: BillRecord }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockBill(tx, period); // concurrent payments on this bill wait here
        const billRow = await tx.bill.findUnique({ where: periodWhere(period) });
        if (!billRow) {
          decide(null); // throws BILL_NOT_FOUND → rollback
          throw new Error('decide must reject a missing bill');
        }
        if (await tx.payment.findUnique({ where: { transactionId }, select: { id: true } })) {
          throw new DuplicateTransactionError(transactionId);
        }
        const decision = decide(toBill(billRow)); // may throw 422 → rollback
        const payment = await tx.payment.create({
          data: { billId: billRow.id, transactionId, amount: centsToDecimalString(amountCents) },
        });
        const bill = await tx.bill.update({
          where: { id: billRow.id },
          data: { paidAmount: centsToDecimalString(decision.paidCents), status: decision.status },
        });
        return { payment: toPayment(payment), bill: toBill(bill) };
      });
    } catch (err) {
      // Same transactionId committed by a concurrent request after our check: UNIQUE caught it.
      if (isUniqueViolation(err)) throw new DuplicateTransactionError(transactionId);
      throw err;
    }
  }
}

export function createPrismaRepositories(prisma: PrismaClient): Repositories {
  return {
    subscribers: new PrismaSubscriberRepository(prisma),
    usage: new PrismaUsageRepository(prisma),
    bills: new PrismaBillRepository(prisma),
    payments: new PrismaPaymentRepository(prisma),
  };
}
