import { callTools, say } from '../llm/mock';
import { bill, FakeBillingApi, harness, lastToolResults, ME } from '../test/fakes';
import { isConfirmation } from './payment-gate';

const PAY = callTools({ name: 'pay_bill', args: { month: 10, year: 2026, amount: 30 } });

function api(
  payRoute?: Parameters<FakeBillingApi['on']>[2],
  billOver: Record<string, unknown> = {},
) {
  const a = new FakeBillingApi().on('GET', /^\/api\/v1\/bills\/[^/]+$/, () => ({
    status: 200,
    body: bill(billOver),
  }));
  if (payRoute) a.on('POST', /\/payments$/, payRoute);
  return a;
}

const paid = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    paymentStatus: 'SUCCESS',
    amount: 30,
    paidAmount: 30,
    remainingBalance: 50,
    billStatus: 'PARTIALLY_PAID',
    ...over,
  },
});

const posts = (h: ReturnType<typeof harness>) => h.api.requests.filter((r) => r.method === 'POST');

describe('isConfirmation', () => {
  it.each(['EVET', 'evet', 'Yes', ' YES '])('accepts %p', (s) =>
    expect(isConfirmation(s)).toBe(true),
  );
  it.each(['', 'y', 'e', 'yes please', 'evet öde', 'hayır', 'no', 'ok', 'EVETT'])(
    'rejects %p',
    (s) => expect(isConfirmation(s)).toBe(false),
  );
});

