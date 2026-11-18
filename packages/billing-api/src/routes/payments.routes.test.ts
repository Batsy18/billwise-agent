import request from 'supertest';
import { adminAuth, ALICE, BOB, bearer, buildTestApp, insertBill, tokenFor } from '../test/helpers';

const BOB_OCT = { subscriberNo: BOB, year: 2026, month: 10 };
const ALICE_OCT = { subscriberNo: ALICE, year: 2026, month: 10 };

function setup() {
  const t = buildTestApp();
  insertBill(t.repos, { ...BOB_OCT, phoneMinutes: 1350, internetMb: 35_000 }); // $80
  insertBill(t.repos, { ...ALICE_OCT, phoneMinutes: 0, internetMb: 0 }); // $50
  const pay = (body: object, token = tokenFor(BOB)) =>
    request(t.app).post('/api/v1/payments').set(bearer(token)).send(body);
  return { ...t, pay };
}

describe('POST /api/v1/payments', () => {
  it('partial payment → PARTIALLY_PAID with the remaining balance', async () => {
    const { pay, repos } = setup();
    const res = await pay({ ...BOB_OCT, amount: 30, transactionId: 'tx-1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      paymentStatus: 'SUCCESS',
      transactionId: 'tx-1',
      amount: 30,
      paidAmount: 30,
      remainingBalance: 50,
      billStatus: 'PARTIALLY_PAID',
    });
    expect(repos.payments.rows).toHaveLength(1);
    expect((await repos.bills.find(BOB_OCT))?.paidCents).toBe(3000);
  });

  it('paying the rest → PAID, remaining 0; cents survive (30.55 + 49.45)', async () => {
    const { pay } = setup();
    await pay({ ...BOB_OCT, amount: 30.55, transactionId: 'tx-1' });
    const res = await pay({ ...BOB_OCT, amount: 49.45, transactionId: 'tx-2' });
    expect(res.body).toMatchObject({ paidAmount: 80, remainingBalance: 0, billStatus: 'PAID' });
  });

  it('admin may pay on behalf of a subscriber', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/v1/payments')
      .set(adminAuth())
      .send({ ...BOB_OCT, amount: 80, transactionId: 'tx-admin' });
    expect(res.body.billStatus).toBe('PAID');
  });

  describe('duplicate transactionId → 409 DUPLICATE_TRANSACTION (idempotent retry, guide 5.3)', () => {
    it('same subscriber retrying → 409 with existingPayment, nothing charged twice', async () => {
      const { pay, repos } = setup();
      await pay({ ...BOB_OCT, amount: 30, transactionId: 'tx-retry' });
      const res = await pay({ ...BOB_OCT, amount: 30, transactionId: 'tx-retry' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'DUPLICATE_TRANSACTION',
        existingPayment: {
          amount: 30,
          paidAmount: 30,
          remainingBalance: 50,
          billStatus: 'PARTIALLY_PAID',
        },
      });
      expect(res.body.error.traceId).toEqual(expect.any(String));
      expect(repos.payments.rows).toHaveLength(1);
      expect((await repos.bills.find(BOB_OCT))?.paidCents).toBe(3000);
    });

    it('retrying a payment that settled the bill → 409 (not 422 BILL_ALREADY_PAID)', async () => {
      const { pay } = setup();
      await pay({ ...BOB_OCT, amount: 80, transactionId: 'tx-full' });
      const res = await pay({ ...BOB_OCT, amount: 80, transactionId: 'tx-full' });
      expect(res.status).toBe(409);
      expect(res.body.error.existingPayment).toEqual({
        amount: 80,
        paidAmount: 80,
        remainingBalance: 0,
        billStatus: 'PAID',
      });
    });

    it("another subscriber's transactionId → plain 409 without details", async () => {
      const { pay } = setup();
      await pay({ ...ALICE_OCT, amount: 50, transactionId: 'tx-alice' }, tokenFor(ALICE));
      const res = await pay({ ...BOB_OCT, amount: 10, transactionId: 'tx-alice' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE_TRANSACTION');
      expect(res.body.error).not.toHaveProperty('existingPayment');
      expect(Object.keys(res.body.error as object).sort()).toEqual(['code', 'message', 'traceId']);
    });
  });

  it('amount above the remaining balance → 422 AMOUNT_EXCEEDS_BALANCE, nothing stored', async () => {
    const { pay, repos } = setup();
    await pay({ ...BOB_OCT, amount: 30, transactionId: 'tx-1' });
    const res = await pay({ ...BOB_OCT, amount: 50.01, transactionId: 'tx-2' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    expect(repos.payments.rows).toHaveLength(1);
    expect((await repos.bills.find(BOB_OCT))?.paidCents).toBe(3000);
  });

  it('bill already fully paid → 422 BILL_ALREADY_PAID', async () => {
    const { pay } = setup();
    await pay({ ...BOB_OCT, amount: 80, transactionId: 'tx-1' });
    const res = await pay({ ...BOB_OCT, amount: 1, transactionId: 'tx-2' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BILL_ALREADY_PAID');
  });

  it.each([
    ['amount 0', { amount: 0 }],
    ['negative amount', { amount: -5 }],
    ['3 decimals', { amount: 30.555 }],
    ['amount as string', { amount: '30' }],
    ['missing amount', { amount: undefined }],
    ['missing transactionId', { transactionId: undefined }],
    ['transactionId with spaces', { transactionId: 'tx 1' }],
    ['month 13', { month: 13 }],
  ])('%s → 400 VALIDATION_ERROR', async (_case, override) => {
    const { pay, repos } = setup();
    const res = await pay({ ...BOB_OCT, amount: 10, transactionId: 'tx-v', ...override });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(repos.payments.rows).toHaveLength(0);
  });

  it("paying someone else's bill → 403", async () => {
    const { pay, repos } = setup();
    const res = await pay({ ...BOB_OCT, amount: 10, transactionId: 'tx-x' }, tokenFor(ALICE));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(repos.payments.rows).toHaveLength(0);
  });

  it('no token → 401', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/v1/payments')
      .send({ ...BOB_OCT, amount: 10, transactionId: 'tx-x' });
    expect(res.status).toBe(401);
  });

  it('bill not calculated → 404 BILL_NOT_FOUND', async () => {
    const { pay } = setup();
    const res = await pay({ ...BOB_OCT, month: 11, amount: 10, transactionId: 'tx-x' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BILL_NOT_FOUND');
  });
});
