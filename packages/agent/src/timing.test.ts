import type { GenerateContentResponse } from '@google/genai' with { 'resolution-mode': 'import' };
import { loadAgentConfig } from './config';
import { GeminiProvider } from './llm/gemini';
import type { LlmRequest } from './llm/types';
import { buildSystemPrompt } from './prompt';
import { createLlm } from './setup';
import { ME } from './test/fakes';
import { formatTiming } from './trace';

const ok = {
  candidates: [{ content: { parts: [{ text: 'ok' }] } }],
} as unknown as GenerateContentResponse;
const req: LlmRequest = { system: 's', tools: [], messages: [{ role: 'user', text: 'hi' }] };

describe('LLM timing split (pacing / retry wait / Gemini latency)', () => {
  it('reports pacing wait, each retry with its status, API time and attempts', async () => {
    let t = 1000;
    const queue: (GenerateContentResponse | Error)[] = [
      Object.assign(new Error('{"retryDelay": "3s"}'), { status: 429 }),
      Object.assign(new Error('x'), { status: 503 }),
      ok,
    ];
    const advance = (ms: number) => {
      t += ms;
      return Promise.resolve();
    };
    const p = new GeminiProvider({
      model: 'm',
      thinking: 'MINIMAL',
      minIntervalMs: 4000,
      now: () => t,
      sleep: advance,
      retry: { sleep: advance },
      api: {
        generateContent: () => {
          t += 700; // each attempt takes 700 ms on the wire
          const next = queue.shift()!;
          return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
        },
      },
    });
    const r = await p.chat(req);
    // attempt 1: no pacing. 700 ms call, 3000 ms backoff → attempt 2 starts 3700 ms after
    // attempt 1 → 300 ms pacing. 700 ms call, 4000 ms backoff → attempt 3: no pacing.
    expect(r.timing).toEqual({
      pacingMs: 300,
      retries: [
        { status: 429, delayMs: 3000 },
        { status: 503, delayMs: 4000 },
      ],
      apiMs: 2100,
      attempts: 3,
    });
  });

  it('unpaced (chat): back-to-back calls never wait', async () => {
    let t = 0;
    const p = new GeminiProvider({
      model: 'm',
      thinking: 'MINIMAL',
      minIntervalMs: 0,
      now: () => t,
      api: {
        generateContent: () => {
          t += 50;
          return Promise.resolve(ok);
        },
      },
    });
    await p.chat(req);
    const r = await p.chat(req);
    expect(r.timing).toEqual({ pacingMs: 0, retries: [], apiMs: 50, attempts: 1 });
  });

  it('formatTiming shows only the non-zero parts', () => {
    expect(formatTiming({ pacingMs: 0, retries: [], apiMs: 812, attempts: 1 })).toBe(
      'Gemini 812 ms',
    );
    expect(
      formatTiming({
        pacingMs: 3100,
        retries: [{ status: 503, delayMs: 2000 }],
        apiMs: 1500,
        attempts: 2,
      }),
    ).toBe('Gemini 1500 ms over 2 attempts, pacing 3100 ms, retry wait 2000 ms [503]');
  });
});

describe('pacing applies to the demo only', () => {
  const config = loadAgentConfig({ GEMINI_API_KEY: 'k' });
  const interval = (llm: unknown) =>
    (llm as { opts: { minIntervalMs: number } }).opts.minIntervalMs;

  it('chat (default) is not paced; the demo is', () => {
    expect(interval(createLlm(config, () => undefined))).toBe(0);
    expect(interval(createLlm(config, () => undefined, { paced: true }))).toBe(4100);
  });
});

describe('plain-text answers', () => {
  it('the system prompt forbids Markdown but allows "- " lists', () => {
    const p = buildSystemPrompt({ today: new Date('2026-11-18T00:00:00Z'), subscriberNo: ME });
    expect(p).toMatch(/plain-text terminal: do NOT use Markdown — no \*\*bold\*\*/);
    expect(p).toContain('Simple lists with "- "');
  });
});

describe('no invented numeric examples', () => {
  // Cloud demo 2026-11-18, scenario a: the model invented "21 GB → two blocks, $20" (the guide
  // says one block, $10). Pricing explanations may only use the guide's examples or API numbers.
  it("the system prompt restricts pricing examples to the guide's own and the user's real numbers", () => {
    const p = buildSystemPrompt({ today: new Date('2026-11-18T00:00:00Z'), subscriberNo: ME });
    expect(p).toContain(
      "11. When explaining pricing, use ONLY the guide's own worked examples (quote them as they appear in `matches`) or the user's real numbers from the API. Never invent new numeric examples.",
    );
  });
});
