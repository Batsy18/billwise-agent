import request from 'supertest';
import { ALICE, bearer, buildTestApp, tokenFor } from '../test/helpers';
import { jsonErrorLog, requestLog } from './request-log';

type Entry = Record<string, unknown> & { httpRequest: Record<string, unknown> };

function appWithLog(projectId?: string) {
  const lines: string[] = [];
  let t = 0n;
  const { app } = buildTestApp({
    requestLogger: requestLog({
      projectId,
      write: (l) => lines.push(l),
      now: () => (t += 2_500_000n), // +2.5 ms per call
    }),
  });
  const entries = () => lines.map((l) => JSON.parse(l) as Entry);
  return { app, entries };
}

describe('JSON request log (LOG_FORMAT=json)', () => {
  it('one structured line per request with severity, httpRequest and traceId', async () => {
    const { app, entries } = appWithLog();
    const res = await request(app).get('/api/v1/health?x=secret');
    expect(entries()).toEqual([
      {
        severity: 'INFO',
        message: 'GET /api/v1/health 200 2.5 ms',
        httpRequest: {
          requestMethod: 'GET',
          requestUrl: '/api/v1/health', // query string dropped
          status: 200,
          latency: '0.0025s',
          userAgent: undefined,
        },
        traceId: res.headers['x-trace-id'],
        auth: 'none',
      },
    ]);
  });

  it('records which header carried the token (gateway: X-Forwarded-Authorization), never the token', async () => {
    const { app, entries } = appWithLog();
    const token = tokenFor(ALICE);
    const res = await request(app)
      .get(`/api/v1/bills/${ALICE}/detailed?month=10&year=2026`)
      .set('Authorization', 'Bearer google-id-token-for-the-gateway')
      .set('X-Forwarded-Authorization', `Bearer ${token}`);
    expect(res.status).not.toBe(401); // the forwarded user token was used
    const [entry] = entries();
    expect(entry?.auth).toBe('x-forwarded-authorization');
    expect(JSON.stringify(entries())).not.toContain(token);

    await request(app).post('/api/v1/payments').set(bearer(token)).send({});
    expect(entries()[1]).toMatchObject({ auth: 'authorization', severity: 'WARNING' });
  });

  it('links to Cloud Trace only when the request came with X-Cloud-Trace-Context', async () => {
    const { app, entries } = appWithLog('my-project');
    const trace = '0123456789abcdef0123456789abcdef';
    await request(app).get('/api/v1/health').set('X-Cloud-Trace-Context', `${trace}/1;o=1`);
    await request(app).get('/api/v1/health');
    expect(entries()[0]).toMatchObject({
      traceId: trace,
      'logging.googleapis.com/trace': `projects/my-project/traces/${trace}`,
    });
    expect(entries()[1]).not.toHaveProperty('logging.googleapis.com/trace');
  });

  it('unhandled errors become one ERROR entry', () => {
    const lines: string[] = [];
    jsonErrorLog((l) => lines.push(l))('[t1] unhandled error', new Error('boom'));
    expect(JSON.parse(lines[0]!)).toMatchObject({ severity: 'ERROR' });
    expect(lines[0]).toContain('boom');
  });
});
