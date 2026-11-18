import { readFileSync } from 'node:fs';
import request from 'supertest';
import { chunkGuide } from './chunker';
import { loadHttpConfig } from './config';
import { apiKeyMatches, createHttpApp } from './http';
import { GUIDE_PATH } from './paths';
import { SearchEngine } from './search';

const KEY = 'test-key-0123456789abcdef';
const engine = SearchEngine.fromChunks(chunkGuide(readFileSync(GUIDE_PATH, 'utf8')).chunks);
const app = createHttpApp({
  loaded: {
    engine,
    document: 'Mobile_Provider_Billing_Guide.md',
    documentId: 'MOB-BILLING-2026-01',
  },
  apiKey: KEY,
  log: () => undefined,
});

// Streamable HTTP clients must accept both JSON and SSE.
const ACCEPT = 'application/json, text/event-stream';
const rpc = (body: object, key: string | null = KEY) => {
  const r = request(app).post('/mcp').set('Accept', ACCEPT).set('Content-Type', 'application/json');
  return (key === null ? r : r.set('X-API-Key', key)).send(body);
};
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'supertest', version: '1.0.0' },
  },
};

describe('GET /health', () => {
  it('is public and reports the loaded index', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      documentId: 'MOB-BILLING-2026-01',
      indexedSections: 25,
    });
  });
});

describe('POST /mcp (stateless Streamable HTTP)', () => {
  it.each([
    ['missing', null],
    ['wrong', 'wrong-key-0123456789abcdef'],
  ])('%s X-API-Key → 401 JSON-RPC error', async (_case, key) => {
    const res = await rpc(initialize, key);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 }, id: null });
  });

  it('initialize works with the key and creates no session', async () => {
    const res = await rpc(initialize);
    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo).toMatchObject({ name: 'billwise-mcp-server' });
    expect(res.body.result.capabilities).toHaveProperty('tools');
    expect(res.headers['mcp-session-id']).toBeUndefined();
  });

  it('tools/call works on a fresh request (no session needed)', async () => {
    const res = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search_billing_documentation', arguments: { query: 'late payment fee' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.matches[0]).toMatchObject({ section: '6.2' });
  });

  it('GET /mcp → 405 (no server-initiated streams in stateless mode)', async () => {
    const res = await request(app).get('/mcp').set('X-API-Key', KEY).set('Accept', ACCEPT);
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });
});

describe('apiKeyMatches', () => {
  it('compares exactly, rejecting different lengths and empty keys', () => {
    expect(apiKeyMatches(KEY, KEY)).toBe(true);
    expect(apiKeyMatches(`${KEY}x`, KEY)).toBe(false);
    expect(apiKeyMatches(undefined, KEY)).toBe(false);
    expect(apiKeyMatches('', KEY)).toBe(false);
  });
});

describe('loadHttpConfig', () => {
  it('defaults the port and requires a 16+ character key', () => {
    expect(loadHttpConfig({ MCP_API_KEY: KEY })).toEqual({ MCP_PORT: 3001, MCP_API_KEY: KEY });
    expect(() => loadHttpConfig({})).toThrow(/MCP_API_KEY/);
    expect(() => loadHttpConfig({ MCP_API_KEY: 'short' })).toThrow(/16 characters/);
  });
});
