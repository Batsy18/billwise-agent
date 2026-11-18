import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_PRIVATE_KEY: z
    .string()
    .min(1, 'JWT_PRIVATE_KEY is required — run `npm run keys:generate -w @billwise/billing-api`'),
  JWT_ISSUER: z.string().min(1).default('billwise-billing-api'),
  JWT_AUDIENCE: z.string().min(1).default('billwise-api'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
});

export type Config = z.output<typeof envSchema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
