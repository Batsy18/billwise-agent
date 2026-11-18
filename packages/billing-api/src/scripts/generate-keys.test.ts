import { upsertPrivateKey } from './generate-keys';

const PEM = '-----BEGIN PRIVATE KEY-----\nAAA\nBBB\n-----END PRIVATE KEY-----\n';
const LINE =
  'JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nAAA\\nBBB\\n-----END PRIVATE KEY-----"';

describe('upsertPrivateKey', () => {
  it('appends the key as one escaped line when missing', () => {
    expect(upsertPrivateKey('PORT=3000', PEM, false)).toBe(`PORT=3000\n${LINE}\n`);
  });

  it('fills an empty placeholder copied from .env.example', () => {
    expect(upsertPrivateKey('A=1\nJWT_PRIVATE_KEY=\nB=2\n', PEM, false)).toBe(
      `A=1\n${LINE}\nB=2\n`,
    );
  });

  it('refuses to overwrite an existing key without --force', () => {
    expect(() => upsertPrivateKey('JWT_PRIVATE_KEY="old"\n', PEM, false)).toThrow(/--force/);
  });

  it('replaces an existing key with --force', () => {
    expect(upsertPrivateKey('JWT_PRIVATE_KEY="old"\nX=1\n', PEM, true)).toBe(`${LINE}\nX=1\n`);
  });
});
