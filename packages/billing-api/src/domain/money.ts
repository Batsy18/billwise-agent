/**
 * Conversions between integer cents (used by the domain) and the decimal(10,2) strings that
 * Prisma reads/writes for Decimal columns. String arithmetic only — no floating point.
 */

/** 8000 → "80.00", 5 → "0.05". */
export function centsToDecimalString(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`cents must be a non-negative integer, got ${cents}`);
  }
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return `${dollars}.${String(rest).padStart(2, '0')}`;
}

/**
 * True when `dollars` is a finite, non-negative number with at most 2 decimals.
 * A double that came from a 2-decimal literal (e.g. 0.1) survives the round trip through
 * cents; one with more precision (30.555, 1.005) does not.
 */
export function hasAtMostTwoDecimals(dollars: number): boolean {
  if (!Number.isFinite(dollars) || dollars < 0) return false;
  return Math.round(dollars * 100) / 100 === dollars;
}

/** API input → cents: Math.round(x * 100), rejecting more than 2 decimals (Varsayımlar). */
export function dollarsToCents(dollars: number): number {
  if (!hasAtMostTwoDecimals(dollars)) {
    throw new RangeError(
      `amount must be a non-negative number with at most 2 decimals: ${dollars}`,
    );
  }
  return Math.round(dollars * 100);
}

/**
 * Cents → API output as a JSON number (80, 30.5, 0.07). JSON cannot carry trailing zeros,
 * so 8000 cents is `80`, not `80.00`; the value is still exact to the cent (Varsayımlar).
 */
export function centsToDollars(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`cents must be a non-negative integer, got ${cents}`);
  }
  return cents / 100;
}

const DECIMAL_RE = /^(\d+)(?:\.(\d{1,2}))?$/;

/** "80" / "80.00" / "30.5" → cents. Accepts what Prisma's Decimal#toString() produces. */
export function decimalStringToCents(value: string): number {
  const match = DECIMAL_RE.exec(value);
  if (!match) {
    throw new RangeError(`not a non-negative amount with at most 2 decimals: "${value}"`);
  }
  const dollars = Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return dollars * 100 + Number(fraction);
}
