import { AppError } from '../http/errors';
import type {
  Period,
  SubscriberRepository,
  UsageRepository,
  UsageType,
} from '../repositories/types';

// Guide 2.3 / 3.3: every Add Usage call records a fixed amount; there is no amount parameter.
export const USAGE_UNITS = {
  PHONE: { amount: 10, unit: 'MIN' },
  INTERNET: { amount: 1, unit: 'MB' },
} as const;

/** Only SUBSCRIBER accounts are billable; `admin` and unknown numbers are "not found". */
export async function assertBillableSubscriber(
  subscribers: SubscriberRepository,
  subscriberNo: string,
): Promise<void> {
  const s = await subscribers.findByNo(subscriberNo);
  if (!s || s.role !== 'SUBSCRIBER') {
    throw new AppError('SUBSCRIBER_NOT_FOUND', `Subscriber ${subscriberNo} not found`);
  }
}

export class UsageService {
  constructor(
    private readonly subscribers: SubscriberRepository,
    private readonly usage: UsageRepository,
  ) {}

  async add(period: Period, usageType: UsageType) {
    await assertBillableSubscriber(this.subscribers, period.subscriberNo);
    const { amount, unit } = USAGE_UNITS[usageType];
    await this.usage.add(period, usageType, amount);
    return { status: 'SUCCESS' as const, recorded: { type: usageType, amount, unit } };
  }
}
