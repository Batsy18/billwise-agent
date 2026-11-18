/**
 * The agent loop (vault note "MCP ve Agent" → Döngü): the LLM chooses tools, the executor runs
 * them, every result goes back to the LLM, and the final answer is the LLM's text.
 * Max MAX_TURNS LLM calls per user message.
 */
import { LlmUnavailableError, type LlmProvider, type Message, type ToolResult } from './llm/types';
import type { ToolExecutor } from './tools/executor';
import type { GateEvent } from './tools/payment-gate';
import type { Trace } from './trace';

export const MAX_TURNS = 6;
export const MAX_TURNS_MESSAGE =
  'Sorry, I could not complete this request in a reasonable number of steps. Please rephrase or ask a narrower question. / Üzgünüm, bu isteği makul adımda tamamlayamadım; lütfen daha net sorun.';

export interface AgentDeps {
  llm: LlmProvider;
  executor: ToolExecutor;
  trace: Trace;
  systemPrompt: () => string;
  maxTurns?: number;
  now?: () => number;
}

export interface Answer {
  text: string;
  reason: 'llm' | 'max_turns' | 'llm_unavailable';
}

export class Agent {
  readonly history: Message[] = [];

  constructor(private readonly deps: AgentDeps) {}

  async ask(question: string): Promise<Answer> {
    const { llm, executor, trace } = this.deps;
    const now = this.deps.now ?? Date.now;
    const maxTurns = this.deps.maxTurns ?? MAX_TURNS;
    executor.startUserMessage();
    trace.question(question);
    this.history.push({ role: 'user', text: question });

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const t0 = now();
      let resp;
      try {
        resp = await llm.chat({
          system: this.deps.systemPrompt(),
          messages: this.history,
          tools: executor.declarations(),
        });
      } catch (err) {
        if (!(err instanceof LlmUnavailableError)) throw err;
        this.history.pop(); // unanswered question: let the user ask again later
        trace.final(err.message, 'llm_unavailable');
        return { text: err.message, reason: 'llm_unavailable' };
      }
      trace.llm({
        turn,
        durationMs: now() - t0,
        ...(resp.usage ? { usage: resp.usage } : {}),
        ...(resp.timing ? { timing: resp.timing } : {}),
        toolCalls: resp.toolCalls.map((c) => c.name),
      });
      this.history.push({
        role: 'assistant',
        text: resp.text,
        toolCalls: resp.toolCalls,
        raw: resp.raw,
      });

      if (resp.toolCalls.length === 0) {
        trace.final(resp.text, 'llm');
        return { text: resp.text, reason: 'llm' };
      }

      const results: ToolResult[] = [];
      for (const call of resp.toolCalls) {
        const t1 = now();
        const events: GateEvent[] = [];
        // Sequential: the payment gate may prompt. Gate steps are printed live and kept.
        const result = await executor.run(call, (e) => {
          events.push(e);
          trace.gateEvent(e);
        });
        trace.tool({
          name: call.name,
          input: call.args,
          result,
          durationMs: now() - t1,
          ...(events.length ? { events } : {}),
        });
        results.push({
          callId: call.id,
          ...(call.providerId ? { providerId: call.providerId } : {}),
          name: call.name,
          result,
        });
      }
      this.history.push({ role: 'tool', results });
    }

    trace.final(MAX_TURNS_MESSAGE, 'max_turns');
    return { text: MAX_TURNS_MESSAGE, reason: 'max_turns' };
  }
}
