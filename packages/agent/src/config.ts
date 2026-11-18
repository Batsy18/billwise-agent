import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

export const ROOT_ENV = path.resolve(__dirname, '../../../.env');

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
    BILLING_API_URL: z.url().default('http://localhost:3000'),
    MCP_URL: z.url().default('http://localhost:3001/mcp'),
    MCP_API_KEY: z.string().optional(),
    LLM_PROVIDER: z.enum(['gemini', 'mock']).default('gemini'),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
    GEMINI_THINKING_BUDGET: thinking.default('MINIMAL'),
    // Demo only (see setup.createLlm). Free tier of gemini-3.5-flash-lite: 15 RPM → 4.1 s.
    LLM_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(4_100),
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

export function loadEnvFile(): void {
  loadEnv({ path: ROOT_ENV, quiet: true });
}

export const QUOTA_HINT =
  'Free tier of gemini-3.5-flash-lite: 500 requests/day, reset at midnight Pacific time. Wait for the reset or enable billing on the Google AI Studio project.';
