/**
 * Pure description of the demo/grading seed (vault note "API ve Veri Modeli" → Seed verisi).
 * Bill amounts are never hard-coded: they are computed with the same domain functions the API
 * uses, so the seed cannot drift from the billing rules.
 */
import { billStatus, calculateBill, type BillStatus, type CalculatedBill } from '../domain/billing';

export const PHONE_EVENT_MINUTES = 10; // guide 2.3
export const INTERNET_EVENT_MB = 1; // guide 3.3

export type SeedRole = 'ADMIN' | 'SUBSCRIBER';

export interface SeedSubscriber {
  subscriberNo: string;
  fullName: string;
  role: SeedRole;
}

export interface SeedPayment {
  transactionId: string;
  amountCents: number;
}

export interface SeedPeriod {
  subscriberNo: string;
  year: number;
  month: number;
  phoneMinutes: number;
  internetMb: number;
  /** false → usage exists but Calculate Bill has not been run yet (demo of 404 + calculate). */
  calculated: boolean;
  payments: SeedPayment[];
}

export interface SeedBill {
  subscriberNo: string;
  year: number;
  month: number;
  phoneMinutes: number;
  internetMb: number;
  calc: CalculatedBill;
  paidCents: number;
  status: BillStatus;
  payments: SeedPayment[];
}

export interface SeedUsageBatch {
  subscriberNo: string;
  year: number;
  month: number;
  usageType: 'PHONE' | 'INTERNET';
  amount: number;
  count: number;
}

export interface SeedPlan {
  subscribers: SeedSubscriber[];
  usage: SeedUsageBatch[];
  bills: SeedBill[];
}

export const SEED_SUBSCRIBERS: readonly SeedSubscriber[] = [
  { subscriberNo: 'admin', fullName: 'Billing Admin', role: 'ADMIN' },
  { subscriberNo: '5551000001', fullName: 'Ayse Normal', role: 'SUBSCRIBER' },
  { subscriberNo: '5551000002', fullName: 'Mehmet Overage', role: 'SUBSCRIBER' },
  { subscriberNo: '5551000003', fullName: 'Zeynep Partial', role: 'SUBSCRIBER' },
];

export const SEED_PERIODS: readonly SeedPeriod[] = [
  // 5551000001 — normal usage: a fully paid September and an unpaid October, both at the $50 base.
  {
    subscriberNo: '5551000001',
    year: 2026,
    month: 9,
    phoneMinutes: 300,
    internetMb: 5_000,
    calculated: true,
    payments: [{ transactionId: 'seed-5551000001-2026-09-1', amountCents: 5000 }],
  },
  {
    subscriberNo: '5551000001',
    year: 2026,
    month: 10,
    phoneMinutes: 450,
    internetMb: 8_000,
    calculated: true,
    payments: [],
  },
  // 5551000002 — the guide's worked example (1,350 min + 35 GB = $80), unpaid; plus an
  // uncalculated November for the Calculate Bill / BILL_NOT_FOUND demos.
  {
    subscriberNo: '5551000002',
    year: 2026,
    month: 10,
    phoneMinutes: 1_350,
    internetMb: 35_000,
    calculated: true,
    payments: [],
  },
  {
    subscriberNo: '5551000002',
    year: 2026,
    month: 11,
    phoneMinutes: 200,
    internetMb: 3_000,
    calculated: false,
    payments: [],
  },
  // 5551000003 — $10 phone + $60 internet = $70 with a $30 partial payment → $40 remaining.
  {
    subscriberNo: '5551000003',
    year: 2026,
    month: 10,
    phoneMinutes: 1_800,
    internetMb: 22_500,
    calculated: true,
    payments: [{ transactionId: 'seed-5551000003-2026-10-1', amountCents: 3000 }],
  },
];

export function buildSeedPlan(periods: readonly SeedPeriod[] = SEED_PERIODS): SeedPlan {
  const usage: SeedUsageBatch[] = [];
  const bills: SeedBill[] = [];

  for (const p of periods) {
    if (p.phoneMinutes % PHONE_EVENT_MINUTES !== 0) {
      // Add Usage can only record whole 10-minute events, so other totals are unreachable.
      throw new RangeError(
        `${p.subscriberNo} ${p.year}-${p.month}: minutes must be a multiple of 10`,
      );
    }
    const key = { subscriberNo: p.subscriberNo, year: p.year, month: p.month };
    usage.push({
      ...key,
      usageType: 'PHONE',
      amount: PHONE_EVENT_MINUTES,
      count: p.phoneMinutes / PHONE_EVENT_MINUTES,
    });
    usage.push({
      ...key,
      usageType: 'INTERNET',
      amount: INTERNET_EVENT_MB,
      count: p.internetMb / INTERNET_EVENT_MB,
    });

    if (!p.calculated) {
      if (p.payments.length > 0) throw new Error('payments require a calculated bill');
      continue;
    }
    const calc = calculateBill(p);
    // paid_amount is always derived from the payment rows, never set independently.
    const paidCents = p.payments.reduce((sum, pay) => sum + pay.amountCents, 0);
    if (paidCents > calc.totalCents) throw new Error('seed payments exceed the bill total');
    bills.push({
      ...key,
      phoneMinutes: p.phoneMinutes,
      internetMb: p.internetMb,
      calc,
      paidCents,
      status: billStatus(calc.totalCents, paidCents),
      payments: p.payments,
    });
  }

  return { subscribers: [...SEED_SUBSCRIBERS], usage, bills };
}
