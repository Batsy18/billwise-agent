/**
 * The MCP server: one read-only tool, search_billing_documentation (vault note "MCP ve Agent").
 * Transport-agnostic — stdio.ts and http.ts connect it to a transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SearchEngine } from './search';

export const TOOL_NAME = 'search_billing_documentation';
export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 5;
export const NO_MATCH_MESSAGE =
  'No relevant section found in the billing guide. Do not answer from general knowledge; retry once with different keywords or tell the user the guide does not cover it.';

const BASE_DESCRIPTION =
  "Search the Mobile Provider Billing Guide for billing policies, pricing rules, payment, late payment and dispute rules. Query in English. Does NOT contain any subscriber's live usage or bill data. Use the guide's terms; if matches is empty, retry once with different keywords.";

export interface DocumentInfo {
  document: string;
  documentId: string;
}

/**
 * "Topics covered: …" built from the indexed headings at startup, grouped by top-level
 * section, so the LLM can map its own wording onto the guide's (complain → "Billing disputes").
 */
export function topicsLine(engine: SearchEngine): string {
  const groups: string[] = [];
  let parent = '';
  let children: string[] = [];
  const flush = () => {
    if (parent) groups.push(children.length ? `${parent} (${children.join(', ')})` : parent);
  };
  for (const t of engine.topics) {
    if (t.section === 'preamble') continue; // the document title is already in the description
    const top = t.parentHeading || `${t.section}. ${t.heading}`;
    if (top !== parent) {
      flush();
      parent = top;
      children = [];
    }
    if (t.parentHeading) children.push(`${t.section} ${t.heading}`);
  }
  flush();
  return `Topics covered: ${groups.join('; ')}.`;
}

export function toolDescription(engine: SearchEngine): string {
  return `${BASE_DESCRIPTION} ${topicsLine(engine)}`;
}

const matchShape = z.object({
  section: z.string().describe('Section id in the guide, e.g. "3.2"'),
  heading: z.string(),
  text: z.string(),
  score: z.number().describe('Relevance score (higher is better)'),
});

export const outputShape = {
  document: z.string(),
  documentId: z.string(),
  matches: z.array(matchShape),
  message: z.string().optional().describe('Present when matches is empty'),
};

export type SearchOutput = z.infer<z.ZodObject<typeof outputShape>>;

export function runSearch(
  engine: SearchEngine,
  doc: DocumentInfo,
  query: string,
  limit: number,
): SearchOutput {
  const { hits } = engine.search(query, limit);
  const out: SearchOutput = {
    document: doc.document,
    documentId: doc.documentId,
    matches: hits.map((h) => ({
      section: h.section,
      heading: h.heading,
      text: h.text,
      score: Math.round(h.score * 100) / 100,
    })),
  };
  if (out.matches.length === 0) out.message = NO_MATCH_MESSAGE;
  return out;
}

export function createMcpServer(engine: SearchEngine, doc: DocumentInfo): McpServer {
  const server = new McpServer({ name: 'billwise-mcp-server', version: '1.0.0' });
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Search billing documentation',
      description: toolDescription(engine),
      inputSchema: {
        query: z.string().trim().min(2).max(500).describe('Search terms in English'),
        limit: z.int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe('Max sections'),
      },
      outputSchema: outputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query, limit }) => {
      const out = runSearch(engine, doc, query, limit);
      return {
        content: [{ type: 'text', text: JSON.stringify(out) }],
        structuredContent: out,
      };
    },
  );
  return server;
}
