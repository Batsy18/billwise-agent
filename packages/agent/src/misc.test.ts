import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeJwtPayload, BillingClient, LoginError } from './clients/billing';
import { docsClientFrom, type McpClientLike } from './clients/docs';
import { loadAgentConfig } from './config';
import { callTools, say } from './llm/mock';
import { dateContext } from './prompt';
import { DOCS_TOOL_DECLARATION, FakeBillingApi, harness, match, FakeDocs, ME } from './test/fakes';
import { Trace } from './trace';

describe('MCP tool discovery', () => {
  const listed = {
    name: 'search_billing_documentation',
    description: DOCS_TOOL_DECLARATION.description,
    inputSchema: DOCS_TOOL_DECLARATION.parameters,
  };
  const fake = (structured: unknown, isError = false): McpClientLike & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return {
      calls,
      listTools: () => Promise.resolve({ tools: [{ name: 'other', inputSchema: {} }, listed] }),
      callTool: (r) => {
        calls.push(r);
        return Promise.resolve(
          isError
            ? { isError: true, content: [{ type: 'text', text: 'limit must be <= 5' }] }
            : {
                structuredContent: structured,
                content: [{ type: 'text', text: JSON.stringify(structured) }],
              },
        );
      },
      close: () => Promise.resolve(),
    };
  };

  it('passes the listed tool through unchanged (name, description incl. topics, JSON Schema)', async () => {
    const docs = await docsClientFrom(fake({}), 'http');
    expect(docs.tool).toEqual({
      name: listed.name,
      description: listed.description,
      parameters: listed.inputSchema,
    });
  });

  it('call() returns structuredContent; tool errors become a result, not an exception', async () => {
    const out = { matches: [match('3.2')] };
    const ok = fake(out);
    await expect((await docsClientFrom(ok, 'http')).call({ query: 'x' })).resolves.toEqual(out);
    expect(ok.calls).toEqual([{ name: 'search_billing_documentation', arguments: { query: 'x' } }]);
    await expect(
      (await docsClientFrom(fake({}, true), 'http')).call({ query: 'x', limit: 9 }),
    ).resolves.toEqual({
      status: 'tool_error',
      message: 'limit must be <= 5',
    });
  });

  it('fails clearly when the server lacks the tool', async () => {
    const c = { ...fake({}), listTools: () => Promise.resolve({ tools: [] }) };
    await expect(docsClientFrom(c, 'http')).rejects.toThrow(/does not offer/);
  });
});

describe('trace', () => {
  it('writes the exchange (tools, inputs, results, durations, final answer) without secrets', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'billwise-trace-'));
    const h = harness({
      docs: new FakeDocs(() => [match('3.2')]),
      script: [
        callTools({ name: 'search_billing_documentation', args: { query: 'extra internet cost' } }),
        say('Bölüm 3.2'),
      ],
    });
    await h.agent.ask('Ek internet ne kadar?');
    const t = Object.assign(new Trace({ dir, print: () => undefined }), {});
    t.exchanges.push(...h.trace.exchanges);
    const file = t.save();
    const saved = readFileSync(file, 'utf8');
    const json = JSON.parse(saved) as {
      exchanges: { question: string; steps: { type: string }[] }[];
      usage: { requests: number };
    };
    expect(json.exchanges[0]?.question).toBe('Ek internet ne kadar?');
    expect(json.exchanges[0]?.steps.map((s) => s.type)).toEqual(['llm', 'tool', 'llm', 'final']);
    expect(json.usage.requests).toBe(2);
    expect(saved).not.toContain('jwt-of-');
    expect(h.printed.join('\n')).toContain(
      '▶ search_billing_documentation {"query":"extra internet cost"}',
    );
    expect(h.printed.join('\n')).toContain('→ sections 3.2');
  });
});

describe('billing client login', () => {
  const token = (claims: object) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

  it('keeps the token in memory and reads sub/role/exp from it', async () => {
    const api = new FakeBillingApi().on('POST', /login$/, () => ({
      status: 200,
      body: {
        accessToken: token({ sub: ME, role: 'SUBSCRIBER', exp: 1_795_000_000 }),
        tokenType: 'Bearer',
      },
    }));
    const s = await new BillingClient('http://gw.test/', api.fetch).login(ME, 'pw');
    expect(s).toMatchObject({ subscriberNo: ME, role: 'SUBSCRIBER', expired: false });
    expect(s.expiresAt.getTime()).toBe(1_795_000_000_000);
    expect(api.requests[0]?.url.href).toBe('http://gw.test/api/v1/auth/login');
  });

  it('wrong password → LoginError', async () => {
    const api = new FakeBillingApi().on('POST', /login$/, () => ({
      status: 401,
      body: { error: { code: 'UNAUTHORIZED' } },
    }));
    await expect(new BillingClient('http://gw.test', api.fetch).login(ME, 'x')).rejects.toThrow(
      LoginError,
    );
  });

  it('decodeJwtPayload rejects garbage', () => {
    expect(() => decodeJwtPayload('nope')).toThrow();
  });
});

describe('config', () => {
  it('defaults: localhost services, gemini-3.5-flash-lite, MINIMAL thinking, 4.1 s pacing', () => {
    expect(loadAgentConfig({ GEMINI_API_KEY: 'k' })).toEqual({
      BILLING_API_URL: 'http://localhost:3000',
      MCP_URL: 'http://localhost:3001/mcp',
      LLM_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'k',
      GEMINI_MODEL: 'gemini-3.5-flash-lite',
      GEMINI_THINKING_BUDGET: 'MINIMAL',
      LLM_MIN_INTERVAL_MS: 4100,
      GEMINI_TIMEOUT_MS: 20000,
    });
  });

  it('GEMINI_THINKING_BUDGET accepts a level or a token budget', () => {
    expect(
      loadAgentConfig({ GEMINI_API_KEY: 'k', GEMINI_THINKING_BUDGET: 'low' })
        .GEMINI_THINKING_BUDGET,
    ).toBe('LOW');
    expect(
      loadAgentConfig({ GEMINI_API_KEY: 'k', GEMINI_THINKING_BUDGET: '512' })
        .GEMINI_THINKING_BUDGET,
    ).toBe(512);
    expect(() => loadAgentConfig({ GEMINI_API_KEY: 'k', GEMINI_THINKING_BUDGET: 'lots' })).toThrow(
      /MINIMAL/,
    );
  });

  it('GEMINI_API_KEY is required for gemini, not for mock', () => {
    expect(() => loadAgentConfig({})).toThrow(/GEMINI_API_KEY/);
    expect(loadAgentConfig({ LLM_PROVIDER: 'mock' }).LLM_PROVIDER).toBe('mock');
  });
});

describe('dateContext', () => {
  it('January → last month is December of the previous year', () => {
    expect(dateContext(new Date('2027-01-05T00:00:00Z'))).toContain(
      '"Last month" means December 2026 (month 12, year 2026)',
    );
  });
});
