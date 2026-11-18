import { z } from 'zod';

const httpEnvSchema = z.object({
  MCP_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  MCP_API_KEY: z.string().min(16, 'MCP_API_KEY must be at least 16 characters (see .env.example)'),
});

export type HttpConfig = z.output<typeof httpEnvSchema>;

/** Config for the Streamable HTTP server. stdio needs none (it is a local child process). */
export function loadHttpConfig(env: Record<string, string | undefined>): HttpConfig {
  const result = httpEnvSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
