import { MAX_TURNS, MAX_TURNS_MESSAGE } from './agent';
import { callTools, say } from './llm/mock';
import { LlmUnavailableError } from './llm/types';
import {
  bill,
  detailed,
  FakeBillingApi,
  FakeDocs,
  harness,
  lastToolResults,
  match,
  ME,
  OTHER,
} from './test/fakes';

const billApi = () =>
  new FakeBillingApi()
    .on('GET', /\/detailed$/, () => ({ status: 200, body: detailed() }))
    .on('GET', /^\/api\/v1\/bills\/[^/]+$/, () => ({ status: 200, body: bill() }));

describe('scenarios', () => {
  it('MCP-only: the guide is searched, results go back to the LLM, answer comes from the LLM', async () => {
    const docs = new FakeDocs(() => [match('3.2', 'Each additional 10 GB block costs $10.')]);
    const h = harness({
      docs,
      script: [
        callTools({ name: 'search_billing_documentation', args: { query: 'extra internet cost' } }),
        say('Bölüm 3.2: her ek 10 GB blok 10 $.'),
      ],
    });
    const a = await h.agent.ask('Ek internet ne kadar?');
    expect(a).toEqual({ text: 'Bölüm 3.2: her ek 10 GB blok 10 $.', reason: 'llm' });
    expect(docs.queries).toEqual([{ query: 'extra internet cost' }]);
    expect(h.api.requests).toHaveLength(0);
    expect(lastToolResults(h)[0]).toMatchObject({ matches: [{ section: '3.2' }] });
  });

  it('REST-only: query_bill uses the JWT subscriber and the bearer token', async () => {
    const h = harness({
      api: billApi(),
      script: [callTools({ name: 'query_bill', args: { month: 10, year: 2026 } }), say('80 $')],
    });
    await h.agent.ask('Ekim faturam ne kadar?');
    expect(h.api.paths()).toEqual([`GET /api/v1/bills/${ME}?month=10&year=2026`]);
    expect(h.api.requests[0]?.authorization).toBe('Bearer jwt-of-5551000002');
    expect(lastToolResults(h)[0]).toMatchObject({ status: 'ok', bill: { total: 80 } });
  });

  it('combined: detailed bill + guide search in one turn, pageSize fixed at 10', async () => {
    const docs = new FakeDocs(() => [match('2.2'), match('3.2')]);
    const h = harness({
      api: billApi(),
      docs,
      script: [
        callTools(
          { name: 'query_bill_detailed', args: { month: 10, year: 2026 } },
          {
            name: 'search_billing_documentation',
            args: { query: 'additional minutes internet blocks' },
          },
        ),
        say('Telefon: 1 ek blok (Bölüm 2.2), internet: 2 ek blok (Bölüm 3.2).'),
      ],
    });
    await h.agent.ask('Ekim faturam neden yüksek?');
    expect(h.api.paths()).toEqual([
      `GET /api/v1/bills/${ME}/detailed?month=10&year=2026&page=1&pageSize=10`,
    ]);
    expect(lastToolResults(h)).toHaveLength(2);
    expect(h.trace.exchanges[0]?.steps.map((s) => s.type)).toEqual([
      'llm',
      'tool',
      'tool',
      'llm',
      'final',
    ]);
  });
});

describe('another subscriber number never reaches the API', () => {
  it('an invented subscriberNo argument is dropped; the JWT subscriber is used', async () => {
    const h = harness({
      api: billApi(),
      script: [
        callTools({ name: 'query_bill', args: { month: 10, year: 2026, subscriberNo: OTHER } }),
        callTools({
          name: 'query_bill_detailed',
          args: { month: 10, year: 2026, subscriberNo: OTHER },
        }),
        say('ok'),
      ],
    });
    await h.agent.ask(`${OTHER} numaralı hattın faturasını göster`);
    expect(h.api.requests.length).toBe(2);
    for (const r of h.api.requests) {
      expect(r.url.pathname).toContain(ME);
      expect(r.url.href).not.toContain(OTHER);
    }
  });

  it('pay_bill with a foreign subscriberNo still pays only the own bill', async () => {
    const api = billApi().on('POST', /\/payments$/, (req) => ({
      status: 200,
      body: {
        paymentStatus: 'SUCCESS',
        subscriberNo: req.body?.subscriberNo,
        remainingBalance: 50,
        billStatus: 'PARTIALLY_PAID',
      },
    }));
    const h = harness({
      api,
      script: [
        callTools({
          name: 'pay_bill',
          args: { month: 10, year: 2026, amount: 30, subscriberNo: OTHER },
        }),
        say('paid'),
      ],
    });
    await h.agent.ask(`${OTHER} için 30 dolar öde`);
    const post = h.api.requests.find((r) => r.method === 'POST');
    expect(post?.body).toEqual({
      subscriberNo: ME,
      month: 10,
      year: 2026,
      amount: 30,
      transactionId: 'txn-1',
    });
    expect(JSON.stringify(h.api.requests.map((r) => [r.url.href, r.body]))).not.toContain(OTHER);
  });

  it('the tools themselves offer no subscriber parameter', () => {
    const h = harness({ script: [] });
    const decls = (
      h.agent as unknown as {
        deps: { executor: { declarations(): { name: string; parameters: object }[] } };
      }
    ).deps.executor.declarations();
    expect(decls.map((d) => d.name)).toEqual([
      'search_billing_documentation',
      'query_bill',
      'query_bill_detailed',
      'pay_bill',
    ]);
    expect(JSON.stringify(decls)).not.toMatch(/subscriber(No|_no|Number)/i);
  });
});

