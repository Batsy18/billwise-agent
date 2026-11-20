import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

export const ROOT = path.resolve(__dirname, '../../..');
export const ROOT_ENV = path.join(ROOT, '.env');
export const CLOUD_ENV = path.join(ROOT, '.env.cloud');

/** "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" (thinkingLevel, Gemini 3.x) or an integer (thinkingBudget, 2.x). */
const thinking = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (/^-?\d+$/.test(v)) return Number(v);
    const level = v.toUpperCase();
    if (['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(level)) return level;
    ctx.addIssue({
      code: 'custom',
      message: 'use MINIMAL, LOW, MEDIUM, HIGH or an integer token budget',
    });
    return z.NEVER;
  });

const schema = z
  .object({
    BILLING_API_URL: z.url().default('http://127.0.0.1:3000'),
    MCP_URL: z.url().default('http://127.0.0.1:3001/mcp'),
    MCP_API_KEY: z.string().optional(),
    LLM_PROVIDER: z.enum(['gemini', 'mock']).default('gemini'),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
    GEMINI_THINKING_BUDGET: thinking.default('MINIMAL'),
    // Demo only (see setup.createLlm). Free tier of gemini-3.5-flash-lite: 15 RPM → 4.1 s.
    LLM_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(4_100),
    // Per Gemini request; on expiry the request is aborted and retried once (like a 503).
    GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(20_000),
  })
  .superRefine((c, ctx) => {
    if (c.LLM_PROVIDER === 'gemini' && !c.GEMINI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEMINI_API_KEY'],
        message:
          'required when LLM_PROVIDER=gemini (get one in Google AI Studio, or set LLM_PROVIDER=mock)',
      });
    }
  });

export type AgentConfig = z.output<typeof schema>;

export function loadAgentConfig(env: Record<string, string | undefined>): AgentConfig {
  const r = schema.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return r.data;
}

/**
 * Which env files to load, most specific first. `--cloud` (or ENV_FILE=<path>, relative to the
 * repo root) puts an overlay such as .env.cloud in front of .env: dotenv never overrides a value
 * that is already set, so the overlay wins and .env still supplies the rest (GEMINI_API_KEY …).
 */
export function envFiles(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): { files: string[]; overlay?: string } {
  const overlay = argv.includes('--cloud')
    ? CLOUD_ENV
    : env.ENV_FILE
      ? path.resolve(ROOT, env.ENV_FILE)
      : undefined;
  return overlay ? { files: [overlay, ROOT_ENV], overlay } : { files: [ROOT_ENV] };
}

/** Loads the env files; returns the overlay's name (e.g. ".env.cloud") when one was used. */
export function loadEnvFile(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const { files, overlay } = envFiles(argv, env);
  if (overlay && !existsSync(overlay)) {
    throw new Error(
      `${path.relative(ROOT, overlay)} not found — copy .env.cloud.example and fill it in (see infra/README.md).`,
    );
  }
  for (const file of files) loadEnv({ path: file, quiet: true });
  return overlay && path.relative(ROOT, overlay);
}

export const QUOTA_HINT =
  'Free tier of gemini-3.5-flash-lite: 500 requests/day, reset at midnight Pacific time. Wait for the reset or enable billing on the Google AI Studio project.';
