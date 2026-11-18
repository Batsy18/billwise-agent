/** Test doubles: fake billing API (at the fetch level), fake MCP docs client, wiring helper. */
import { Agent } from '../agent';
import { BillingClient, type FetchFn, type Session } from '../clients/billing';
import type { DocsClient } from '../clients/docs';
import { MockProvider, type ScriptedTurn } from '../llm/mock';
import type { ToolDeclaration } from '../llm/types';
import { buildSystemPrompt } from '../prompt';
import { ToolExecutor } from '../tools/executor';
import type { PaymentSummary } from '../tools/payment-gate';
import { Trace } from '../trace';

export const ME = '5551000002';
export const OTHER = '5551000003';

export interface RecordedRequest {
  method: string;
  url: URL;
  body: Record<string, unknown> | undefined;
  authorization: string | undefined;
}

export type Route = (req: RecordedRequest) => { status: number; body?: unknown } | 'network-error';

/** Fake billing API: routes are tried in order; first one returning a value wins. */
export class FakeBillingApi {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: { method: string; path: RegExp; handler: Route }[] = [];

  on(method: string, path: RegExp, handler: Route): this {
    this.routes.push({ method, path, handler });
    return this;
  }

  readonly fetch: FetchFn = (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const req: RecordedRequest = {
      method: init?.method ?? 'GET',
      url: new URL(input),
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
      authorization: headers.Authorization,
    };
    this.requests.push(req);
    const route = this.routes.find((r) => r.method === req.method && r.path.test(req.url.pathname));
    if (!route)
      return Promise.resolve(json(404, { error: { code: 'NOT_FOUND', message: 'no route' } }));
    const out = route.handler(req);
    if (out === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(json(out.status, out.body ?? {}));
  };

  paths(): string[] {
    return this.requests.map((r) => `${r.method} ${r.url.pathname}${r.url.search}`);
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const bill = (over: Record<string, unknown> = {}) => ({
  subscriberNo: ME,
  month: 10,
  year: 2026,
  total: 80,
  paidAmount: 0,
  remainingBalance: 80,
  status: 'UNPAID',
  dueDate: '2026-11-15',
  ...over,
});

export const detailed = () => ({
  ...bill(),
  usage: { phoneMinutes: 1350, internetMB: 35000, internetGB: 35 },
  charges: {
    phone: { includedMinutes: 1000, extraBlocks: 1, amount: 10 },
    internet: { base: 50, extraBlocks: 2, amount: 70 },
  },
  usageEvents: { items: [], page: 1, pageSize: 10, totalItems: 35135, totalPages: 3514 },
});

/** The tool exactly as the real MCP server describes it (shape of listTools output). */
export const DOCS_TOOL_DECLARATION: ToolDeclaration = {
  name: 'search_billing_documentation',
  description:
    "Search the Mobile Provider Billing Guide … Use the guide's terms; if matches is empty, retry once with different keywords. Topics covered: 3. Internet pricing (3.2 Additional internet blocks); 7. Billing disputes (7.1 Dispute window).",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 5, default: 5 },
    },
    required: ['query'],
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
};

export const match = (section: string, text = `text of ${section}`) => ({
  section,
  heading: `heading ${section}`,
  text,
  score: 10,
});

export class FakeDocs implements DocsClient {
  readonly tool = DOCS_TOOL_DECLARATION;
  readonly transport = 'fake' as const;
  readonly queries: Record<string, unknown>[] = [];

  constructor(private readonly answer: (query: string) => ReturnType<typeof match>[]) {}

  call(args: Record<string, unknown>): Promise<unknown> {
    this.queries.push(args);
    return Promise.resolve({
      document: 'Mobile_Provider_Billing_Guide.md',
      documentId: 'MOB-BILLING-2026-01',
      matches: this.answer(String(args.query)),
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export const session = (): Session => ({
  subscriberNo: ME,
  role: 'SUBSCRIBER',
  token: 'jwt-of-5551000002',
  expiresAt: new Date('2026-11-18T13:00:00Z'),
  expired: false,
});

export interface Harness {
  agent: Agent;
  llm: MockProvider;
  api: FakeBillingApi;
  docs: FakeDocs;
  trace: Trace;
  session: Session;
  confirmations: PaymentSummary[];
  printed: string[];
}

export function harness(opts: {
  script: ScriptedTurn[];
  api?: FakeBillingApi;
  docs?: FakeDocs;
  confirmAnswer?: string;
  transactionIds?: string[];
  maxTurns?: number;
}): Harness {
  const api = opts.api ?? new FakeBillingApi();
  const docs = opts.docs ?? new FakeDocs(() => []);
  const llm = new MockProvider(opts.script);
  const s = session();
  const printed: string[] = [];
  const trace = new Trace({ print: (l) => printed.push(l), dir: 'unused' });
  const confirmations: PaymentSummary[] = [];
  const ids = [...(opts.transactionIds ?? ['txn-1', 'txn-2', 'txn-3'])];
  const executor = new ToolExecutor({
    billing: new BillingClient('http://gateway.test', api.fetch),
    docs,
    session: s,
    confirm: (summary) => {
      confirmations.push(summary);
      return Promise.resolve(opts.confirmAnswer ?? 'EVET');
    },
    newTransactionId: () => ids.shift() ?? 'txn-x',
    sleep: () => Promise.resolve(),
  });
  const agent = new Agent({
    llm,
    executor,
    trace,
    systemPrompt: () =>
      buildSystemPrompt({ today: new Date('2026-11-18T10:00:00Z'), subscriberNo: ME }),
    ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
  });
  return { agent, llm, api, docs, trace, session: s, confirmations, printed };
}

/** The tool results the LLM was shown in its last request. */
export function lastToolResults(h: Harness): unknown[] {
  const req = h.llm.requests[h.llm.requests.length - 1];
  const m = req?.messages[req.messages.length - 1];
  return m?.role === 'tool' ? m.results.map((r) => r.result) : [];
}
