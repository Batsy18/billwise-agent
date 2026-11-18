/**
 * Pure billing rules from the Mobile Provider Billing Guide (sections 2–6).
 * No I/O, no Prisma, no floats for money: every amount is an integer number of cents.
 */

// --- Pricing constants (guide 2.1, 2.2, 3.1, 3.2, 3.3) ---
export const PHONE_INCLUDED_MINUTES = 1000;
export const PHONE_BLOCK_MINUTES = 1000;
export const PHONE_BLOCK_PRICE_CENTS = 1000; // $10

export const MB_PER_GB = 1000; // guide 3.3: 1 GB = 1,000 MB in this system
export const INTERNET_BASE_PRICE_CENTS = 5000; // $50, charged even with zero usage
export const INTERNET_INCLUDED_MB = 20 * MB_PER_GB; // 20 GB
export const INTERNET_BLOCK_MB = 10 * MB_PER_GB; // 10 GB
export const INTERNET_BLOCK_PRICE_CENTS = 1000; // $10

export const DUE_DAYS_AFTER_PERIOD_END = 15; // guide 6.1

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type BillStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

export interface PhoneCharge {
  includedMinutes: number;
  extraBlocks: number;
  amountCents: number;
}

export interface InternetCharge {
  baseCents: number;
  extraBlocks: number;
  amountCents: number;
}

export interface BillInput {
  year: number;
  month: number;
  phoneMinutes: number;
  internetMb: number;
}

export interface CalculatedBill {
  phone: PhoneCharge;
  internet: InternetCharge;
  totalCents: number;
  dueDate: Date;
}

/** Number of started blocks above an allowance: ceil(max(0, used − included) / blockSize). */
function extraBlocks(used: number, included: number, blockSize: number): number {
  const over = Math.max(0, used - included);
  return Math.ceil(over / blockSize);
}

/** Phone charge = $10 × ceil(max(0, minutes − 1000) / 1000)  (guide 4.2). */
export function phoneCharge(minutes: number): PhoneCharge {
  assertNonNegativeInt('minutes', minutes);
  const blocks = extraBlocks(minutes, PHONE_INCLUDED_MINUTES, PHONE_BLOCK_MINUTES);
  return {
    includedMinutes: PHONE_INCLUDED_MINUTES,
    extraBlocks: blocks,
    amountCents: blocks * PHONE_BLOCK_PRICE_CENTS,
  };
}

/**
 * Internet charge = $50 + $10 × ceil(max(0, GB − 20) / 10)  (guide 4.2).
 * Computed in whole MB (20 GB = 20,000 MB, 10 GB = 10,000 MB). This is the same formula
 * because 1 GB = 1,000 MB, but it never builds a fractional GB value, so values such as
 * 20,001 MB cannot be mis-rounded by floating point.
 */
export function internetCharge(mb: number): InternetCharge {
  assertNonNegativeInt('mb', mb);
  const blocks = extraBlocks(mb, INTERNET_INCLUDED_MB, INTERNET_BLOCK_MB);
  return {
    baseCents: INTERNET_BASE_PRICE_CENTS,
    extraBlocks: blocks,
    amountCents: INTERNET_BASE_PRICE_CENTS + blocks * INTERNET_BLOCK_PRICE_CENTS,
  };
}

/**
 * Due date = last day of the billing month + 15 days (guide 6.1), at UTC midnight so it maps
 * cleanly onto a DATE column. This always lands on the 15th of the following month.
 */
export function dueDate(year: number, month: number): Date {
  assertYear(year);
  assertMonth(month);
  // Date.UTC months are 0-based, so (month, day 0) is the last day of the 1-based `month`.
  const periodEnd = Date.UTC(year, month, 0);
  return new Date(periodEnd + DUE_DAYS_AFTER_PERIOD_END * MS_PER_DAY);
}

/** Total = phone + internet; no taxes, fees or discounts (guide 4.2). */
export function calculateBill(input: BillInput): CalculatedBill {
  const phone = phoneCharge(input.phoneMinutes);
  const internet = internetCharge(input.internetMb);
  return {
    phone,
    internet,
    totalCents: phone.amountCents + internet.amountCents,
    dueDate: dueDate(input.year, input.month),
  };
}

/**
 * PAID once payments cover the total (also when a recalculated total fell below what was
 * already paid), PARTIALLY_PAID after any payment, otherwise UNPAID (guide 5.1).
 */
export function billStatus(totalCents: number, paidCents: number): BillStatus {
  assertNonNegativeInt('totalCents', totalCents);
  assertNonNegativeInt('paidCents', paidCents);
  if (paidCents >= totalCents) return 'PAID';
  if (paidCents > 0) return 'PARTIALLY_PAID';
  return 'UNPAID';
}

/** Outstanding amount, never negative (overpayment is not tracked). */
export function remainingBalanceCents(totalCents: number, paidCents: number): number {
  assertNonNegativeInt('totalCents', totalCents);
  assertNonNegativeInt('paidCents', paidCents);
  return Math.max(0, totalCents - paidCents);
}

// --- Guards: callers (zod at the API edge, the seed) must never pass these values. ---
function assertNonNegativeInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

function assertMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`month must be an integer 1–12, got ${month}`);
  }
}

function assertYear(year: number): void {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw new RangeError(`year must be an integer 1970–9999, got ${year}`);
  }
}
