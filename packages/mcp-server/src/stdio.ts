/**
 * stdio transport for local MCP clients (MCP Inspector, Claude Desktop, the agent in dev).
 * stdout carries the protocol, so every log line goes to stderr.
 *
 *   npm run start:stdio -w @billwise/mcp-server
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadIndexFile } from './index-file';
import { GUIDE_PATH, INDEX_PATH } from './paths';
import { createMcpServer } from './server';

async function main(): Promise<void> {
  const loaded = loadIndexFile(INDEX_PATH, GUIDE_PATH); // once; fails fast if missing/stale
  await createMcpServer(loaded.engine, loaded).connect(new StdioServerTransport());
  console.error(
    `mcp-server (stdio) ready — ${loaded.engine.documentCount} sections of ${loaded.documentId}`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
