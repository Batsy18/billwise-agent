/** Provider-neutral chat types. The agent loop only sees these; adapters map them. */

export type JsonSchema = Record<string, unknown>;

export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema of the arguments (the MCP tool's inputSchema is passed through as-is). */
  parameters: JsonSchema;
}

export interface ToolCall {
  /** Stable id within the conversation (provider id if it gave one, else synthetic). */
  id: string;
  /** The provider's own call id, echoed back in the function response when present. */
  providerId?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  providerId?: string;
  name: string;
  result: unknown;
}

export type Message =
  | { role: 'user'; text: string }
  /** `raw` = the provider's own message parts, replayed verbatim (Gemini thought signatures). */
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: ToolResult[] };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

export interface LlmRequest {
  system: string;
  messages: readonly Message[];
  tools: readonly ToolDeclaration[];
}

/** Where an LLM turn's wall-clock time went. */
export interface LlmTiming {
  /** Waiting to respect LLM_MIN_INTERVAL_MS (demo only). */
  pacingMs: number;
  /** Backoff waits, each with the HTTP status that caused it. */
  retries: { status: number; delayMs: number }[];
  /** Time spent inside the provider API calls (all attempts, incl. failed ones). */
  apiMs: number;
  attempts: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown;
  usage?: Usage;
  timing?: LlmTiming;
}

export interface LlmProvider {
  readonly name: string;
  chat(req: LlmRequest): Promise<LlmResponse>;
}

/** The LLM cannot be reached (quota, outage). `message` is safe to show to the user. */
export class LlmUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LlmUnavailableError';
  }
}
