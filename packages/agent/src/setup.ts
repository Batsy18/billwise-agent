/** Wiring shared by the CLI and the demo. */
import { Agent } from './agent';
import { BillingClient, type Session } from './clients/billing';
import { connectDocs, type DocsClient } from './clients/docs';
import { QUOTA_HINT, type AgentConfig } from './config';
import { GeminiProvider } from './llm/gemini';
import { DevMockProvider } from './llm/mock';
import type { LlmProvider } from './llm/types';
import { buildSystemPrompt } from './prompt';
import { ToolExecutor } from './tools/executor';
import type { ConfirmFn } from './tools/payment-gate';
import type { Trace } from './trace';

/**
 * `paced`: wait LLM_MIN_INTERVAL_MS between requests. Only the demo (a burst of scripted
 * calls) needs it to stay under the free-tier RPM; interactive chat is not paced — a human
 * types slower than 15 requests a minute, and a 429 is still handled by the backoff.
 */
export function createLlm(
  config: AgentConfig,
  log: (m: string) => void,
  opts: { paced?: boolean } = {},
): LlmProvider {
  if (config.LLM_PROVIDER === 'mock') return new DevMockProvider();
  return new GeminiProvider({
    apiKey: config.GEMINI_API_KEY ?? '',
    model: config.GEMINI_MODEL,
    thinking: config.GEMINI_THINKING_BUDGET,
    minIntervalMs: opts.paced ? config.LLM_MIN_INTERVAL_MS : 0,
    timeoutMs: config.GEMINI_TIMEOUT_MS,
    retry: {
      quotaHint: QUOTA_HINT,
      onRetry: ({ attempt, delayMs, status }) =>
        log(
          `  … Gemini ${status === 'timeout' ? 'timed out' : `returned HTTP ${status}`}; retrying in ${Math.round(delayMs / 1000)} s (attempt ${attempt})`,
        ),
    },
  });
}

export function openDocs(config: AgentConfig, log: (m: string) => void): Promise<DocsClient> {
  return connectDocs({
    url: config.MCP_URL,
    ...(config.MCP_API_KEY ? { apiKey: config.MCP_API_KEY } : {}),
    log,
  });
}

export interface AgentSession {
  agent: Agent;
  executor: ToolExecutor;
}

export function createAgent(opts: {
  llm: LlmProvider;
  billing: BillingClient;
  docs: DocsClient;
  session: Session;
  confirm: ConfirmFn;
  trace: Trace;
  today?: () => Date;
}): AgentSession {
  const executor = new ToolExecutor({
    billing: opts.billing,
    docs: opts.docs,
    session: opts.session,
    confirm: opts.confirm,
  });
  const agent = new Agent({
    llm: opts.llm,
    executor,
    trace: opts.trace,
    systemPrompt: () =>
      buildSystemPrompt({
        today: (opts.today ?? (() => new Date()))(),
        subscriberNo: opts.session.subscriberNo,
      }),
  });
  return { agent, executor };
}

export function formatSummary(s: {
  subscriberNo: string;
  month: number;
  year: number;
  amount: number;
  remainingBalance: number;
  dueDate: string;
}): string {
  const period = `${String(s.month).padStart(2, '0')}/${s.year}`;
  return [
    '',
    '  ┌─ Payment confirmation / Ödeme onayı',
    `  │ Subscriber / Abone : ${s.subscriberNo}`,
    `  │ Period / Dönem     : ${period}`,
    `  │ Amount / Tutar     : $${s.amount.toFixed(2)}`,
    `  │ Remaining / Kalan  : $${s.remainingBalance.toFixed(2)} (due ${s.dueDate})`,
    '  └─ Type EVET or YES to pay; anything else cancels. / Ödemek için EVET ya da YES yazın.',
  ].join('\n');
}
