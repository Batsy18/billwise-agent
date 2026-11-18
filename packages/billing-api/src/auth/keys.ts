/**
 * RS256 key material. Only the private key is configured (JWT_PRIVATE_KEY, PEM); the public
 * key, the JWK published at /.well-known/jwks.json and its `kid` are all derived from it.
 */
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

export interface PublicJwk {
  kty: 'RSA';
  n: string;
  e: string;
  kid: string;
  alg: 'RS256';
  use: 'sig';
}

export interface KeyMaterial {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
  jwk: PublicJwk;
}

/** Accepts a PEM with real newlines or with literal "\n" escapes (single-line env values). */
export function normalizePem(pem: string): string {
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}

export function loadKeyMaterial(privateKeyPem: string): KeyMaterial {
  const privateKey = createPrivateKey(normalizePem(privateKeyPem).trim());
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error('JWT_PRIVATE_KEY must be an RSA private key (RS256)');
  }
  const publicKey = createPublicKey(privateKey);
  const { n, e } = publicKey.export({ format: 'jwk' });
  if (!n || !e) throw new Error('could not export RSA public key as JWK');
  const kid = jwkThumbprint(n, e);
  return { privateKey, publicKey, kid, jwk: { kty: 'RSA', n, e, kid, alg: 'RS256', use: 'sig' } };
}

/** RFC 7638 thumbprint: SHA-256 over the required members in lexicographic order, base64url. */
function jwkThumbprint(n: string, e: string): string {
  const canonical = JSON.stringify({ e, kty: 'RSA', n });
  return createHash('sha256').update(canonical).digest('base64url');
}
