/** Domain records (cents, Date) → API JSON (dollars as numbers, ISO dates). */
import { remainingBalanceCents } from '../domain/billing';
import { centsToDollars } from '../domain/money';
import type { BillRecord } from '../repositories/types';

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export function billSummary(bill: BillRecord) {
  return {
    subscriberNo: bill.subscriberNo,
    month: bill.month,
    year: bill.year,
    total: centsToDollars(bill.totalCents),
    paidAmount: centsToDollars(bill.paidCents),
    remainingBalance: centsToDollars(remainingBalanceCents(bill.totalCents, bill.paidCents)),
    status: bill.status,
    dueDate: isoDate(bill.dueDate),
  };
}
