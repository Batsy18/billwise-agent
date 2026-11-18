/**
 * Integration suite: the real app + Prisma repositories against the local Docker Postgres
 * (database billwise_test). Run with `npm run test:int` — not part of `npm test`.
 * Each test truncates the tables and inserts its own data.
 */
import bcrypt from 'bcrypt';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../../app';
import { createPrismaClient } from '../../db/client';
import type { PrismaClient } from '../../generated/prisma/client';
import { createPrismaRepositories } from '../../repositories/prisma';
import { adminAuth, ALICE, BOB, bearer, PASSWORD, TEST_JWT, testKeys, tokenFor } from '../helpers';
import { testDatabaseUrl } from './env';

const BOB_OCT = { subscriberNo: BOB, year: 2026, month: 10 };
const ALICE_OCT = { subscriberNo: ALICE, year: 2026, month: 10 };

let prisma: PrismaClient;
let app: Express;

beforeAll(() => {
  prisma = createPrismaClient(testDatabaseUrl());
  app = createApp({
    repos: createPrismaRepositories(prisma),
    keys: testKeys,
    jwt: TEST_JWT,
    checkDatabase: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
    log: () => undefined,
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "payment", "bill", "usage_event", "subscriber" RESTART IDENTITY CASCADE',
  );
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  await prisma.subscriber.createMany({
    data: [
      { subscriberNo: 'admin', fullName: 'Admin', passwordHash, role: 'ADMIN' },
      { subscriberNo: ALICE, fullName: 'Alice', passwordHash, role: 'SUBSCRIBER' },
      { subscriberNo: BOB, fullName: 'Bob', passwordHash, role: 'SUBSCRIBER' },
    ],
  });
});

async function addEvents(
  period: typeof BOB_OCT,
  usageType: 'PHONE' | 'INTERNET',
  count: number,
): Promise<void> {
  const amount = usageType === 'PHONE' ? 10 : 1;
  for (let done = 0; done < count; done += 5_000) {
    const n = Math.min(5_000, count - done);
    await prisma.usageEvent.createMany({
      data: Array.from({ length: n }, () => ({ ...period, usageType, amount })),
    });
  }
}

/** Bob, Oct 2026: guide worked example → $80. */
async function bobBill80(): Promise<void> {
  await addEvents(BOB_OCT, 'PHONE', 135); // 1,350 min
  await addEvents(BOB_OCT, 'INTERNET', 35_000); // 35 GB
  const res = await request(app).post('/api/v1/bills/calculate').set(adminAuth()).send(BOB_OCT);
  expect(res.body.bill.total).toBe(80);
}

const pay = (body: object, token = tokenFor(BOB)) =>
  request(app).post('/api/v1/payments').set(bearer(token)).send(body);

const dbText = async (sql: string): Promise<string[]> =>
  (await prisma.$queryRawUnsafe<{ v: string }[]>(sql)).map((r) => r.v);

describe('health against a real database', () => {
  it('GET /api/v1/health/ready → 200', async () => {
    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
  });

  it('login works against stored bcrypt hashes', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ subscriberNo: BOB, password: PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe('Calculate Bill (Prisma)', () => {
  it('stores decimal(10,2) values and recalculation keeps paid_amount', async () => {
    await bobBill80();
    expect(await dbText(`SELECT total::text AS v FROM bill`)).toEqual(['80.00']);

    await pay({ ...BOB_OCT, amount: 30, transactionId: 'int-tx-1' });
    await addEvents(BOB_OCT, 'PHONE', 70); // +700 min → 2,050 min → phone $20
    const res = await request(app).post('/api/v1/bills/calculate').set(adminAuth()).send(BOB_OCT);

    expect(res.body.bill).toMatchObject({
      total: 90,
      phoneCharge: 20,
      paidAmount: 30,
      remainingBalance: 60,
      billStatus: 'PARTIALLY_PAID',
    });
    expect(await dbText(`SELECT paid_amount::text AS v FROM bill`)).toEqual(['30.00']);
    expect(await dbText(`SELECT count(*)::text AS v FROM bill`)).toEqual(['1']);
  });

  it('5551000002 Nov 2026 demo: usage exists, no bill → 404, calculate → stored', async () => {
    const nov = { ...BOB_OCT, month: 11 };
    await addEvents(nov, 'PHONE', 20);
    await addEvents(nov, 'INTERNET', 3_000);
    const before = await request(app).get(`/api/v1/bills/${BOB}?year=2026&month=11`);
    expect(before.status).toBe(404);
    await request(app).post('/api/v1/bills/calculate').set(adminAuth()).send(nov);
    const after = await request(app).get(`/api/v1/bills/${BOB}?year=2026&month=11`);
    expect(after.body).toMatchObject({ total: 50, status: 'UNPAID', dueDate: '2026-12-15' });
  });
});

describe('Pay Bill (Prisma, one transaction)', () => {
  it('partial then full; cents ↔ Decimal round-trip exactly (30.55 + 49.45)', async () => {
    await bobBill80();
    const partial = await pay({ ...BOB_OCT, amount: 30.55, transactionId: 'int-tx-1' });
    expect(partial.body).toMatchObject({
      paidAmount: 30.55,
      remainingBalance: 49.45,
      billStatus: 'PARTIALLY_PAID',
    });
    expect(await dbText(`SELECT amount::text AS v FROM payment`)).toEqual(['30.55']);

    const full = await pay({ ...BOB_OCT, amount: 49.45, transactionId: 'int-tx-2' });
    expect(full.body).toMatchObject({ paidAmount: 80, remainingBalance: 0, billStatus: 'PAID' });
    expect(await dbText(`SELECT paid_amount::text || ' ' || status AS v FROM bill`)).toEqual([
      '80.00 PAID',
    ]);
    expect(await dbText(`SELECT sum(amount)::text AS v FROM payment`)).toEqual(['80.00']);
  });

  it('duplicate transactionId → 409 with existingPayment; nothing written twice', async () => {
    await bobBill80();
    await pay({ ...BOB_OCT, amount: 30.55, transactionId: 'int-dup' });
    await pay({ ...BOB_OCT, amount: 49.45, transactionId: 'int-rest' });

    const retry = await pay({ ...BOB_OCT, amount: 30.55, transactionId: 'int-dup' });
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatchObject({
      code: 'DUPLICATE_TRANSACTION',
      existingPayment: { amount: 30.55, paidAmount: 80, remainingBalance: 0, billStatus: 'PAID' },
    });
    expect(await dbText(`SELECT count(*)::text AS v FROM payment`)).toEqual(['2']);
  });

  it("someone else's transactionId → plain 409", async () => {
    await bobBill80();
    await request(app).post('/api/v1/bills/calculate').set(adminAuth()).send(ALICE_OCT);
    await pay({ ...ALICE_OCT, amount: 10, transactionId: 'int-alice' }, tokenFor(ALICE));
    const res = await pay({ ...BOB_OCT, amount: 10, transactionId: 'int-alice' });
    expect(res.status).toBe(409);
    expect(res.body.error).not.toHaveProperty('existingPayment');
  });

  it('422 rolls back: no payment row, paid_amount unchanged', async () => {
    await bobBill80();
    const res = await pay({ ...BOB_OCT, amount: 80.01, transactionId: 'int-too-much' });
    expect(res.status).toBe(422);
    expect(await dbText(`SELECT count(*)::text AS v FROM payment`)).toEqual(['0']);
    expect(await dbText(`SELECT paid_amount::text AS v FROM bill`)).toEqual(['0.00']);
  });

  it('concurrent payments are serialised by the row lock: 5 × $20 on $80 → 4 succeed', async () => {
    await bobBill80();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        pay({ ...BOB_OCT, amount: 20, transactionId: `int-c-${i}` }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 422]);
    expect(await dbText(`SELECT paid_amount::text || ' ' || status AS v FROM bill`)).toEqual([
      '80.00 PAID',
    ]);
  });

  it('concurrent retries with the same transactionId → exactly one payment', async () => {
    await bobBill80();
    const results = await Promise.all(
      Array.from({ length: 3 }, () => pay({ ...BOB_OCT, amount: 10, transactionId: 'int-same' })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await dbText(`SELECT count(*)::text AS v FROM payment`)).toEqual(['1']);
  });

  it('no calculated bill → 404 and the transaction writes nothing', async () => {
    const res = await pay({ ...BOB_OCT, amount: 10, transactionId: 'int-no-bill' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BILL_NOT_FOUND');
    expect(await dbText(`SELECT count(*)::text AS v FROM payment`)).toEqual(['0']);
  });
});

describe('Add Usage + concurrent Calculate (Prisma)', () => {
  it('POST /usage stores events that Calculate then totals', async () => {
    for (const usageType of ['PHONE', 'PHONE', 'INTERNET']) {
      const res = await request(app)
        .post('/api/v1/usage')
        .set(adminAuth())
        .send({ ...BOB_OCT, usageType });
      expect(res.status).toBe(201);
    }
    expect(
      await dbText(
        `SELECT usage_type::text || ':' || sum(amount)::text AS v FROM usage_event GROUP BY usage_type ORDER BY 1`,
      ),
    ).toEqual(['INTERNET:1', 'PHONE:20']);
  });

  it('two first-time calculations racing → both 200, exactly one bill row', async () => {
    await addEvents(BOB_OCT, 'PHONE', 135);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app).post('/api/v1/bills/calculate').set(adminAuth()).send(BOB_OCT),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(await dbText(`SELECT count(*)::text AS v FROM bill`)).toEqual(['1']);
  });
});

describe('Query Bill Detailed paging (Prisma)', () => {
  it('order (created_at, id) is stable across pages; ties broken by id', async () => {
    await addEvents(BOB_OCT, 'INTERNET', 250); // one createMany → identical created_at
    await request(app).post('/api/v1/bills/calculate').set(adminAuth()).send(BOB_OCT);

    type Item = { id: string; createdAt: string };
    const page = async (n: number) =>
      (
        await request(app)
          .get(`/api/v1/bills/${BOB}/detailed?year=2026&month=10&page=${n}&pageSize=100`)
          .set(bearer(tokenFor(BOB)))
      ).body.usageEvents as { items: Item[]; totalItems: number; totalPages: number };

    const p1 = await page(1);
    const p2 = await page(2);
    const p3 = await page(3);
    expect(p1).toMatchObject({ totalItems: 250, totalPages: 3 });
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([100, 100, 50]);

    const all = [...p1.items, ...p2.items, ...p3.items];
    expect(new Set(all.map((e) => e.id)).size).toBe(250);
    expect(new Set(all.map((e) => e.createdAt)).size).toBe(1); // all tied on created_at
    const ids = all.map((e) => e.id);
    expect(ids).toEqual([...ids].sort()); // so id decides, in Postgres and JS alike

    expect((await page(2)).items.map((e) => e.id)).toEqual(p2.items.map((e) => e.id));
  });
});
