import { centsToDecimalString, decimalStringToCents } from './money';

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
