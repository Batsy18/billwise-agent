/** zod schemas for request bodies, path params and query strings. */
import { z } from 'zod';
import { hasAtMostTwoDecimals } from '../domain/money';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export const subscriberNo = z.string().trim().min(1).max(32);
const year = z.int().min(2000).max(2100);
const month = z.int().min(1).max(12);

/** JSON body: numbers must be real numbers (no "10" strings). */
export const periodBody = z.object({ subscriberNo, year, month });

/** Query string: values arrive as strings and are coerced. */
export const periodQuery = z.object({
  year: z.coerce.number().pipe(year),
  month: z.coerce.number().pipe(month),
});

export const usageBody = periodBody.extend({ usageType: z.enum(['PHONE', 'INTERNET']) });

export const detailedQuery = periodQuery.extend({
  page: z.coerce.number().pipe(z.int().min(1)).default(1),
  pageSize: z.coerce.number().pipe(z.int().min(1).max(MAX_PAGE_SIZE)).default(DEFAULT_PAGE_SIZE),
});

export const paymentBody = periodBody.extend({
  amount: z
    .number()
    .positive()
    .max(1_000_000)
    .refine(hasAtMostTwoDecimals, { message: 'amount must have at most 2 decimals' }),
  transactionId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._:-]+$/, 'transactionId may contain letters, digits and . _ : -'),
});
