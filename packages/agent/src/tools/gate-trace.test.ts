import { callTools, say } from '../llm/mock';
import { bill, FakeBillingApi, harness, type Route } from '../test/fakes';

const PAY = callTools({ name: 'pay_bill', args: { month: 10, year: 2026, amount: 30 } });

function api(payRoute?: Route, billOver: Record<string, unknown> = {}) {
  const a = new FakeBillingApi().on('GET', /^\/api\/v1\/bills\/[^/]+$/, () => ({
    status: 200,
    body: bill(billOver),
  }));
  if (payRoute) a.on('POST', /\/payments$/, payRoute);
  return a;
}

const paid = () => ({
  status: 200,
  body: { paymentStatus: 'SUCCESS', remainingBalance: 50, billStatus: 'PARTIALLY_PAID' },
});

function eventsOf(h: ReturnType<typeof harness>) {
  const step = h.trace.exchanges[0]!.steps.find((s) => s.type === 'tool' && s.name === 'pay_bill');
  return step && step.type === 'tool' ? (step.events ?? []) : [];
}

describe('payment gate steps in the trace (console + JSON)', () => {
  it('confirmed with one network retry: balance → summary → answer → id → attempts → result', async () => {
    let n = 0;
    const h = harness({
      api: api(() => (++n === 1 ? 'network-error' : paid())),
      script: [PAY, say('ok')],
    });
    await h.agent.ask('30 öde');
    const ev = eventsOf(h);
    expect(ev.map((e) => e.event)).toEqual([
      'balance_check',
      'confirmation_shown',
      'user_answer',
      'transaction_id',
      'pay_attempt',
      'retry_wait',
      'pay_attempt',
      'api_result',
    ]);
    expect(ev[0]).toMatchObject({
      httpStatus: 200,
      total: 80,
      remainingBalance: 80,
      billStatus: 'UNPAID',
    });
    expect(ev[1]).toMatchObject({ summary: { amount: 30, month: 10, year: 2026 } });
    expect(ev[2]).toMatchObject({ answer: 'EVET', confirmed: true });
    expect(ev[3]).toMatchObject({ transactionId: 'txn-1' });
    expect(ev[4]).toMatchObject({ attempt: 1, transactionId: 'txn-1', result: 'network_error' });
    expect(ev[5]).toMatchObject({ attempt: 1, delayMs: 500, reason: 'network_error' });
    expect(ev[6]).toMatchObject({ attempt: 2, transactionId: 'txn-1', result: 'HTTP 200' });
    expect(ev[7]).toMatchObject({ httpStatus: 200, outcome: 'paid' });
    for (const e of ev) expect(e.elapsedMs).toBeGreaterThanOrEqual(0);

    const lines = h.printed.join('\n');
    expect(lines).toMatch(
      /↳ balance check \(query_bill\): total \$80\.00, remaining \$80\.00, UNPAID/,
    );
    expect(lines).toMatch(/↳ confirmation shown: \$30\.00 for 10\/2026/);
    expect(lines).toMatch(/↳ user answered "EVET" → confirmed/);
    expect(lines).toMatch(/↳ transactionId txn-1/);
    expect(lines).toMatch(/↳ retry 1 in 500 ms \(same transactionId\) after network_error/);
    expect(lines).toMatch(/↳ API result: 200 → paid/);
    // printed live, i.e. before the summary line of the pay_bill tool
    expect(lines.indexOf('↳ balance check')).toBeLessThan(lines.indexOf('▶ pay_bill'));
  });

  it('declined: stops after the answer (no transactionId, no POST attempts)', async () => {
    const h = harness({ api: api(paid), confirmAnswer: 'hayır', script: [PAY, say('iptal')] });
    await h.agent.ask('30 öde');
    expect(eventsOf(h).map((e) => e.event)).toEqual([
      'balance_check',
      'confirmation_shown',
      'user_answer',
    ]);
    expect(eventsOf(h)[2]).toMatchObject({ answer: 'hayır', confirmed: false });
  });

  it('a pre-check rejection is recorded', async () => {
    const h = harness({
      api: api(paid, { remainingBalance: 0, status: 'PAID' }),
      script: [PAY, say('x')],
    });
    await h.agent.ask('30 öde');
    expect(eventsOf(h).map((e) => [e.event, 'outcome' in e ? e.outcome : undefined])).toEqual([
      ['balance_check', undefined],
      ['precheck_rejected', 'already_paid'],
    ]);
  });

  it('409 + existingPayment is recorded as an idempotent replay', async () => {
    const h = harness({
      api: api(() => ({
        status: 409,
        body: {
          error: {
            code: 'DUPLICATE_TRANSACTION',
            existingPayment: { remainingBalance: 50, billStatus: 'PARTIALLY_PAID' },
          },
        },
      })),
      script: [PAY, say('ok')],
    });
    await h.agent.ask('30 öde');
    expect(eventsOf(h).at(-1)).toMatchObject({
      event: 'api_result',
      httpStatus: 409,
      outcome: 'paid',
      idempotentReplay: true,
    });
  });

  it('other tools carry no events', async () => {
    const h = harness({
      api: api(),
      script: [callTools({ name: 'query_bill', args: { month: 10, year: 2026 } }), say('x')],
    });
    await h.agent.ask('fatura');
    expect(h.trace.exchanges[0]!.steps.find((s) => s.type === 'tool')).not.toHaveProperty('events');
  });
});
