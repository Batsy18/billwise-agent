/**
 * infra/gateway/openapi-gateway.tmpl.yaml (GCP API Gateway, OpenAPI 2.0) must route every
 * implemented operation, require a JWT on exactly the protected ones, and route all Swagger UI
 * paths. A route added to the API without the gateway would be unreachable in the cloud.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { parse as parseYaml } from 'yaml';
import { buildTestApp } from '../test/helpers';

interface Op {
  security?: Record<string, unknown>[];
  parameters?: { name: string; in: string }[];
}
interface GatewayDoc {
  swagger: string;
  'x-google-backend': Record<string, unknown>;
  securityDefinitions: Record<string, Record<string, string>>;
  paths: Record<string, Record<string, Op>>;
}

const TEMPLATE = path.resolve(__dirname, '../../../../infra/gateway/openapi-gateway.tmpl.yaml');
const doc = parseYaml(readFileSync(TEMPLATE, 'utf8')) as GatewayDoc;

const ops = Object.entries(doc.paths).flatMap(([p, byMethod]) =>
  Object.entries(byMethod).map(([m, op]) => ({ key: `${m.toUpperCase()} ${p}`, op })),
);
const keys = ops.map((o) => o.key).sort();
const jwtKeys = ops
  .filter((o) => o.op.security?.some((s) => 'billwise_jwt' in s))
  .map((o) => o.key)
  .sort();

describe('API Gateway config (infra/gateway/openapi-gateway.tmpl.yaml)', () => {
  it('is OpenAPI 2.0 with a Cloud Run backend that appends the path and sets jwt_audience', () => {
    expect(doc.swagger).toBe('2.0');
    expect(doc['x-google-backend']).toMatchObject({
      address: '__BACKEND_URL__',
      path_translation: 'APPEND_PATH_TO_ADDRESS',
      jwt_audience: '__BACKEND_URL__',
    });
  });

  it('validates JWTs with our issuer/audience and the JWKS served THROUGH the gateway', () => {
    expect(doc.securityDefinitions.billwise_jwt).toMatchObject({
      'x-google-issuer': '__JWT_ISSUER__',
      'x-google-audiences': '__JWT_AUDIENCE__',
      'x-google-jwks_uri': 'https://__GATEWAY_HOST__/.well-known/jwks.json',
    });
  });

  it('routes exactly the API operations plus the Swagger UI paths', () => {
    expect(keys).toEqual(
      [
        'POST /api/v1/auth/login',
        'GET /api/v1/bills/{subscriberNo}',
        'GET /api/v1/health',
        'GET /api/v1/health/ready',
        'GET /.well-known/jwks.json',
        'GET /api/v1/docs',
        'GET /api/v1/docs/{asset}',
        'GET /api/v1/openapi.json',
        'GET /api/v1/bills/{subscriberNo}/detailed',
        'POST /api/v1/payments',
        'POST /api/v1/usage',
        'POST /api/v1/bills/calculate',
      ].sort(),
    );
  });

  it('requires a JWT on exactly detailed, payments, usage and calculate', () => {
    expect(jwtKeys).toEqual(
      [
        'GET /api/v1/bills/{subscriberNo}/detailed',
        'POST /api/v1/payments',
        'POST /api/v1/usage',
        'POST /api/v1/bills/calculate',
      ].sort(),
    );
  });

  it('has no trailing-slash path templates (API Gateway rejects them)', () => {
    expect(Object.keys(doc.paths).filter((p) => p.length > 1 && p.endsWith('/'))).toEqual([]);
  });

  it('declares every path template parameter (API Gateway rejects the config otherwise)', () => {
    for (const { key, op } of ops) {
      for (const [, name] of key.matchAll(/\{(\w+)\}/g)) {
        expect(op.parameters?.some((p) => p.in === 'path' && p.name === name)).toBe(true);
      }
    }
  });

  it('the Swagger UI paths really serve the UI (index, assets, redirect)', async () => {
    const { app } = buildTestApp();
    const index = await request(app).get('/api/v1/docs/index.html');
    expect(index.status).toBe(200);
    const assets = [...index.text.matchAll(/(?:src|href)="\.\/([\w.-]+)"/g)].map((m) => m[1]!);
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      // every asset is ONE path segment → covered by /api/v1/docs/{asset}
      expect((await request(app).get(`/api/v1/docs/${asset}`)).status).toBe(200);
    }
    const redirect = await request(app).get('/api/v1/docs');
    expect(redirect.status).toBe(301);
    expect(redirect.headers.location).toBe('/api/v1/docs/index.html');
    expect(index.text).toContain('swagger-ui'); // our page, not swagger-ui-dist's petstore index
    expect(index.text).not.toContain('petstore');
  });
});
