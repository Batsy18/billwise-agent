import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chunkGuide } from './chunker';
import { GUIDE_PATH } from './paths';
import { SearchEngine } from './search';
import {
  createMcpServer,
  NO_MATCH_MESSAGE,
  TOOL_NAME,
  toolDescription,
  type SearchOutput,
} from './server';

const engine = SearchEngine.fromChunks(chunkGuide(readFileSync(GUIDE_PATH, 'utf8')).chunks);
const doc = { document: 'Mobile_Provider_Billing_Guide.md', documentId: 'MOB-BILLING-2026-01' };

let client: Client;

beforeAll(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(engine, doc).connect(serverSide);
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
});

const textOf = (r: Awaited<ReturnType<Client['callTool']>>): string => {
  const first = (r.content as { type: string; text?: string }[])[0];
  return first?.type === 'text' ? (first.text ?? '') : '';
};

describe('tool description', () => {
  const description = toolDescription(engine);

  it('lists every indexed heading (and every parent heading) as a topic', () => {
    for (const t of engine.topics) {
      expect(description).toContain(t.heading);
      if (t.parentHeading) expect(description).toContain(t.parentHeading);
    }
    expect(description).toContain('7. Billing disputes (7.1 Dispute window');
    expect(description).not.toContain('Guidance for AI/MCP implementation'); // section 9 not indexed
  });

  it('tells the LLM to use the guide terms and retry once on empty matches', () => {
    expect(description).toContain(
      "Use the guide's terms; if matches is empty, retry once with different keywords.",
    );
  });
});

describe('MCP round trip (in-memory transport)', () => {
  it('lists the tool with input schema, output schema and annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([TOOL_NAME]);
    const tool = tools[0]!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 2 },
        limit: { type: 'integer', minimum: 1, maximum: 5, default: 5 },
      },
    });
    expect(tool.outputSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['document', 'documentId', 'matches']),
    });
  });

  it('call returns the section-9 shape as structuredContent and identical JSON text', async () => {
    const r = await client.callTool({
      name: TOOL_NAME,
      arguments: { query: 'extra internet cost' },
    });
    const out = r.structuredContent as SearchOutput;
    expect(out).toMatchObject({ document: doc.document, documentId: doc.documentId });
    expect(out.matches[0]).toEqual({
      section: '8.1',
      heading: 'What is the cost of extra internet?',
      text: expect.stringContaining('Each additional 10 GB block beyond 20 GB costs $10.'),
      score: expect.any(Number),
    });
    expect(out.matches.map((m) => m.section)).toContain('3.2');
    expect(out.matches.length).toBeLessThanOrEqual(5); // default limit 5
    expect(JSON.parse(textOf(r))).toEqual(out);
    expect(out.matches[0]!.score).toBe(Math.round(out.matches[0]!.score * 100) / 100);
  });

  it('honours limit', async () => {
    const r = await client.callTool({ name: TOOL_NAME, arguments: { query: 'payment', limit: 1 } });
    expect((r.structuredContent as SearchOutput).matches).toHaveLength(1);
  });

  it('irrelevant query → empty matches with a "no relevant section" message', async () => {
    const r = await client.callTool({
      name: TOOL_NAME,
      arguments: { query: 'recipe for lasagna' },
    });
    expect(r.structuredContent).toEqual({ ...doc, matches: [], message: NO_MATCH_MESSAGE });
    expect(r.isError).toBeFalsy();
  });

  it.each([
    ['limit above 5', { query: 'bill', limit: 6 }],
    ['query too short', { query: 'a' }],
    ['missing query', {}],
  ])('%s → tool error, no result', async (_case, args) => {
    const r = await client.callTool({ name: TOOL_NAME, arguments: args });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });
});
