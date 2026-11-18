import request from 'supertest';
import type { MemoryRepositories } from '../repositories/memory';
import { adminAuth, ALICE, BOB, bearer, buildTestApp, insertBill, tokenFor } from '../test/helpers';

const BOB_OCT = { subscriberNo: BOB, year: 2026, month: 10 };
const detailedUrl = (q = '', no = BOB) => `/api/v1/bills/${no}/detailed?year=2026&month=10${q}`;

function seedBob(repos: MemoryRepositories, events: number): Promise<unknown[]> {
  insertBill(repos, { ...BOB_OCT, phoneMinutes: 1350, internetMb: 35_000, paidCents: 3000 });
  return Promise.all(
    Array.from({ length: events }, (_, i) =>
      repos.usage.add(BOB_OCT, i % 2 ? 'PHONE' : 'INTERNET', i % 2 ? 10 : 1),
    ),
  );
}

describe('GET /api/v1/bills/{subscriberNo} (public)', () => {
  it('returns the stored bill fields without any token', async () => {
    const { app, repos } = buildTestApp();
    await seedBob(repos, 0);
    const res = await request(app).get(`/api/v1/bills/${BOB}?month=10&year=2026`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      subscriberNo: BOB,
      month: 10,
      year: 2026,
      total: 80,
      paidAmount: 30,
      remainingBalance: 50,
      status: 'PARTIALLY_PAID',
      dueDate: '2026-11-15',
    });
  });

  it('not calculated yet → 404 BILL_NOT_FOUND', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get(`/api/v1/bills/${BOB}?month=11&year=2026`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BILL_NOT_FOUND');
  });

  it.each([
    ['month=13', '?month=13&year=2026'],
    ['month=abc', '?month=abc&year=2026'],
    ['missing year', '?month=10'],
    ['no query at all', ''],
  ])('invalid period (%s) → 400', async (_case, q) => {
    const { app } = buildTestApp();
    const res = await request(app).get(`/api/v1/bills/${BOB}${q}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/bills/{subscriberNo}/detailed (self or admin)', () => {
  it('returns summary + usage + charge breakdown + first page (default pageSize 20)', async () => {
    const { app, repos } = buildTestApp();
    await seedBob(repos, 45);
    const res = await request(app)
      .get(detailedUrl())
      .set(bearer(tokenFor(BOB)));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      subscriberNo: BOB,
      total: 80,
      paidAmount: 30,
      remainingBalance: 50,
      status: 'PARTIALLY_PAID',
      usage: { phoneMinutes: 1350, internetMB: 35_000, internetGB: 35 },
      charges: {
        phone: { includedMinutes: 1000, extraBlocks: 1, amount: 10 },
        internet: { base: 50, extraBlocks: 2, amount: 70 },
      },
    });
    expect(res.body.usageEvents).toMatchObject({
      page: 1,
      pageSize: 20,
      totalItems: 45,
      totalPages: 3,
    });
    expect(res.body.usageEvents.items).toHaveLength(20);
    expect(res.body.usageEvents.items[0]).toEqual({
      id: expect.any(String),
      usageType: 'INTERNET',
      amount: 1,
      unit: 'MB',
      createdAt: expect.stringMatching(/^2026-10-01T/),
    });
  });

  it('pages are stable and do not overlap; the last page is partial, past the end is empty', async () => {
    const { app, repos } = buildTestApp();
    await seedBob(repos, 45);
    const get = async (page: number) =>
      (
        await request(app)
          .get(detailedUrl(`&page=${page}&pageSize=20`))
          .set(bearer(tokenFor(BOB)))
      ).body.usageEvents as { items: { id: string; createdAt: string }[] };

    const [p1, p2, p3, p4, p2again] = await Promise.all([get(1), get(2), get(3), get(4), get(2)]);
    const ids = [...p1.items, ...p2.items, ...p3.items].map((e) => e.id);
    expect(ids).toHaveLength(45);
    expect(new Set(ids).size).toBe(45);
    expect(p3.items).toHaveLength(5);
    expect(p4.items).toEqual([]);
    expect(p2again.items.map((e) => e.id)).toEqual(p2.items.map((e) => e.id));
    const times = [...p1.items, ...p2.items, ...p3.items].map((e) => e.createdAt);
    expect(times).toEqual([...times].sort());
  });

  it('ties on created_at are broken by id', async () => {
    const sameInstant = new Date(Date.UTC(2026, 9, 5));
    const { app, repos } = buildTestApp({ now: () => sameInstant });
    await seedBob(repos, 10);
    const res = await request(app).get(detailedUrl('&pageSize=10')).set(adminAuth());
    const ids = (res.body.usageEvents.items as { id: string }[]).map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('admin can read any subscriber', async () => {
    const { app, repos } = buildTestApp();
    await seedBob(repos, 1);
    expect((await request(app).get(detailedUrl()).set(adminAuth())).status).toBe(200);
  });

  it('no token → 401', async () => {
    const { app } = buildTestApp();
    expect((await request(app).get(detailedUrl())).status).toBe(401);
  });

  it("someone else's account → 403 (even when no bill exists: no existence leak)", async () => {
    const { app, repos } = buildTestApp();
    await seedBob(repos, 1);
    const alice = bearer(tokenFor(ALICE));
    const res = await request(app).get(detailedUrl()).set(alice);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    const noBill = await request(app).get(detailedUrl().replace('month=10', 'month=11')).set(alice);
    expect(noBill.status).toBe(403);
  });

  it.each([
    ['pageSize=101 (max 100)', '&pageSize=101'],
    ['pageSize=0', '&pageSize=0'],
    ['page=0', '&page=0'],
    ['page=abc', '&page=abc'],
  ])('%s → 400', async (_case, q) => {
    const { app, repos } = buildTestApp();
    await seedBob(repos, 1);
    const res = await request(app)
      .get(detailedUrl(q))
      .set(bearer(tokenFor(BOB)));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('pageSize=100 is allowed', async () => {
    const { app, repos } = buildTestApp();
    await seedBob(repos, 120);
    const res = await request(app)
      .get(detailedUrl('&pageSize=100'))
      .set(bearer(tokenFor(BOB)));
    expect(res.body.usageEvents).toMatchObject({ pageSize: 100, totalPages: 2 });
    expect(res.body.usageEvents.items).toHaveLength(100);
  });

  it('own account but not calculated → 404 BILL_NOT_FOUND', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .get(detailedUrl())
      .set(bearer(tokenFor(BOB)));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BILL_NOT_FOUND');
  });
});
