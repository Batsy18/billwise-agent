import request from 'supertest';
import type { MemoryRepositories } from '../repositories/memory';
import { adminAuth, ALICE, BOB, bearer, buildTestApp, tokenFor } from '../test/helpers';

const BOB_OCT = { subscriberNo: BOB, year: 2026, month: 10 };

async function addUsage(repos: MemoryRepositories, minutes: number, mb: number): Promise<void> {
  for (let i = 0; i < minutes / 10; i += 1) await repos.usage.add(BOB_OCT, 'PHONE', 10);
  for (let i = 0; i < mb; i += 1) await repos.usage.add(BOB_OCT, 'INTERNET', 1);
}

const calculate = (app: Parameters<typeof request>[0], body: object = BOB_OCT) =>
  request(app).post('/api/v1/bills/calculate').set(adminAuth()).send(body);

describe('POST /api/v1/bills/calculate (ADMIN)', () => {
  it('guide worked example: 1,350 min + 35 GB → $80, due 2026-11-15', async () => {
    const { app, repos } = buildTestApp();
    await addUsage(repos, 1350, 35_000);
    const res = await calculate(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'SUCCESS',
      bill: {
        total: 80,
        phoneCharge: 10,
        internetCharge: 70,
        dueDate: '2026-11-15',
        paidAmount: 0,
        remainingBalance: 80,
        billStatus: 'UNPAID',
      },
    });
    const stored = await repos.bills.find(BOB_OCT);
    expect(stored).toMatchObject({ phoneMinutes: 1350, internetMb: 35_000, totalCents: 8000 });
  });

  it('a month without usage → $50 internet base', async () => {
    const { app } = buildTestApp();
    const res = await calculate(app, { subscriberNo: ALICE, year: 2026, month: 11 });
    expect(res.status).toBe(200);
    expect(res.body.bill).toMatchObject({ total: 50, phoneCharge: 0, internetCharge: 50 });
  });

  it('recalculation updates the total, keeps paidAmount and re-derives the status', async () => {
    const { app, repos } = buildTestApp();
    await addUsage(repos, 0, 0);
    await calculate(app); // $50
    const pay = await request(app)
      .post('/api/v1/payments')
      .set(bearer(tokenFor(BOB)))
      .send({ ...BOB_OCT, amount: 50, transactionId: 'tx-1' });
    expect(pay.body.billStatus).toBe('PAID');

    await addUsage(repos, 1010, 0); // now 1,010 min → +$10 phone
    const res = await calculate(app);
    expect(res.body.bill).toMatchObject({
      total: 60,
      paidAmount: 50, // preserved
      remainingBalance: 10,
      billStatus: 'PARTIALLY_PAID', // re-derived: was PAID
    });
    const stored = await repos.bills.find(BOB_OCT);
    expect(stored?.paidCents).toBe(5000);
    expect(repos.bills.rows.size).toBe(1); // updated in place, not a second bill
  });

  it('recalculated total below the paid amount → PAID with $0 remaining', async () => {
    const { app, repos } = buildTestApp();
    await addUsage(repos, 1010, 0);
    await calculate(app); // $60
    await request(app)
      .post('/api/v1/payments')
      .set(bearer(tokenFor(BOB)))
      .send({ ...BOB_OCT, amount: 60, transactionId: 'tx-2' });
    repos.usage.rows.splice(0); // usage corrected downwards (e.g. by an operator)
    const res = await calculate(app);
    expect(res.body.bill).toMatchObject({
      total: 50,
      paidAmount: 60,
      remainingBalance: 0,
      billStatus: 'PAID',
    });
  });

  it('subscriber (not admin) → 403', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/v1/bills/calculate')
      .set(bearer(tokenFor(BOB)))
      .send(BOB_OCT);
    expect(res.status).toBe(403);
  });

  it('no token → 401', async () => {
    const { app } = buildTestApp();
    expect((await request(app).post('/api/v1/bills/calculate').send(BOB_OCT)).status).toBe(401);
  });

  it('unknown subscriber → 404 SUBSCRIBER_NOT_FOUND', async () => {
    const { app } = buildTestApp();
    const res = await calculate(app, { ...BOB_OCT, subscriberNo: '5559999999' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SUBSCRIBER_NOT_FOUND');
  });

  it.each([
    ['month 13', { ...BOB_OCT, month: 13 }],
    ['missing year', { subscriberNo: BOB, month: 10 }],
    ['fractional month', { ...BOB_OCT, month: 10.5 }],
  ])('%s → 400', async (_case, body) => {
    const { app } = buildTestApp();
    const res = await calculate(app, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
