/**
 * Local/demo seed. Wipes the 4 tables and inserts the plan from seed-data.ts.
 * Run: `npm run db:seed -w @billwise/billing-api` (or automatically after `prisma migrate reset`).
 * Refuses to run with NODE_ENV=production unless `--force` is passed
 * (`npx prisma db seed -- --force`).
 */
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import { config as loadEnv } from 'dotenv';
import { centsToDecimalString } from '../domain/money';
import { PrismaClient } from '../generated/prisma/client';
import { buildSeedPlan, type SeedUsageBatch } from './seed-data';
import { assertSeedAllowed } from './seed-guard';

const BCRYPT_ROUNDS = 10;
const EVENT_CHUNK = 5_000; // rows per INSERT; stays well under Postgres' 65,535 bind parameters

loadEnv({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

async function insertUsage(prisma: PrismaClient, batch: SeedUsageBatch): Promise<void> {
  const { count, ...row } = batch;
  for (let done = 0; done < count; done += EVENT_CHUNK) {
    const n = Math.min(EVENT_CHUNK, count - done);
    await prisma.usageEvent.createMany({ data: Array.from({ length: n }, () => row) });
  }
}

async function main(): Promise<void> {
  assertSeedAllowed(process.env, process.argv.slice(2));

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: requireEnv('DATABASE_URL') }),
  });
  const plan = buildSeedPlan();

  try {
    const [adminHash, userHash] = await Promise.all([
      bcrypt.hash(requireEnv('SEED_ADMIN_PASSWORD'), BCRYPT_ROUNDS),
      bcrypt.hash(requireEnv('SEED_USER_PASSWORD'), BCRYPT_ROUNDS),
    ]);

    // Children first (FKs are ON DELETE RESTRICT).
    await prisma.$transaction([
      prisma.payment.deleteMany(),
      prisma.bill.deleteMany(),
      prisma.usageEvent.deleteMany(),
      prisma.subscriber.deleteMany(),
    ]);

    await prisma.subscriber.createMany({
      data: plan.subscribers.map((s) => ({
        ...s,
        passwordHash: s.role === 'ADMIN' ? adminHash : userHash,
      })),
    });

    for (const batch of plan.usage) await insertUsage(prisma, batch);

    for (const b of plan.bills) {
      await prisma.bill.create({
        data: {
          subscriberNo: b.subscriberNo,
          year: b.year,
          month: b.month,
          phoneMinutes: b.phoneMinutes,
          internetMb: b.internetMb,
          phoneCharge: centsToDecimalString(b.calc.phone.amountCents),
          internetCharge: centsToDecimalString(b.calc.internet.amountCents),
          total: centsToDecimalString(b.calc.totalCents),
          paidAmount: centsToDecimalString(b.paidCents),
          status: b.status,
          dueDate: b.calc.dueDate,
          payments: {
            create: b.payments.map((p) => ({
              transactionId: p.transactionId,
              amount: centsToDecimalString(p.amountCents),
            })),
          },
        },
      });
    }

    const events = plan.usage.reduce((sum, u) => sum + u.count, 0);
    const payments = plan.bills.reduce((sum, b) => sum + b.payments.length, 0);
    console.log(
      `Seeded ${plan.subscribers.length} subscribers, ${events} usage events, ` +
        `${plan.bills.length} bills, ${payments} payments.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
