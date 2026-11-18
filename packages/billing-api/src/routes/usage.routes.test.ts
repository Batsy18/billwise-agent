import request from 'supertest';
import { adminAuth, ADMIN, ALICE, bearer, buildTestApp, tokenFor } from '../test/helpers';

const period = { subscriberNo: ALICE, year: 2026, month: 10 };

describe('POST /api/v1/usage (ADMIN)', () => {
  it('PHONE records +10 minutes', async () => {
    const { app, repos } = buildTestApp();
    const res = await request(app)
      .post('/api/v1/usage')
      .set(adminAuth())
      .send({ ...period, usageType: 'PHONE' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      status: 'SUCCESS',
      recorded: { type: 'PHONE', amount: 10, unit: 'MIN' },
    });
    expect(await repos.usage.totals(period)).toEqual({ phoneMinutes: 10, internetMb: 0 });
  });

  it('INTERNET records +1 MB; events accumulate', async () => {
    const { app, repos } = buildTestApp();
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app)
        .post('/api/v1/usage')
        .set(adminAuth())
        .send({ ...period, usageType: 'INTERNET' });
      expect(res.body.recorded).toEqual({ type: 'INTERNET', amount: 1, unit: 'MB' });
    }
    expect(await repos.usage.totals(period)).toEqual({ phoneMinutes: 0, internetMb: 3 });
  });

  it.each([
    ['invalid usageType', { ...period, usageType: 'SMS' }],
    ['month 13', { ...period, month: 13, usageType: 'PHONE' }],
    ['month 0', { ...period, month: 0, usageType: 'PHONE' }],
    ['month as string', { ...period, month: '10', usageType: 'PHONE' }],
    ['year out of range', { ...period, year: 1999, usageType: 'PHONE' }],
    ['missing subscriberNo', { year: 2026, month: 10, usageType: 'PHONE' }],
  ])('%s → 400', async (_case, body) => {
    const { app, repos } = buildTestApp();
    const res = await request(app).post('/api/v1/usage').set(adminAuth()).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(repos.usage.rows).toHaveLength(0);
  });

  it('subscriber (not admin) → 403, even for their own number', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/v1/usage')
      .set(bearer(tokenFor(ALICE)))
      .send({ ...period, usageType: 'PHONE' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('no token → 401', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/v1/usage')
      .send({ ...period, usageType: 'PHONE' });
    expect(res.status).toBe(401);
  });

  it.each([
    ['unknown subscriber', '5559999999'],
    ['the admin account (not billable)', ADMIN],
  ])('%s → 404 SUBSCRIBER_NOT_FOUND', async (_case, subscriberNo) => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/v1/usage')
      .set(adminAuth())
      .send({ ...period, subscriberNo, usageType: 'PHONE' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SUBSCRIBER_NOT_FOUND');
  });
});
