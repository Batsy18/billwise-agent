import { buildSeedPlan, SEED_PERIODS, type SeedBill } from './seed-data';

const plan = buildSeedPlan();

function bill(subscriberNo: string, year: number, month: number): SeedBill | undefined {
  return plan.bills.find(
    (b) => b.subscriberNo === subscriberNo && b.year === year && b.month === month,
  );
}

describe('seed plan', () => {
  it('has the admin and the three demo subscribers', () => {
    expect(plan.subscribers.map((s) => [s.subscriberNo, s.role])).toEqual([
      ['admin', 'ADMIN'],
      ['5551000001', 'SUBSCRIBER'],
      ['5551000002', 'SUBSCRIBER'],
      ['5551000003', 'SUBSCRIBER'],
    ]);
  });

  it('5551000002 Oct 2026 is the guide worked example: $80, unpaid', () => {
    const b = bill('5551000002', 2026, 10);
    expect(b?.calc.totalCents).toBe(8000);
    expect(b?.status).toBe('UNPAID');
  });

  it.each([
    ['5551000001', 9, 5000, 'PAID'],
    ['5551000001', 10, 5000, 'UNPAID'],
    ['5551000003', 10, 7000, 'PARTIALLY_PAID'],
  ])('%s 2026-%i → total %i cents, %s', (no, month, total, status) => {
    const b = bill(no, 2026, month);
    expect(b?.calc.totalCents).toBe(total);
    expect(b?.status).toBe(status);
  });

  it('5551000002 Nov 2026 has usage but no bill yet', () => {
    expect(bill('5551000002', 2026, 11)).toBeUndefined();
    expect(plan.usage.some((u) => u.subscriberNo === '5551000002' && u.month === 11)).toBe(true);
  });

  it('paid_amount of every bill equals the sum of its payment rows', () => {
    for (const b of plan.bills) {
      const sum = b.payments.reduce((acc, p) => acc + p.amountCents, 0);
      expect(b.paidCents).toBe(sum);
    }
    expect(bill('5551000001', 2026, 9)?.paidCents).toBe(5000);
    expect(bill('5551000003', 2026, 10)?.paidCents).toBe(3000);
  });

  it('payment transaction ids are unique and prefixed "seed-"', () => {
    const ids = plan.bills.flatMap((b) => b.payments.map((p) => p.transactionId));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^seed-/);
  });

  it('usage events add up to the planned minutes and MB (10 min / 1 MB per event)', () => {
    for (const p of SEED_PERIODS) {
      const mine = plan.usage.filter(
        (u) => u.subscriberNo === p.subscriberNo && u.year === p.year && u.month === p.month,
      );
      const total = (type: string) =>
        mine.filter((u) => u.usageType === type).reduce((s, u) => s + u.amount * u.count, 0);
      expect(total('PHONE')).toBe(p.phoneMinutes);
      expect(total('INTERNET')).toBe(p.internetMb);
    }
    const internet2 = plan.usage.find(
      (u) => u.subscriberNo === '5551000002' && u.month === 10 && u.usageType === 'INTERNET',
    );
    expect(internet2?.count).toBe(35_000); // 35 GB = 35,000 one-MB events
  });

  it('rejects minutes that Add Usage could never produce', () => {
    const bad = [{ ...SEED_PERIODS[0]!, phoneMinutes: 1_001 }];
    expect(() => buildSeedPlan(bad)).toThrow(RangeError);
  });

  it('rejects payments that exceed the bill total', () => {
    const bad = [
      {
        ...SEED_PERIODS[1]!,
        payments: [{ transactionId: 'seed-x', amountCents: 5001 }],
      },
    ];
    expect(() => buildSeedPlan(bad)).toThrow(/exceed/);
  });
});
