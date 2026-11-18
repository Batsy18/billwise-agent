import { billStatus, remainingBalanceCents } from '../domain/billing';
import { centsToDollars } from '../domain/money';
import { AppError } from '../http/errors';
import {
  DuplicateTransactionError,
  type BillRecord,
  type PaymentDecision,
  type PaymentRepository,
  type Period,
} from '../repositories/types';

/** Pure payment rules, run by the repository inside its transaction after locking the bill. */
export function decidePayment(bill: BillRecord | null, amountCents: number): PaymentDecision {
  if (!bill) throw new AppError('BILL_NOT_FOUND', 'No calculated bill for this period');
  const remaining = remainingBalanceCents(bill.totalCents, bill.paidCents);
  // Checked before the balance rule: on a paid bill every amount would "exceed" $0.
  if (remaining === 0) throw new AppError('BILL_ALREADY_PAID', 'This bill is already fully paid');
  if (amountCents > remaining) {
    throw new AppError(
      'AMOUNT_EXCEEDS_BALANCE',
      `Amount exceeds the remaining balance of ${centsToDollars(remaining)}`,
    );
  }
  const paidCents = bill.paidCents + amountCents;
  return { paidCents, status: billStatus(bill.totalCents, paidCents) };
}

export class PaymentService {
  constructor(private readonly payments: PaymentRepository) {}

  async pay(period: Period, transactionId: string, amountCents: number) {
    try {
      const { bill } = await this.payments.pay(period, transactionId, amountCents, (b) =>
        decidePayment(b, amountCents),
      );
      return {
        paymentStatus: 'SUCCESS' as const,
        transactionId,
        amount: centsToDollars(amountCents),
        paidAmount: centsToDollars(bill.paidCents),
        remainingBalance: centsToDollars(remainingBalanceCents(bill.totalCents, bill.paidCents)),
        billStatus: bill.status,
      };
    } catch (err) {
      if (err instanceof DuplicateTransactionError)
        throw await this.duplicate(period, transactionId);
      throw err;
    }
  }

  /**
   * Idempotent retries (guide 5.3): if the earlier payment with this transactionId belongs to
   * the same subscriber, tell the caller what it achieved so a retry can be reported as the
   * success it already was. Someone else's transactionId → plain 409, no details leak.
   */
  private async duplicate(period: Period, transactionId: string): Promise<AppError> {
    const message = `transactionId ${transactionId} has already been used`;
    const existing = await this.payments.findByTransactionId(transactionId);
    if (!existing || existing.bill.subscriberNo !== period.subscriberNo) {
      return new AppError('DUPLICATE_TRANSACTION', message);
    }
    const { payment, bill } = existing;
    return new AppError('DUPLICATE_TRANSACTION', message, {
      existingPayment: {
        amount: centsToDollars(payment.amountCents),
        paidAmount: centsToDollars(bill.paidCents),
        remainingBalance: centsToDollars(remainingBalanceCents(bill.totalCents, bill.paidCents)),
        billStatus: bill.status,
      },
    });
  }
}
