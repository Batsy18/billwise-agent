import { DEMO_QUESTIONS, isLocalUrl, parseArgs } from './demo';

describe('demo options', () => {
  it('scenarios a–h in the documented order', () => {
    expect(DEMO_QUESTIONS.map((q) => q.id).join('')).toBe('abcdefgh');
    expect(DEMO_QUESTIONS.find((q) => q.id === 'd')?.confirm).toBe('EVET');
    expect(DEMO_QUESTIONS.filter((q) => q.confirm)).toHaveLength(1); // only d pays
  });

  it('--only a,d selects a subset; unknown letters fail', () => {
    expect(parseArgs(['--only', 'a,D'])).toEqual({ only: new Set(['a', 'd']), reseed: false });
    expect(parseArgs(['--only=e']).only).toEqual(new Set(['e']));
    expect(parseArgs([])).toEqual({ only: null, reseed: false });
    expect(() => parseArgs(['--only', 'a,z'])).toThrow(/unknown scenario/);
  });

  it('re-seed is automatic only for localhost', () => {
    expect(isLocalUrl('http://localhost:3000')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isLocalUrl('https://billwise-gw-abc.uc.gateway.dev')).toBe(false);
    expect(parseArgs(['--reseed']).reseed).toBe(true);
  });
});