describe('errors and guards', () => {
  it('401 from the API → session_expired reaches the LLM and the session is marked expired', async () => {
    const api = new FakeBillingApi().on('GET', /bills/, () => ({
      status: 401,
      body: { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } },
    }));
    const h = harness({
      api,
      script: [
        callTools({ name: 'query_bill', args: { month: 10, year: 2026 } }),
        say('Lütfen tekrar giriş yapın.'),
      ],
    });
    await h.agent.ask('Ekim faturam?');
    expect(lastToolResults(h)[0]).toMatchObject({ status: 'session_expired' });
    expect(h.session.expired).toBe(true);
  });

  it('404 BILL_NOT_FOUND → not_calculated (the LLM must not estimate)', async () => {
    const api = new FakeBillingApi().on('GET', /bills/, () => ({
      status: 404,
      body: { error: { code: 'BILL_NOT_FOUND', message: 'not calculated' } },
    }));
    const h = harness({
      api,
      script: [
        callTools({ name: 'query_bill', args: { month: 11, year: 2026 } }),
        say('henüz yok'),
      ],
    });
    await h.agent.ask('Kasım faturam?');
    expect(lastToolResults(h)[0]).toMatchObject({ status: 'not_calculated' });
  });

  it('billing API unreachable → service_unavailable result, no crash', async () => {
    const api = new FakeBillingApi().on('GET', /bills/, () => 'network-error');
    const h = harness({
      api,
      script: [
        callTools({ name: 'query_bill', args: { month: 10, year: 2026 } }),
        say('servis yok'),
      ],
    });
    await h.agent.ask('Ekim faturam?');
    expect(lastToolResults(h)[0]).toMatchObject({ status: 'service_unavailable' });
  });

  it('empty MCP matches → exactly one retry; a third search is blocked without calling MCP', async () => {
    const docs = new FakeDocs(() => []);
    const h = harness({
      docs,
      script: [
        callTools({
          name: 'search_billing_documentation',
          args: { query: 'complain about my bill' },
        }),
        callTools({
          name: 'search_billing_documentation',
          args: { query: 'billing dispute deadline' },
        }),
        callTools({ name: 'search_billing_documentation', args: { query: 'objection' } }),
        say('Kılavuzda bu konu yok.'),
      ],
    });
    await h.agent.ask('Faturamdan şikayetçiyim');
    expect(docs.queries.map((q) => q.query)).toEqual([
      'complain about my bill',
      'billing dispute deadline',
    ]);
    expect(lastToolResults(h)[0]).toMatchObject({ status: 'no_more_retries', matches: [] });
  });

  it('an empty search followed by a hit resets the retry budget', async () => {
    const docs = new FakeDocs((q) => (q === 'dispute' ? [match('7.1')] : []));
    const h = harness({
      docs,
      script: [
        callTools({ name: 'search_billing_documentation', args: { query: 'complain' } }),
        callTools({ name: 'search_billing_documentation', args: { query: 'dispute' } }),
        callTools({ name: 'search_billing_documentation', args: { query: 'x1' } }),
        callTools({ name: 'search_billing_documentation', args: { query: 'x2' } }),
        say('done'),
      ],
    });
    await h.agent.ask('?');
    expect(docs.queries).toHaveLength(4);
  });

  it(`max-turn guard: stops after ${MAX_TURNS} LLM turns with a fixed message`, async () => {
    const loop = Array.from({ length: 10 }, () =>
      callTools({ name: 'search_billing_documentation', args: { query: 'bill' } }),
    );
    const h = harness({ docs: new FakeDocs(() => [match('4.2')]), script: loop });
    const a = await h.agent.ask('loop forever');
    expect(a).toEqual({ text: MAX_TURNS_MESSAGE, reason: 'max_turns' });
    expect(h.llm.requests).toHaveLength(MAX_TURNS);
  });

  it('LLM unavailable (quota) → its message is returned, the question leaves the history', async () => {
    const h = harness({
      script: [
        () => {
          throw new LlmUnavailableError('The Gemini daily free-tier quota is used up.');
        },
      ],
    });
    const a = await h.agent.ask('Ek internet ne kadar?');
    expect(a.reason).toBe('llm_unavailable');
    expect(a.text).toMatch(/quota/);
    expect(h.agent.history).toEqual([]);
  });

  it('unknown tool name → error result, loop continues', async () => {
    const h = harness({
      script: [callTools({ name: 'delete_all_bills', args: {} }), say('cannot')],
    });
    await h.agent.ask('?');
    expect(lastToolResults(h)[0]).toMatchObject({ status: 'unknown_tool' });
  });
});

describe('what the LLM is given', () => {
  it('system prompt carries today, last month and the logged-in subscriber', async () => {
    const h = harness({ script: [say('hi')] });
    await h.agent.ask('merhaba');
    const system = h.llm.requests[0]!.system;
    expect(system).toContain('Today is 2026-11-18');
    expect(system).toContain('"Last month" means October 2026 (month 10, year 2026)');
    expect(system).toContain(ME);
    expect(system).toMatch(/retry ONCE/);
    expect(system).toMatch(/Never promise a refund/);
  });

  it('the conversation history is kept across questions', async () => {
    const h = harness({ script: [say('one'), say('two')] });
    await h.agent.ask('first');
    await h.agent.ask('second');
    expect(h.llm.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});
