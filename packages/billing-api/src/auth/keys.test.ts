import { generateKeyPairSync } from 'node:crypto';
import { loadKeyMaterial, normalizePem } from './keys';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('loadKeyMaterial', () => {
  it('derives the public JWK and a stable RFC 7638 kid from the private PEM', () => {
    const a = loadKeyMaterial(privateKey);
    const b = loadKeyMaterial(privateKey);
    expect(a.jwk).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', e: 'AQAB' });
    expect(a.kid).toBe(b.kid);
    expect(a.kid).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url SHA-256
  });

  it('accepts a single-line PEM with literal \\n escapes', () => {
    const oneLine = privateKey.replace(/\n/g, '\\n');
    expect(normalizePem(oneLine)).toBe(privateKey);
    expect(loadKeyMaterial(oneLine).kid).toBe(loadKeyMaterial(privateKey).kid);
  });

  it('rejects non-RSA keys and garbage', () => {
    const ec = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(() => loadKeyMaterial(ec.privateKey)).toThrow(/RSA/);
    expect(() => loadKeyMaterial('not a key')).toThrow();
  });
});
