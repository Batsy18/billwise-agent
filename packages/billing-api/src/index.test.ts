import { hello } from './index';

describe('billing-api skeleton', () => {
  it('returns a greeting', () => {
    expect(hello()).toBe('hello from billing-api');
  });
});