describe('pay_bill gate', () => {
  it('confirmed: query_bill first, summary shown, one POST, result paid', async () => {
    const h = harness({ api: api(() => paid()), script: [PAY, say('ödendi, kalan 50 $')] });
    await h.agent.ask('Faturamın 30 dolarını öde');
    expect(h.api.paths()).toEqual([
      `GET /api/v1/bills/${ME}?month=10&year=2026`,
      'POST /api/v1/payments',
    ]);
    expect(h.confirmations).toEqual([
      {
        subscriberNo: ME,
        month: 10,
        year: 2026,
        amount: 30,
        total: 80,
        remainingBalance: 80,
        dueDate: '2026-11-15',
      },
    ]);
    expect(posts(h)[0]?.body).toEqual({
      subscriberNo: ME,
      month: 10,
      year: 2026,
      amount: 30,
      transactionId: 'txn-1',
    });
    expect(lastToolResults(h)[0]).toMatchObject({
      status: 'paid',
      transactionId: 'txn-1',
      payment: { remainingBalance: 50 },
    });
  });

  it.each(['hayır', 'yes please', '', 'tamam'])(
    'declined (%p): cancelled_by_user, the API is never called',
    async (answer) => {
      const h = harness({
        api: api(() => paid()),
        confirmAnswer: answer,
        script: [PAY, say('iptal')],
      });
      await h.agent.ask('30 dolar öde');
      expect(posts(h)).toHaveLength(0);
      expect(lastToolResults(h)[0]).toEqual({
        status: 'cancelled_by_user',
        message: 'The user did not confirm. No payment was made.',
      });
    },
  );

  it('409 with existingPayment counts as success (idempotent replay, guide 5.3)', async () => {
    const h = harness({
      api: api(() => ({
        status: 409,
        body: {
          error: {
            code: 'DUPLICATE_TRANSACTION',
            message: 'already used',
            traceId: 't',
            existingPayment: {
              amount: 30,
              paidAmount: 30,
              remainingBalance: 50,
              billStatus: 'PARTIALLY_PAID',
            },
          },
        },
      })),
      script: [PAY, say('ok')],
    });
    await h.agent.ask('30 öde');
    expect(lastToolResults(h)[0]).toEqual({
      status: 'paid',
      idempotentReplay: true,
      transactionId: 'txn-1',
      payment: { amount: 30, paidAmount: 30, remainingBalance: 50, billStatus: 'PARTIALLY_PAID' },
    });
  });

  it('network failure then success: retried with the SAME transactionId', async () => {
    let n = 0;
    const h = harness({
      api: api(() => (++n === 1 ? 'network-error' : n === 2 ? { status: 503 } : paid())),
      script: [PAY, say('ok')],
    });
    await h.agent.ask('30 öde');
    expect(posts(h).map((p) => p.body?.transactionId)).toEqual(['txn-1', 'txn-1', 'txn-1']);
    expect(h.confirmations).toHaveLength(1); // the user is asked once
    expect(lastToolResults(h)[0]).toMatchObject({ status: 'paid', transactionId: 'txn-1' });
  });

  it('network keeps failing → payment_unknown, never "paid"', async () => {
    const h = harness({ api: api(() => 'network-error'), script: [PAY, say('belirsiz')] });
    await h.agent.ask('30 öde');
    expect(posts(h)).toHaveLength(4); // first try + 3 retries, all txn-1
    expect(new Set(posts(h).map((p) => p.body?.transactionId))).toEqual(new Set(['txn-1']));
    expect(lastToolResults(h)[0]).toMatchObject({
      status: 'payment_unknown',
      transactionId: 'txn-1',
    });
  });

  it('409 WITHOUT existingPayment (someone else’s id) is not success', async () => {
    const h = harness({
      api: api(() => ({
        status: 409,
        body: { error: { code: 'DUPLICATE_TRANSACTION', message: 'x', traceId: 't' } },
      })),
      script: [PAY, say('hata')],
    });
    await h.agent.ask('30 öde');
    expect(lastToolResults(h)[0]).toMatchObject({ status: 'error', code: 'DUPLICATE_TRANSACTION' });
  });

  describe('pre-checks answered without asking the user', () => {
    it.each([
      [
        'amount above the remaining balance',
        { remainingBalance: 20 },
        { status: 'rejected', reason: 'amount_exceeds_balance', remainingBalance: 20 },
      ],
      [
        'bill already paid',
        { remainingBalance: 0, paidAmount: 80, status: 'PAID' },
        { status: 'already_paid' },
      ],
    ])('%s', async (_case, over, expected) => {
      const h = harness({ api: api(() => paid(), over), script: [PAY, say('x')] });
      await h.agent.ask('30 öde');
      expect(h.confirmations).toHaveLength(0);
      expect(posts(h)).toHaveLength(0);
      expect(lastToolResults(h)[0]).toMatchObject(expected);
    });

    it('no bill calculated → not_calculated', async () => {
      const a = new FakeBillingApi().on('GET', /bills/, () => ({
        status: 404,
        body: { error: { code: 'BILL_NOT_FOUND' } },
      }));
      const h = harness({ api: a, script: [PAY, say('x')] });
      await h.agent.ask('30 öde');
      expect(h.confirmations).toHaveLength(0);
      expect(lastToolResults(h)[0]).toMatchObject({ status: 'not_calculated' });
    });

    it.each([30.555, -5, 0, 'abc'])(
      'invalid amount %p → invalid_amount, no API call',
      async (amount) => {
        const h = harness({
          api: api(() => paid()),
          script: [
            callTools({ name: 'pay_bill', args: { month: 10, year: 2026, amount } }),
            say('x'),
          ],
        });
        await h.agent.ask('öde');
        expect(h.api.requests).toHaveLength(0);
        expect(lastToolResults(h)[0]).toMatchObject({ status: 'invalid_amount' });
      },
    );
  });

  it('cents compare exactly: paying the full 49.45 of 49.45 is allowed', async () => {
    const h = harness({
      api: api(() => paid({ remainingBalance: 0, billStatus: 'PAID' }), {
        remainingBalance: 49.45,
      }),
      script: [
        callTools({ name: 'pay_bill', args: { month: 10, year: 2026, amount: 49.45 } }),
        say('ok'),
      ],
    });
    await h.agent.ask('kalanı öde');
    expect(posts(h)).toHaveLength(1);
  });
});
