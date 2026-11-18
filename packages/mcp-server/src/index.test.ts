import { hello } from './index';

describe('mcp-server skeleton', () => {
  it('returns a greeting', () => {
    expect(hello()).toBe('hello from mcp-server');
  });
});
