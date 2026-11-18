import { createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { signAccessToken } from '../auth/tokens';
import {
  ADMIN,
  ALICE,
  bearer,
  buildTestApp,
  PASSWORD,
  TEST_JWT,
  testKeys,
  tokenFor,
} from '../test/helpers';

const { app } = buildTestApp();
// Any route behind requireAuth works for probing the middleware; detailed is self-or-admin.
const PROTECTED = `/api/v1/bills/${ALICE}/detailed?year=2026&month=10`;

describe('POST /api/v1/auth/login', () => {
  it('returns an RS256 JWT with iss, aud, sub, role, exp (1h)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ subscriberNo: ALICE, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 3600 });

    const decoded = jwt.decode(res.body.accessToken as string, { complete: true });
    expect(decoded?.header).toMatchObject({ alg: 'RS256', kid: testKeys.kid });
    const claims = decoded?.payload as jwt.JwtPayload;
    expect(claims).toMatchObject({
      iss: TEST_JWT.issuer,
      aud: TEST_JWT.audience,
      sub: ALICE,
      role: 'SUBSCRIBER',
    });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(3600);
  });

  it('issues the ADMIN role to the admin account', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ subscriberNo: ADMIN, password: PASSWORD });
    expect((jwt.decode(res.body.accessToken as string) as jwt.JwtPayload).role).toBe('ADMIN');
  });

  it.each([
    ['wrong password', { subscriberNo: ALICE, password: 'nope' }],
    ['unknown subscriber', { subscriberNo: '5559999999', password: PASSWORD }],
  ])('%s → 401 with the same message', async (_case, body) => {
    const res = await request(app).post('/api/v1/auth/login').send(body);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Invalid subscriber number or password',
    });
  });

  it.each([
    ['missing password', { subscriberNo: ALICE }],
    ['missing subscriberNo', { password: PASSWORD }],
    ['empty body', {}],
  ])('%s → 400 VALIDATION_ERROR', async (_case, body) => {
    const res = await request(app).post('/api/v1/auth/login').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /.well-known/jwks.json', () => {
  it('publishes the public key; a login token verifies with it', async () => {
    const res = await request(app).get('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    const [jwk] = res.body.keys as Record<string, string>[];
    expect(jwk).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: testKeys.kid });
    expect(jwk).not.toHaveProperty('d'); // never the private exponent

    const publicKey = createPublicKey({ key: jwk as never, format: 'jwk' });
    const payload = jwt.verify(tokenFor(ALICE), publicKey, { algorithms: ['RS256'] });
    expect((payload as jwt.JwtPayload).sub).toBe(ALICE);
  });
});

describe('requireAuth middleware', () => {
  it('no token → 401', async () => {
    const res = await request(app).get(PROTECTED);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it.each([
    ['garbage token', 'Bearer not.a.jwt'],
    ['wrong scheme', `Basic ${tokenFor(ALICE)}`],
  ])('%s → 401', async (_case, header) => {
    const res = await request(app).get(PROTECTED).set('Authorization', header);
    expect(res.status).toBe(401);
  });

  it('expired token → 401', async () => {
    const expired = signAccessToken(
      testKeys,
      { ...TEST_JWT, ttlSeconds: -10 },
      {
        subscriberNo: ALICE,
        role: 'SUBSCRIBER',
      },
    );
    expect((await request(app).get(PROTECTED).set(bearer(expired))).status).toBe(401);
  });

  it.each([
    ['wrong issuer', { ...TEST_JWT, issuer: 'evil' }],
    ['wrong audience', { ...TEST_JWT, audience: 'other-api' }],
  ])('%s → 401', async (_case, settings) => {
    const token = signAccessToken(testKeys, settings, { subscriberNo: ALICE, role: 'SUBSCRIBER' });
    expect((await request(app).get(PROTECTED).set(bearer(token))).status).toBe(401);
  });

  it('HS256 token forged with the public key as secret → 401 (algorithm confusion)', async () => {
    const publicPem = testKeys.publicKey.export({ type: 'spki', format: 'pem' });
    const forged = jwt.sign({ role: 'ADMIN' }, publicPem, {
      algorithm: 'HS256',
      issuer: TEST_JWT.issuer,
      audience: TEST_JWT.audience,
      subject: ADMIN,
    });
    expect((await request(app).get(PROTECTED).set(bearer(forged))).status).toBe(401);
  });

  it('X-Forwarded-Authorization (from GCP API Gateway) wins over Authorization', async () => {
    const res = await request(app)
      .get(PROTECTED)
      .set('X-Forwarded-Authorization', `Bearer ${tokenFor(ALICE)}`)
      .set('Authorization', 'Bearer google-identity-token-for-cloud-run');
    expect(res.status).toBe(404); // authenticated; the bill just does not exist
    expect(res.body.error.code).toBe('BILL_NOT_FOUND');
  });
});

describe('health', () => {
  it('GET /api/v1/health is public and does not touch the DB', async () => {
    const down = buildTestApp({ checkDatabase: () => Promise.reject(new Error('db down')) });
    const res = await request(down.app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /api/v1/health/ready → 200 when the DB answers', async () => {
    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', database: 'up' });
  });

  it('GET /api/v1/health/ready → 503 SERVICE_UNAVAILABLE when the DB is down', async () => {
    const down = buildTestApp({ checkDatabase: () => Promise.reject(new Error('db down')) });
    const res = await request(down.app).get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('shared error format', () => {
  it('unknown route → 404 NOT_FOUND with traceId (also in X-Trace-Id)', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      code: 'NOT_FOUND',
      message: 'No route for GET /api/v1/nope',
      traceId: res.headers['x-trace-id'],
    });
  });

  it('reuses the GCP trace id from X-Cloud-Trace-Context', async () => {
    const trace = '0123456789abcdef0123456789abcdef';
    const res = await request(app)
      .get('/api/v1/nope')
      .set('X-Cloud-Trace-Context', `${trace}/1;o=1`);
    expect(res.body.error.traceId).toBe(trace);
  });

  it('malformed JSON → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"subscriberNo": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Malformed JSON body',
    });
  });
});
