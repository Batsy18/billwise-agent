import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai' with {
  'resolution-mode': 'import',
};
import { fromGeminiResponse, GeminiProvider, thinkingConfig, toGeminiRequest } from './gemini';
import { isDailyQuota, retryDelayMs } from './retry';
import { LlmUnavailableError, type LlmRequest, type ToolDeclaration } from './types';

const tool: ToolDeclaration = {
  name: 'search_billing_documentation',
  description: 'Search the guide',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

const signedCall = {
  functionCall: { id: 'fc-1', name: 'query_bill', args: { month: 10, year: 2026 } },
  thoughtSignature: 'SIG==',
};

const req: LlmRequest = {
  system: 'SYSTEM',
  tools: [tool],
  messages: [
    { role: 'user', text: 'Ekim faturam?' },
    {
      role: 'assistant',
      text: '',
      toolCalls: [
        { id: 'fc-1', providerId: 'fc-1', name: 'query_bill', args: { month: 10, year: 2026 } },
      ],
      raw: [signedCall],
    },
    {
      role: 'tool',
      results: [
        {
          callId: 'fc-1',
          providerId: 'fc-1',
          name: 'query_bill',
          result: { status: 'ok', bill: { total: 80 } },
        },
      ],
    },
    { role: 'assistant', text: 'old answer', toolCalls: [] }, // no raw → rebuilt from text
    {
      role: 'tool',
      results: [{ callId: 'x#0', name: 'search_billing_documentation', result: 'plain string' }],
    },
  ],
};

describe('toGeminiRequest', () => {
  const p = toGeminiRequest('gemini-3.5-flash-lite', 'MINIMAL', req);

  it('maps system prompt, tool declarations (JSON Schema as-is) and config', () => {
    expect(p.model).toBe('gemini-3.5-flash-lite');
    expect(p.config).toMatchObject({
      systemInstruction: 'SYSTEM',
      tools: [
        {
          functionDeclarations: [
            {
              name: tool.name,
              description: tool.description,
              parametersJsonSchema: tool.parameters,
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      automaticFunctionCalling: { disable: true },
      thinkingConfig: { thinkingLevel: 'MINIMAL' },
    });
  });

  it('replays the model parts verbatim, including the thought signature', () => {
    expect(p.contents).toEqual([
      { role: 'user', parts: [{ text: 'Ekim faturam?' }] },
      { role: 'model', parts: [signedCall] },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-1',
              name: 'query_bill',
              response: { status: 'ok', bill: { total: 80 } },
            },
          },
        ],
      },
      { role: 'model', parts: [{ text: 'old answer' }] },
      // no provider id → no id; non-object result wrapped as { output }
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'search_billing_documentation',
              response: { output: 'plain string' },
            },
          },
        ],
      },
    ]);
  });

  it('a numeric thinking setting becomes thinkingBudget (Gemini 2.x)', () => {
    expect(thinkingConfig(512)).toEqual({ thinkingBudget: 512 });
    expect(thinkingConfig('LOW')).toEqual({ thinkingLevel: 'LOW' });
  });
});

describe('fromGeminiResponse', () => {
  it('extracts tool calls (with ids), skips thought text, keeps raw parts and usage', () => {
    const resp = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'thinking about it', thought: true },
              signedCall,
              {
                functionCall: {
                  name: 'search_billing_documentation',
                  args: { query: 'extra internet cost' },
                },
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 30, thoughtsTokenCount: 12 },
    } as unknown as GenerateContentResponse;
    const r = fromGeminiResponse(resp);
    expect(r.text).toBe('');
    expect(r.toolCalls).toEqual([
      { id: 'fc-1', providerId: 'fc-1', name: 'query_bill', args: { month: 10, year: 2026 } },
      {
        id: 'search_billing_documentation#1',
        name: 'search_billing_documentation',
        args: { query: 'extra internet cost' },
      },
    ]);
    expect(r.raw).toHaveLength(3);
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 30, thinkingTokens: 12 });
  });

  it('a text-only answer has no tool calls', () => {
    const r = fromGeminiResponse({
      candidates: [{ content: { parts: [{ text: 'Bölüm 3.2' }, { text: '’ye göre…' }] } }],
    } as unknown as GenerateContentResponse);
    expect(r).toMatchObject({ text: 'Bölüm 3.2’ye göre…', toolCalls: [] });
  });
});

describe('GeminiProvider retries and pacing', () => {
  const ok = {
    candidates: [{ content: { parts: [{ text: 'ok' }] } }],
  } as unknown as GenerateContentResponse;
  const err = (status: number, message = '') => Object.assign(new Error(message), { status });

  function provider(
    responses: (GenerateContentResponse | Error)[],
    extra: Partial<ConstructorParameters<typeof GeminiProvider>[0]> = {},
  ) {
    const calls: GenerateContentParameters[] = [];
    const waits: number[] = [];
    const p = new GeminiProvider({
      model: 'm',
      thinking: 'MINIMAL',
      api: {
        generateContent: (params) => {
          calls.push(params);
          const next = responses.shift();
          return next instanceof Error ? Promise.reject(next) : Promise.resolve(next!);
        },
      },
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      retry: { sleep: (ms) => (waits.push(ms), Promise.resolve()) },
      ...extra,
    });
    return { p, calls, waits };
  }

  it('429 then success: backs off (honouring retryDelay) and succeeds', async () => {
    const { p, calls, waits } = provider([err(429, '{"retryDelay": "7s"}'), err(503), ok]);
    await expect(p.chat(req)).resolves.toMatchObject({ text: 'ok' });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([7000, 4000]); // retryDelay, then 2s * 2^1
  });

  it('persistent 429 → LlmUnavailableError with a user-facing message', async () => {
    const { p } = provider(Array.from({ length: 6 }, () => err(429)));
    await expect(p.chat(req)).rejects.toThrow(LlmUnavailableError);
  });

  it('daily quota → no retry, clear message with the hint', async () => {
    const { p, calls } = provider(
      [
        err(
          429,
          'Quota exceeded for metric generate_content_free_tier_requests, limit: GenerateRequestsPerDayPerProjectPerModel',
        ),
      ],
      {
        retry: {
          quotaHint: 'Wait for the reset or enable billing.',
          sleep: () => Promise.resolve(),
        },
      },
    );
    await expect(p.chat(req)).rejects.toThrow(
      /daily free-tier quota is used up\. Wait for the reset or enable billing\./,
    );
    expect(calls).toHaveLength(1);
  });

  it('4xx other than 429 is not retried', async () => {
    const { p, calls } = provider([err(400, 'bad')]);
    await expect(p.chat(req)).rejects.toThrow('bad');
    expect(calls).toHaveLength(1);
  });

  it('paces requests to the minimum interval', async () => {
    let t = 0;
    const { p, waits } = provider([ok, ok], { minIntervalMs: 4100, now: () => t });
    await p.chat(req);
    t = 1000;
    await p.chat(req);
    expect(waits).toEqual([3100]);
  });

  it('helpers', () => {
    expect(retryDelayMs(new Error('"retryDelay":"12.5s"'))).toBe(12500);
    expect(isDailyQuota(err(429, 'PerDay'))).toBe(true);
    expect(isDailyQuota(err(429, 'PerMinute'))).toBe(false);
  });
});
