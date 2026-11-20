/**
 * Minimal MCP client over Streamable HTTP (demo / manual check):
 *   npm run call-tool -w @billwise/mcp-server -- "extra internet cost" [limit]
 * Uses MCP_URL (default http://127.0.0.1:3001/mcp) and MCP_API_KEY from the root .env.
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });

async function main(): Promise<void> {
  const [query = 'extra internet cost', limitArg] = process.argv.slice(2);
  const url = new URL(
    process.env.MCP_URL ?? `http://127.0.0.1:${process.env.MCP_PORT ?? 3001}/mcp`,
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { 'X-API-Key': process.env.MCP_API_KEY ?? '' } },
  });
  const client = new Client({ name: 'billwise-call-tool', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    for (const t of tools) {
      console.log(`tool: ${t.name}  annotations: ${JSON.stringify(t.annotations)}`);
      console.log(`description: ${t.description}\n`);
    }
    const args: Record<string, unknown> = { query };
    if (limitArg) args.limit = Number(limitArg);
    const result = await client.callTool({ name: 'search_billing_documentation', arguments: args });
    console.log(`callTool(${JSON.stringify(args)}) → structuredContent:`);
    console.log(JSON.stringify(result.structuredContent, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
