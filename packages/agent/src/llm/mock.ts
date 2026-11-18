/**
 * Mock LLM for tests and quota-free development. Replays scripted turns in order; a turn can
 * be a fixed response or a function of the request (to react to tool results).
 * Every request is recorded so tests can assert what the "LLM" was shown.
 */
import type { LlmProvider, LlmRequest, LlmResponse, ToolCall } from './types';

export type ScriptedTurn = LlmResponse | ((req: LlmRequest) => LlmResponse);

export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly requests: LlmRequest[] = [];
  private readonly turns: ScriptedTurn[];

  constructor(turns: ScriptedTurn[]) {
    this.turns = [...turns];
  }

  chat(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    if (!turn) return Promise.reject(new Error('MockProvider: script exhausted'));
    return Promise.resolve(typeof turn === 'function' ? turn(req) : turn);
  }

  get remaining(): number {
    return this.turns.length;
  }
}

let seq = 0;
/** Helpers to write scripts tersely. */
export const callTools = (...calls: Omit<ToolCall, 'id'>[]): LlmResponse => ({
  text: '',
  toolCalls: calls.map((c) => ({ ...c, id: `mock-${++seq}` })),
});
export const say = (text: string): LlmResponse => ({ text, toolCalls: [] });

/**
 * LLM_PROVIDER=mock in the CLI: a dev-only stand-in that always searches the guide with the
 * user's words, then repeats the top section. No routing to REST tools — that is the real
 * LLM's job; this only lets you exercise the CLI, MCP and traces without spending quota.
 */
export class DevMockProvider implements LlmProvider {
  readonly name = 'mock:dev';

  chat(req: LlmRequest): Promise<LlmResponse> {
    const last = req.messages[req.messages.length - 1];
    if (last?.role === 'user') {
      return Promise.resolve(
        callTools({ name: 'search_billing_documentation', args: { query: last.text } }),
      );
    }
    if (last?.role === 'tool') {
      const r = last.results[0]?.result as
        { matches?: { section: string; text: string }[] } | undefined;
      const top = r?.matches?.[0];
      return Promise.resolve(
        say(
          top ? `[mock] Section ${top.section}: ${top.text}` : '[mock] No relevant section found.',
        ),
      );
    }
    return Promise.resolve(say('[mock] …'));
  }
}
