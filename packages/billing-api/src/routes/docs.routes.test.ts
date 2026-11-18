import request from 'supertest';
import { loadOpenApi } from './docs.routes';
import { buildTestApp } from '../test/helpers';

const doc = loadOpenApi() as { openapi: string; paths: Record<string, Record<string, unknown>> };
const { app } = buildTestApp();

// Every operation the API implements. If a route is added or removed, this list, the spec and
// the app must change together.
const IMPLEMENTED = [
  'POST /api/v1/auth/login',
  'GET /.well-known/jwks.json',
  'POST /api/v1/usage',
  'POST /api/v1/bills/calculate',
  'GET /api/v1/bills/{subscriberNo}',
  'GET /api/v1/bills/{subscriberNo}/detailed',
  'POST /api/v1/payments',
  'GET /api/v1/health',
  'GET /api/v1/health/ready',
].sort();

const specOperations = Object.entries(doc.paths)
  .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`))
  .sort();

describe('OpenAPI spec (docs/openapi.yaml)', () => {
  it('is OpenAPI 3 and documents exactly the implemented operations', () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(specOperations).toEqual(IMPLEMENTED);
  });

  it.each(specOperations)('%s is routed by the app (never NOT_FOUND)', async (op) => {
    const [method = '', path = ''] = op.split(' ');
    const url = path.replace('{subscriberNo}', '5551000002');
    const res = await request(app)[method.toLowerCase() as 'get' | 'post'](url).send({});
    expect(res.body?.error?.code).not.toBe('NOT_FOUND');
  });
});

describe('Swagger UI', () => {
  it('GET /api/v1/docs/index.html serves the UI; /docs and /docs/ redirect there', async () => {
    for (const p of ['/api/v1/docs', '/api/v1/docs/']) {
      const r = await request(app).get(p);
      expect([r.status, r.headers.location]).toEqual([301, '/api/v1/docs/index.html']);
    }
    const res = await request(app).get('/api/v1/docs/index.html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });

  it('GET /api/v1/openapi.json serves the parsed spec', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.info.title).toBe('billwise Billing API');
  });
});
