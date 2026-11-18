/**
 * Streamable HTTP transport, stateless: every POST /mcp gets a fresh McpServer + transport
 * (no session ids), both closed when the response ends. They share ONE SearchEngine loaded
 * at startup. /mcp requires the X-API-Key header; GET /health is public.
 *
 *   npm start -w @billwise/mcp-server   (built)   ·   npm run dev -w @billwise/mcp-server
 */
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config as loadEnv } from 'dotenv';
import express, { type Express, type RequestHandler } from 'express';
import { loadHttpConfig } from './config';
import { loadIndexFile, type LoadedIndex } from './index-file';
import { GUIDE_PATH, INDEX_PATH } from './paths';
import { createMcpServer } from './server';

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  error: { code, message },
  id: null,
});

/** Constant-time comparison so response timing does not leak how much of the key matched. */
export function apiKeyMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireApiKey(apiKey: string): RequestHandler {
  return (req, res, next) => {
    if (!apiKeyMatches(req.get('x-api-key'), apiKey)) {
      res.status(401).json(jsonRpcError(-32001, 'Unauthorized: missing or invalid X-API-Key'));
      return;
    }
    next();
  };
}

export interface HttpAppDeps {
  loaded: LoadedIndex;
  apiKey: string;
  log?: (msg: string, err?: unknown) => void;
}

export function createHttpApp({ loaded, apiKey, log = console.error }: HttpAppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      documentId: loaded.documentId,
      indexedSections: loaded.engine.documentCount,
    });
  });

  app.post('/mcp', requireApiKey(apiKey), async (req, res) => {
    const server = createMcpServer(loaded.engine, loaded);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON responses instead of an SSE stream
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log('MCP request failed', err);
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
    }
  });

  // Stateless mode has no sessions, so no server-initiated stream (GET) or session end (DELETE).
  app.all('/mcp', requireApiKey(apiKey), (_req, res) => {
    res.status(405).set('Allow', 'POST').json(jsonRpcError(-32000, 'Method not allowed'));
  });

  return app;
}

function main(): void {
  loadEnv({ path: path.resolve(__dirname, '../../../.env'), quiet: true }); // no-op in Cloud Run
  const config = loadHttpConfig(process.env);
  const loaded = loadIndexFile(INDEX_PATH, GUIDE_PATH); // once; fails fast if missing/stale
  const app = createHttpApp({ loaded, apiKey: config.MCP_API_KEY });
  app.listen(config.MCP_PORT, () => {
    console.log(
      `mcp-server (Streamable HTTP) on http://localhost:${config.MCP_PORT}/mcp — ` +
        `${loaded.engine.documentCount} sections of ${loaded.documentId}`,
    );
  });
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
