import {
  billStatus,
  calculateBill,
  internetCharge,
  MB_PER_GB,
  phoneCharge,
} from '../domain/billing';
import { centsToDollars } from '../domain/money';
import { AppError } from '../http/errors';
import type {
  BillRecord,
  BillRepository,
  Period,
  SubscriberRepository,
  UsageRepository,
} from '../repositories/types';
import { billSummary, isoDate } from './presenters';
import { assertBillableSubscriber, USAGE_UNITS } from './usage.service';

export class BillService {
  constructor(
    private readonly subscribers: SubscriberRepository,
    private readonly usage: UsageRepository,
    private readonly bills: BillRepository,
  ) {}

  /**
   * Calculate Bill: total the period's usage, price it with the pure domain function and store
   * it. Recalculation keeps paid_amount and re-derives the status from it (Varsayımlar).
   */
  async calculate(period: Period) {
    await assertBillableSubscriber(this.subscribers, period.subscriberNo);
    const totals = await this.usage.totals(period);
    const bill = await this.bills.saveCalculated(period, (existing) => {
      const calc = calculateBill({ ...period, ...totals });
      return {
        ...totals,
        phoneChargeCents: calc.phone.amountCents,
        internetChargeCents: calc.internet.amountCents,
        totalCents: calc.totalCents,
        status: billStatus(calc.totalCents, existing?.paidCents ?? 0),
        dueDate: calc.dueDate,
      };
    });
    const summary = billSummary(bill);
    return {
      status: 'SUCCESS' as const,
      bill: {
        total: summary.total,
        phoneCharge: centsToDollars(bill.phoneChargeCents),
        internetCharge: centsToDollars(bill.internetChargeCents),
        dueDate: summary.dueDate,
        paidAmount: summary.paidAmount,
        remainingBalance: summary.remainingBalance,
        billStatus: summary.status,
      },
    };
  }

  async query(period: Period) {
    return billSummary(await this.requireBill(period));
  }

  async detailed(period: Period, page: number, pageSize: number) {
    const bill = await this.requireBill(period);
    const events = await this.usage.list(period, page, pageSize);
    // Blocks are recomputed from the usage stored ON THE BILL, so the breakdown always
    // explains the stored amounts even if usage was added after the last calculation.
    const phone = phoneCharge(bill.phoneMinutes);
    const internet = internetCharge(bill.internetMb);
    return {
      ...billSummary(bill),
      usage: {
        phoneMinutes: bill.phoneMinutes,
        internetMB: bill.internetMb,
        internetGB: bill.internetMb / MB_PER_GB,
      },
      charges: {
        phone: {
          includedMinutes: phone.includedMinutes,
          extraBlocks: phone.extraBlocks,
          amount: centsToDollars(bill.phoneChargeCents),
        },
        internet: {
          base: centsToDollars(internet.baseCents),
          extraBlocks: internet.extraBlocks,
          amount: centsToDollars(bill.internetChargeCents),
        },
      },
      usageEvents: {
        items: events.items.map((e) => ({
          id: e.id,
          usageType: e.usageType,
          amount: e.amount,
          unit: USAGE_UNITS[e.usageType].unit,
          createdAt: e.createdAt.toISOString(),
        })),
        page,
        pageSize,
        totalItems: events.totalItems,
        totalPages: Math.ceil(events.totalItems / pageSize),
      },
      calculatedAt: bill.calculatedAt.toISOString(),
      dueDate: isoDate(bill.dueDate),
    };
  }

  private async requireBill(period: Period): Promise<BillRecord> {
    const bill = await this.bills.find(period);
    if (!bill) {
      throw new AppError(
        'BILL_NOT_FOUND',
        `No bill for ${period.subscriberNo} ${period.year}-${String(period.month).padStart(2, '0')}; it has not been calculated yet`,
      );
    }
    return bill;
  }
}
