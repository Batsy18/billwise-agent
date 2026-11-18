import { stem } from './stem';

describe('stem — word forms meet in the index', () => {
  it.each([
    [['calculate', 'calculated', 'calculates', 'calculation', 'calculating'], 'calculat'],
    [['tax', 'taxes'], 'tax'],
    [['charge', 'charged', 'charges'], 'charg'],
    [['include', 'included', 'includes', 'including'], 'includ'],
    [['minute', 'minutes'], 'minut'],
    [['fee', 'fees'], 'fee'],
    [['restricted', 'restriction'], 'restrict'],
    [['penalty', 'penalties'], 'penalty'],
    [['dispute', 'disputes', 'disputed'], 'disput'],
  ])('%j → %s', (forms, expected) => {
    for (const f of forms) expect(stem(f)).toBe(expected);
  });

  it.each(['due', 'bill', 'gb', 'mb', 'paid', 'use'])('keeps short or suffix-less %s', (w) => {
    expect(stem(w)).toBe(w);
  });
});
