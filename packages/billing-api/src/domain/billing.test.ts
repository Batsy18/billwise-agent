import {
  billStatus,
  calculateBill,
  dueDate,
  internetCharge,
  phoneCharge,
  remainingBalanceCents,
} from './billing';

// All money is in integer cents: $10 = 1000.

describe('phoneCharge — $10 × ceil(max(0, minutes − 1000) / 1000)  (guide 2.1, 2.2)', () => {
  it.each([
    // [minutes, extraBlocks, amountCents]
    [0, 0, 0], //       nothing used
    [1000, 0, 0], //    exactly the free allowance → still free
    [1001, 1, 1000], // 1 minute over → a full extra block (guide 2.2 example)
    [1350, 1, 1000], // worked example (guide 4.3)
    [2000, 1, 1000], // exactly one full extra block
    [2001, 2, 2000], // 1 minute into the second block (guide 2.2 example)
  ])('%i min → %i extra block(s), %i cents', (minutes, extraBlocks, amountCents) => {
    expect(phoneCharge(minutes)).toEqual({ includedMinutes: 1000, extraBlocks, amountCents });
  });
});

describe('internetCharge — $50 + $10 × ceil(max(0, GB − 20) / 10), 1 GB = 1000 MB  (guide 3)', () => {
  it.each([
    // [mb, extraBlocks, amountCents]
    [0, 0, 5000], //      zero-usage month still pays the $50 base (guide 3.1)
    [20_000, 0, 5000], // 20 GB exactly → base only (guide 3.2 example)
    [20_001, 1, 6000], // 20.001 GB → 1 MB over starts a new block
    [21_000, 1, 6000], // 21 GB (guide 3.2 example)
    [30_000, 1, 6000], // 30 GB → exactly one full extra block (guide 3.2 example)
    [30_001, 2, 7000], // 1 MB into the second block
    [35_000, 2, 7000], // 35 GB (guide 3.2 + 4.3 example)
  ])('%i MB → %i extra block(s), %i cents', (mb, extraBlocks, amountCents) => {
    expect(internetCharge(mb)).toEqual({ baseCents: 5000, extraBlocks, amountCents });
  });
});

describe('calculateBill', () => {
  it('reproduces the guide worked example: 1,350 min + 35 GB = $80 (guide 4.3)', () => {
    const bill = calculateBill({ year: 2026, month: 10, phoneMinutes: 1350, internetMb: 35_000 });
    expect(bill.phone.amountCents).toBe(1000);
    expect(bill.internet.amountCents).toBe(7000);
    expect(bill.totalCents).toBe(8000);
    expect(bill.dueDate.toISOString()).toBe('2026-11-15T00:00:00.000Z');
  });

  it('a month without any usage costs exactly the $50 internet base', () => {
    const bill = calculateBill({ year: 2026, month: 10, phoneMinutes: 0, internetMb: 0 });
    expect(bill.totalCents).toBe(5000);
  });
});

describe('dueDate — 15 calendar days after the end of the billing month (guide 6.1)', () => {
  it.each([
    [2026, 10, '2026-11-15'], // guide example: October 2026 → November 15, 2026
    [2026, 12, '2027-01-15'], // December rolls over into the next year
    [2027, 2, '2027-03-15'], //  28-day February
    [2028, 2, '2028-03-15'], //  leap-year February (29 days)
    [2026, 1, '2026-02-15'], //  31-day month
  ])('%i-%i → %s', (year, month, expected) => {
    const d = dueDate(year, month);
    expect(d.toISOString()).toBe(`${expected}T00:00:00.000Z`); // UTC midnight → DATE column
  });
});

describe('billStatus / remainingBalanceCents (guide 5.1)', () => {
  it.each([
    // [totalCents, paidCents, status, remaining]
    [8000, 0, 'UNPAID', 8000],
    [8000, 3000, 'PARTIALLY_PAID', 5000], // partial payment does not mark the bill paid
    [8000, 7999, 'PARTIALLY_PAID', 1], //   one cent short is still not paid
    [8000, 8000, 'PAID', 0],
    // Recalculation lowered the total below what was already paid (Varsayımlar):
    // bill counts as PAID, remaining shown as 0, overpayment is not tracked.
    [5000, 8000, 'PAID', 0],
  ] as const)('total %i, paid %i → %s, remaining %i', (total, paid, status, remaining) => {
    expect(billStatus(total, paid)).toBe(status);
    expect(remainingBalanceCents(total, paid)).toBe(remaining);
  });
});

describe('invalid input is a programming error (RangeError)', () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('phoneCharge(%p) throws', (v) => {
    expect(() => phoneCharge(v)).toThrow(RangeError);
  });

  it.each([-1, 0.5, Number.NaN])('internetCharge(%p) throws', (v) => {
    expect(() => internetCharge(v)).toThrow(RangeError);
  });

  it.each([0, 13, 1.5])('dueDate with month %p throws', (month) => {
    expect(() => dueDate(2026, month)).toThrow(RangeError);
  });

  it('billStatus with negative or fractional cents throws', () => {
    expect(() => billStatus(-1, 0)).toThrow(RangeError);
    expect(() => billStatus(100, 0.5)).toThrow(RangeError);
  });
});
