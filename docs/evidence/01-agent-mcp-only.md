# Agent scenario 1 — MCP-only (policy question)

From the live **cloud** demo run on 2026-11-18 (`npm run demo:cloud -- --reseed`): agent on a
local machine, REST calls through **GCP API Gateway** → Cloud Run billing-api → Cloud SQL, documentation search
through the **Cloud Run MCP server**, LLM `gemini:gemini-3.5-flash-lite`, logged in as subscriber `5551000002` (JWT).
Full trace: [traces/2026-11-18-cloud-demo.json](traces/2026-11-18-cloud-demo.json) (no tokens, passwords or keys in it).

**Question (TR):** "Ek internet ne kadar?" (_How much does extra internet cost?_)

**Expected:** the LLM calls only `search_billing_documentation`; no billing API call. ✔

## Console trace

```text
> Ek internet ne kadar?
  · LLM turn 1 (1277 ms: Gemini 1277 ms | 1533 in / 21 out) → search_billing_documentation
  ▶ search_billing_documentation {"query":"cost of extra internet"} (82 ms) → sections 8.1, 3.1, 3.2, 4.3, 3.3
  · LLM turn 2 (4457 ms: Gemini 1709 ms, pacing 2739 ms | 1969 in / 98 out)
  ⇒ Ek internet ücreti Bölüm 8.1 ve Bölüm 3.2'ye göre: 20 GB'lık dahil internet hakkını aştıktan sonra, her ek 10 GB'lık blok 10 dolardır. Kısmen kullanılan ek bloklar tam blok olarak ücretlendirilir (örneğin 21 GB kullanım 30 GB olarak ücretlendirilir ve toplam ek internet maliyeti iki blok için 20 dolar olur).
```

## Answer in English (translation)

> According to Sections 8.1 and 3.2: after the included 20 GB, each additional 10 GB block costs $10.
> Partially used extra blocks are charged as full blocks (for example, 21 GB of usage is charged as
> 30 GB and the total extra internet cost for two blocks is $20).

**Note (honest reading):** the rule and the cited sections are right, but the model's own example is wrong:
21 GB starts one extra block (20 GB + 1 GB → one 10 GB block), i.e. **$10**, not $20. The tool returned the
correct text (8.1: "Each additional 10 GB block beyond 20 GB costs $10. Partially used blocks are rounded
up."); the error is in the LLM's elaboration. See README → Known limitations. Real bills are never computed
by the LLM (guide 4.4); they come from the API.

**Fix (2026-11-20):** system prompt rule 11 ([prompt.ts](../../packages/agent/src/prompt.ts), tested in [timing.test.ts](../../packages/agent/src/timing.test.ts)) allows only the guide's own worked examples or the user's real API numbers; the local re-run of scenario a then quoted guide 3.2's examples exactly (20 GB $50, 21 GB $60, 30 GB $60, 35 GB $70).

## Trace steps (JSON, from the trace file)

<details><summary>Show the raw steps</summary>

```json
[
  {
    "type": "llm",
    "turn": 1,
    "durationMs": 1277,
    "usage": {
      "inputTokens": 1533,
      "outputTokens": 21,
      "thinkingTokens": 0
    },
    "timing": {
      "pacingMs": 0,
      "retries": [],
      "apiMs": 1277,
      "attempts": 1
    },
    "toolCalls": ["search_billing_documentation"]
  },
  {
    "type": "tool",
    "name": "search_billing_documentation",
    "input": {
      "query": "cost of extra internet"
    },
    "result": {
      "document": "Mobile_Provider_Billing_Guide.md",
      "documentId": "MOB-BILLING-2026-01",
      "matches": [
        {
          "section": "8.1",
          "heading": "What is the cost of extra internet?",
          "text": "Each additional 10 GB block beyond 20 GB costs $10. Partially used blocks are rounded up. See Section 3.2.",
          "score": 62.76
        },
        {
          "section": "3.1",
          "heading": "Included internet allowance",
          "text": "Internet access costs $50 per month for up to 20 GB, including months with zero usage.",
          "score": 28.78
        },
        {
          "section": "3.2",
          "heading": "Additional internet blocks",
          "text": "Each additional 10 GB block costs $10. A partially used additional block is charged as a full block. For example, 20 GB costs $50; 21 GB costs $60; 30 GB costs $60; 35 GB costs $70.",
          "score": 26.54
        },
        {
          "section": "4.3",
          "heading": "Worked example",
          "text": "A subscriber uses 1,350 phone minutes and 35 GB of internet in a month. Phone: $10 for one extra 1,000-minute block. Internet: $50 base + $20 for two additional 10 GB blocks. Total = $80.",
          "score": 12.91
        },
        {
          "section": "3.3",
          "heading": "Units and usage events",
          "text": "For this fictitious system, 1 GB = 1,000 MB. Each internet Add Usage API event records 1 MB. The billing engine aggregates usage for the selected month and year.",
          "score": 5.24
        }
      ]
    },
    "durationMs": 82
  },
  {
    "type": "llm",
    "turn": 2,
    "durationMs": 4457,
    "usage": {
      "inputTokens": 1969,
      "outputTokens": 98,
      "thinkingTokens": 0
    },
    "timing": {
      "pacingMs": 2739,
      "retries": [],
      "apiMs": 1709,
      "attempts": 1
    },
    "toolCalls": []
  },
  {
    "type": "final",
    "answer": "Ek internet ücreti Bölüm 8.1 ve Bölüm 3.2'ye göre: 20 GB'lık dahil internet hakkını aştıktan sonra, her ek 10 GB'lık blok 10 dolardır. Kısmen kullanılan ek bloklar tam blok olarak ücretlendirilir (örneğin 21 GB kullanım 30 GB olarak ücretlendirilir ve toplam ek internet maliyeti iki blok için 20 dolar olur).",
    "reason": "llm"
  }
]
```

</details>
