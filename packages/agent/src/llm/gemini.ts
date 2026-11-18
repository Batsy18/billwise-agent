/**
 * Gemini adapter (@google/genai) with real function calling.
 *
 * Mapping (toGeminiRequest / fromGeminiResponse are pure and unit-tested):
 *   system prompt     → config.systemInstruction
 *   tools             → config.tools[0].functionDeclarations (parametersJsonSchema = JSON Schema)
 *   user message      → { role: 'user', parts: [{ text }] }
 *   assistant message → { role: 'model', parts: <the model's own parts, verbatim> }
 *                       Thinking models attach a thoughtSignature to their parts; it MUST be
 *                       sent back unchanged or multi-step tool use breaks.
 *   tool results      → { role: 'user', parts: [{ functionResponse: { id?, name, response } }] }
 */
// @google/genai ships a CommonJS build (required at runtime below) but its type definitions
// are ESM-only, so types are imported in "import" resolution mode (ADR #31).
import type {
  Content,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
  ThinkingConfig,
  ThinkingLevel,
} from '@google/genai' with { 'resolution-mode': 'import' };
import type * as GenAI from '@google/genai' with { 'resolution-mode': 'import' };
import { sleep, withRetry, type RetryOptions } from './retry';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const genai = require('@google/genai') as typeof GenAI;
import type { LlmProvider, LlmRequest, LlmResponse, LlmTiming, Message, ToolCall } from './types';

/** GEMINI_THINKING_BUDGET: a level ("MINIMAL"…) for 3.x models or a token budget for 2.x. */
export function thinkingConfig(setting: string | number): ThinkingConfig {
  return typeof setting === 'number'
    ? { thinkingBudget: setting }
    : { thinkingLevel: setting as ThinkingLevel };
}

/** functionResponse.response must be a JSON object. */
function asResponseObject(result: unknown): Record<string, unknown> {
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { output: result };
}

function toContent(m: Message): Content {
  switch (m.role) {
    case 'user':
      return { role: 'user', parts: [{ text: m.text }] };
    case 'assistant': {
      if (Array.isArray(m.raw)) return { role: 'model', parts: m.raw as Part[] };
      const parts: Part[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls) {
        parts.push({
          functionCall: {
            ...(c.providerId ? { id: c.providerId } : {}),
            name: c.name,
            args: c.args,
          },
        });
      }
      return { role: 'model', parts };
    }
    case 'tool':
      return {
        role: 'user',
        parts: m.results.map((r) => ({
          functionResponse: {
            ...(r.providerId ? { id: r.providerId } : {}),
            name: r.name,
            response: asResponseObject(r.result),
          },
        })),
      };
  }
}

export function toGeminiRequest(
  model: string,
  thinking: string | number,
  req: LlmRequest,
): GenerateContentParameters {
  return {
    model,
    contents: req.messages.map(toContent),
    config: {
      systemInstruction: req.system,
      tools: [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.parameters,
          })),
        },
      ],
      toolConfig: { functionCallingConfig: { mode: genai.FunctionCallingConfigMode.AUTO } },
      automaticFunctionCalling: { disable: true }, // the agent executes tools, not the SDK
      thinkingConfig: thinkingConfig(thinking),
    },
  };
}

export function fromGeminiResponse(resp: GenerateContentResponse): LlmResponse {
  const parts: Part[] = resp.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
  const toolCalls: ToolCall[] = parts
    .filter((p) => p.functionCall?.name)
    .map((p, i) => {
      const fc = p.functionCall!;
      return {
        id: fc.id ?? `${fc.name}#${i}`,
        ...(fc.id ? { providerId: fc.id } : {}),
        name: fc.name!,
        args: fc.args ?? {},
      };
    });
  const u = resp.usageMetadata;
  return {
    text,
    toolCalls,
    raw: parts,
    usage: {
      inputTokens: u?.promptTokenCount ?? 0,
      outputTokens: u?.candidatesTokenCount ?? 0,
      thinkingTokens: u?.thoughtsTokenCount ?? 0,
    },
  };
}

/** The slice of the SDK the adapter uses (lets tests inject a fake). */
export interface GenerateContentApi {
  generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
}

export interface GeminiOptions {
  apiKey?: string;
  model: string;
  thinking: string | number;
  /** Minimum gap between requests (free tier: 15 RPM for 3.5 Flash-Lite → 4.1 s). */
  minIntervalMs?: number;
  retry?: RetryOptions;
  api?: GenerateContentApi;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class GeminiProvider implements LlmProvider {
  readonly name: string;
  private readonly api: GenerateContentApi;
  private lastCallAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: GeminiOptions) {
    this.name = `gemini:${opts.model}`;
    this.api = opts.api ?? new genai.GoogleGenAI({ apiKey: opts.apiKey ?? '' }).models;
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    const now = this.opts.now ?? Date.now;
    const params = toGeminiRequest(this.opts.model, this.opts.thinking, req);
    const timing: LlmTiming = { pacingMs: 0, retries: [], apiMs: 0, attempts: 0 };
    const resp = await withRetry(
      async () => {
        timing.pacingMs += await this.pace();
        timing.attempts += 1;
        const t0 = now();
        try {
          return await this.api.generateContent(params);
        } finally {
          timing.apiMs += now() - t0;
        }
      },
      {
        ...this.opts.retry,
        onRetry: (info) => {
          timing.retries.push({ status: info.status, delayMs: info.delayMs });
          this.opts.retry?.onRetry?.(info);
        },
      },
    );
    return { ...fromGeminiResponse(resp), timing };
  }

  /** Waits until LLM_MIN_INTERVAL_MS has passed since the previous request; returns the wait. */
  private async pace(): Promise<number> {
    const now = this.opts.now ?? Date.now;
    const gap = (this.opts.minIntervalMs ?? 0) - (now() - this.lastCallAt);
    if (gap > 0) await (this.opts.sleep ?? sleep)(gap);
    this.lastCallAt = now();
    return Math.max(0, gap);
  }
}
