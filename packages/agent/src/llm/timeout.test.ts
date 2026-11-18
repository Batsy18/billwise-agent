import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai' with {
  'resolution-mode': 'import',
};
import { loadAgentConfig } from '../config';
import { harness } from '../test/fakes';
import { DEFAULT_TIMEOUT_MS, GeminiProvider, type GenerateContentApi } from './gemini';
import { LlmUnavailableError, type LlmRequest } from './types';

const ok = {
  candidates: [{ content: { parts: [{ text: 'Bölüm 3.2' }] } }],
} as unknown as GenerateContentResponse;
const req: LlmRequest = { system: 's', tools: [], messages: [{ role: 'user', text: 'hi' }] };

/** Mock Gemini API: 'hang' never answers (until aborted), a response answers immediately. */
function mockApi(plan: ('hang' | GenerateContentResponse)[]) {
  const signals: AbortSignal[] = [];
  const api: GenerateContentApi = {
    generateContent: (params: GenerateContentParameters) => {
      const signal = params.config?.abortSignal;
      if (signal) signals.push(signal);
      const step = plan.shift();
      if (step === 'hang') return new Promise<never>(() => undefined);
      return Promise.resolve(step ?? ok);
    },
  };
  return { api, signals };
}

const provider = (api: GenerateContentApi, waits: number[] = []) =>
  new GeminiProvider({
    model: 'm',
    thinking: 'MINIMAL',
    timeoutMs: 30, // real timer, kept tiny for the test
    api,
    retry: {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    },
  });

describe('Gemini per-request timeout (GEMINI_TIMEOUT_MS)', () => {
  it('timeout → request aborted, retried once like a 503, then succeeds', async () => {
    const { api, signals } = mockApi(['hang', ok]);
    const waits: number[] = [];
    const r = await provider(api, waits).chat(req);
    expect(r.text).toBe('Bölüm 3.2');
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true); // the hung request was cancelled
    expect(signals[1]!.aborted).toBe(false);
    expect(waits).toEqual([2000]); // same backoff as the first 503 retry
    expect(r.timing).toMatchObject({
      retries: [{ status: 'timeout', delayMs: 2000 }],
      attempts: 2,
    });
    expect(r.timing!.apiMs).toBeGreaterThanOrEqual(25);
  });

  it('a second timeout is not retried: LlmUnavailableError with a clear message', async () => {
    const { api, signals } = mockApi(['hang', 'hang', ok]);
    await expect(provider(api).chat(req)).rejects.toThrow(LlmUnavailableError);
    await expect(provider(mockApi(['hang', 'hang']).api).chat(req)).rejects.toThrow(
      /did not answer within 0\.03 s\. Please try again\./,
    );
    expect(signals).toHaveLength(2); // exactly one retry, the third plan step never runs
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('a timeout still leaves the HTTP-error retry budget intact (timeout, 503, then ok)', async () => {
    let n = 0;
    const api: GenerateContentApi = {
      generateContent: () => {
        n += 1;
        if (n === 1) return new Promise<never>(() => undefined);
        if (n === 2) return Promise.reject(Object.assign(new Error('overloaded'), { status: 503 }));
        return Promise.resolve(ok);
      },
    };
    const waits: number[] = [];
    const r = await provider(api, waits).chat(req);
    expect(r.timing!.retries.map((x) => x.status)).toEqual(['timeout', 503]);
    expect(waits).toEqual([2000, 4000]);
  });

  it('a fast answer clears the timer (no timeout, no retry)', async () => {
    const r = await provider(mockApi([ok]).api).chat(req);
    expect(r.timing).toMatchObject({ retries: [], attempts: 1 });
  });

  it('shows in the trace as "retry wait … [timeout]"', async () => {
    const h = harness({ script: [], provider: provider(mockApi(['hang', ok]).api) });
    const a = await h.agent.ask('Ek internet ne kadar?');
    expect(a).toEqual({ text: 'Bölüm 3.2', reason: 'llm' });
    expect(h.printed.join('\n')).toMatch(
      /LLM turn 1 \(\d+ ms: Gemini \d+ ms over 2 attempts, retry wait 2000 ms \[timeout\]/,
    );
    const step = h.trace.exchanges[0]!.steps[0]!;
    expect(step.type === 'llm' && step.timing?.retries).toEqual([
      { status: 'timeout', delayMs: 2000 },
    ]);
  });

  it('config: GEMINI_TIMEOUT_MS defaults to 20000 and must be at least 1000', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
    expect(loadAgentConfig({ GEMINI_API_KEY: 'k' }).GEMINI_TIMEOUT_MS).toBe(20_000);
    expect(
      loadAgentConfig({ GEMINI_API_KEY: 'k', GEMINI_TIMEOUT_MS: '45000' }).GEMINI_TIMEOUT_MS,
    ).toBe(45_000);
    expect(() => loadAgentConfig({ GEMINI_API_KEY: 'k', GEMINI_TIMEOUT_MS: '50' })).toThrow(
      /GEMINI_TIMEOUT_MS/,
    );
  });
});
