import { hello } from './index';

describe('agent skeleton', () => {
  it('returns a greeting', () => {
    expect(hello()).toBe('hello from agent');
  });
});
