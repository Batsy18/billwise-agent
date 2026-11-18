import {
  centsToDecimalString,
  centsToDollars,
  decimalStringToCents,
  dollarsToCents,
  hasAtMostTwoDecimals,
} from './money';

describe('dollarsToCents — API input (JSON number in dollars) → integer cents', () => {
  it.each([
    [80, 8000],
    [30.5, 3050],
    [0.1, 10], //   0.1 * 100 = 10.000000000000002 in floating point → rounds to 10
    [0.07, 7], //   0.07 * 100 = 7.000000000000001
    [19.99, 1999],
    [1_000_000, 100_000_000],
  ])('%p → %i', (dollars, cents) => {
    expect(dollarsToCents(dollars)).toBe(cents);
  });

  it.each([30.555, 1.005, 0.001, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects %p (more than 2 decimals, not finite or negative)',
    (v) => {
      expect(hasAtMostTwoDecimals(v)).toBe(false);
      expect(() => dollarsToCents(v)).toThrow(RangeError);
    },
  );
});

describe('centsToDollars — integer cents → JSON number in dollars', () => {
  it.each([
    [8000, 80],
    [3050, 30.5],
    [7, 0.07],
    [0, 0],
  ])('%i → %p', (cents, dollars) => {
    expect(centsToDollars(cents)).toBe(dollars);
  });

  it('round-trips every cent value without drift', () => {
    for (let c = 0; c <= 100_000; c += 1) expect(dollarsToCents(centsToDollars(c))).toBe(c);
  });
});

describe('centsToDecimalString — integer cents → decimal(10,2) string, no floats', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [50, '0.50'],
    [8000, '80.00'],
    [3050, '30.50'],
    [99_999_999, '999999.99'], // decimal(10,2) max fits
  ])('%i → %s', (cents, expected) => {
    expect(centsToDecimalString(cents)).toBe(expected);
  });

  it.each([-1, 0.5, Number.NaN])('rejects %p', (v) => {
    expect(() => centsToDecimalString(v)).toThrow(RangeError);
  });
});

describe('decimalStringToCents — what Prisma Decimal.toString() returns → cents', () => {
  it.each([
    ['0', 0],
    ['80', 8000],
    ['80.00', 8000],
    ['30.5', 3050],
    ['0.05', 5],
  ])('%s → %i', (s, expected) => {
    expect(decimalStringToCents(s)).toBe(expected);
  });

  it.each(['', '-1.00', '1.234', 'abc', '1e3'])('rejects %p', (s) => {
    expect(() => decimalStringToCents(s)).toThrow(RangeError);
  });
});
