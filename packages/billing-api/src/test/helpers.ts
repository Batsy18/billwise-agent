/** Shared unit-test wiring: in-memory repositories, a throwaway RSA key and handy tokens. */
import { generateKeyPairSync } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { Express } from 'express';
import { createApp } from '../app';
import { loadKeyMaterial } from '../auth/keys';
import { signAccessToken, type JwtSettings } from '../auth/tokens';
import { calculateBill, billStatus } from '../domain/billing';
import { createMemoryRepositories, type MemoryRepositories } from '../repositories/memory';
import type { BillRecord, Role } from '../repositories/types';
import { loadOpenApi } from '../routes/docs.routes';

export const TEST_JWT: JwtSettings = {
  issuer: 'test-issuer',
  audience: 'test-api',
  ttlSeconds: 3600,
};
export const PASSWORD = 'correct-horse';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
export const TEST_PRIVATE_PEM = privateKey;
export const testKeys = loadKeyMaterial(privateKey);

const hash = bcrypt.hashSync(PASSWORD, 4); // low cost: fast tests

export const ADMIN = 'admin';
export const ALICE = '5551000001';
export const BOB = '5551000002';

export interface TestApp {
  app: Express;
  repos: MemoryRepositories;
}

export interface TestAppOptions {
  checkDatabase?: () => Promise<void>;
  /** Clock for created_at / calculated_at; defaults to a ticking clock (+1 ms per call). */
  now?: () => Date;
}

export function tickingClock(start = Date.UTC(2026, 9, 1)): () => Date {
  let t = start;
  return () => new Date(t++);
}

export function buildTestApp(opts: TestAppOptions = {}): TestApp {
  const repos = createMemoryRepositories(opts.now ?? tickingClock());
  const users: [string, string, Role][] = [
    [ADMIN, 'Billing Admin', 'ADMIN'],
    [ALICE, 'Alice', 'SUBSCRIBER'],
    [BOB, 'Bob', 'SUBSCRIBER'],
  ];
  for (const [subscriberNo, fullName, role] of users) {
    repos.subscribers.rows.set(subscriberNo, { subscriberNo, fullName, role, passwordHash: hash });
  }
  const app = createApp({
    repos,
    keys: testKeys,
    jwt: TEST_JWT,
    checkDatabase: opts.checkDatabase ?? (() => Promise.resolve()),
    openapi: loadOpenApi(),
    log: () => undefined,
  });
  return { app, repos };
}

export function tokenFor(subscriberNo: string, role: Role = 'SUBSCRIBER'): string {
  return signAccessToken(testKeys, TEST_JWT, { subscriberNo, role });
}

export const bearer = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});
export const adminAuth = (): Record<string, string> => bearer(tokenFor(ADMIN, 'ADMIN'));

/** Insert a calculated bill straight into the fake (bypassing the API). */
export function insertBill(
  repos: MemoryRepositories,
  p: {
    subscriberNo: string;
    year: number;
    month: number;
    phoneMinutes: number;
    internetMb: number;
    paidCents?: number;
  },
): BillRecord {
  const calc = calculateBill(p);
  const paidCents = p.paidCents ?? 0;
  const row: BillRecord = {
    id: `bill-${p.subscriberNo}-${p.year}-${p.month}`,
    subscriberNo: p.subscriberNo,
    year: p.year,
    month: p.month,
    phoneMinutes: p.phoneMinutes,
    internetMb: p.internetMb,
    phoneChargeCents: calc.phone.amountCents,
    internetChargeCents: calc.internet.amountCents,
    totalCents: calc.totalCents,
    paidCents,
    status: billStatus(calc.totalCents, paidCents),
    dueDate: calc.dueDate,
    calculatedAt: new Date(Date.UTC(2026, 10, 1)),
  };
  repos.bills.insert(row);
  return row;
}
