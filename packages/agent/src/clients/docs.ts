/**
 * MCP client for the documentation tool. The tool is DISCOVERED with listTools() and handed
 * to the LLM as-is (name, description incl. the generated topic list, inputSchema) — it is
 * never re-declared here. Streamable HTTP with X-API-Key; stdio (spawning the built
 * mcp-server) is the fallback when the HTTP endpoint is unreachable.
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDeclaration } from '../llm/types';

export const DOCS_TOOL = 'search_billing_documentation';

export interface DocsClient {
  readonly tool: ToolDeclaration;
  readonly transport: 'http' | 'stdio' | 'fake';
  /** Returns the tool's structuredContent (or the parsed JSON text). */
  call(args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Minimal surface of the SDK Client we use (lets tests pass a linked in-memory client). */
export interface McpClientLike {
  listTools(): Promise<{
    tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[];
  }>;
  /** The SDK's return type is a union (incl. a legacy shape); we read the fields loosely. */
  callTool(req: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function docsClientFrom(
  client: McpClientLike,
  transport: DocsClient['transport'],
): Promise<DocsClient> {
  const { tools } = await client.listTools();
  const t = tools.find((x) => x.name === DOCS_TOOL);
  if (!t) throw new Error(`MCP server does not offer ${DOCS_TOOL}`);
  const tool: ToolDeclaration = {
    name: t.name,
    description: t.description ?? '',
    parameters: t.inputSchema,
  };
  return {
    tool,
    transport,
    async call(args) {
      const r = await client.callTool({ name: DOCS_TOOL, arguments: args });
      if (r.isError === true) {
        return {
          status: 'tool_error',
          message: textOf(r.content) || 'The documentation tool rejected the request.',
        };
      }
      return (r.structuredContent ?? JSON.parse(textOf(r.content) || '{}')) as unknown;
    },
    close: () => client.close(),
  };
}

function textOf(content: unknown): string {
  const first = Array.isArray(content)
    ? (content[0] as { type?: string; text?: string })
    : undefined;
  return first?.type === 'text' ? (first.text ?? '') : '';
}

export interface ConnectDocsOptions {
  url: string;
  apiKey?: string;
  /** Path of the built mcp-server stdio entry; used if HTTP fails. */
  stdioEntry?: string;
  log?: (msg: string) => void;
}

export const DEFAULT_STDIO_ENTRY = path.resolve(__dirname, '../../../mcp-server/dist/stdio.js');

export async function connectDocs(opts: ConnectDocsOptions): Promise<DocsClient> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const info = { name: 'billwise-agent', version: '1.0.0' };
  if (opts.apiKey) {
    const client = new Client(info);
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(opts.url), {
          requestInit: { headers: { 'X-API-Key': opts.apiKey } },
        }),
      );
      return await docsClientFrom(client, 'http');
    } catch (err) {
      await client.close().catch(() => undefined);
      log(`MCP over HTTP (${opts.url}) failed: ${(err as Error).message} — falling back to stdio.`);
    }
  }
  const client = new Client(info);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [opts.stdioEntry ?? DEFAULT_STDIO_ENTRY],
      stderr: 'ignore',
    }),
  );
  return docsClientFrom(client, 'stdio');
}
