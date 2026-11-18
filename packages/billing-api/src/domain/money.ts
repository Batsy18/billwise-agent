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
