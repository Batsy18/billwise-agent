# MCP retrieval tests — `search_billing_documentation`

Live calls against the **Cloud Run MCP server** (`https://mcp-server-rswe5l4uia-ew.a.run.app/mcp`, Streamable HTTP,
header `X-API-Key`) with the official MCP TypeScript SDK client, on 2026-11-20.
Read-only. Server: `billwise-mcp-server` 1.0.0. The index was built **once** at image build time
(`npm run build` → `generated/search-index.json`) and is loaded once at startup; no indexing happens per query.

Reproduce (any query): `MCP_URL=<url>/mcp MCP_API_KEY=<key> npm run call-tool -w @billwise/mcp-server -- "extra internet cost"`

## Results

| #          | Query                                 | Expected section    | Returned sections (score)                                       | Latency |
| ---------- | ------------------------------------- | ------------------- | --------------------------------------------------------------- | ------- |
| **Test 1** | `extra internet cost`                 | 3.2 or 8.1          | 8.1 (62.76), 3.1 (28.78), 3.2 (26.54), 4.3 (12.91), 3.3 (5.24)  | 87 ms   |
| **Test 2** | `pay part of my bill partial payment` | 5.1 / 8.3           | 5.1 (157.76), 5.3 (54.25), 8.3 (43.84), 5.2 (43.61), 6.2 (28.7) | 83 ms   |
| **Test 3** | `dispute a charge deadline`           | 7.1 / 8.4           | 8.4 (34.77), 7.1 (13.9), 7.2 (6.7), 7.3 (5.96), 4.2 (3.05)      | 79 ms   |
| extra      | `service restricted unpaid`           | 6.3                 | 6.3 (97.81), 6.2 (11.89), 4.2 (3.25), 8.3 (3.16)                | 83 ms   |
| negative   | `football match results`              | nothing (off-topic) | `[]` + "No relevant section found…"                             | 76 ms   |

- Tests 1–3 are the three required retrieval tests; each returns the expected section **first** (8.1 is the FAQ
  entry for extra internet and cites 3.2; 3.2 is also returned).
- The negative query shows the relevance gate: an off-topic query returns no match and an instruction not to
  answer from general knowledge (calibration: README → MCP server).
- The same queries are unit tests: [search.test.ts](../../packages/mcp-server/src/search.test.ts).

## Robustness through the agent (5b, cloud run 2026-11-18)

Questions the lexical search alone handled badly in Phase 2 (wrong or empty results). Through the agent, the LLM
rewrote each Turkish question into the guide's English terms on the first try:

| Question (TR)                                              | Query the LLM sent                 | Sections returned (in order) |
| ---------------------------------------------------------- | ---------------------------------- | ---------------------------- |
| Faturamı ödemezsem ne olur?                                | `late payment service restriction` | 6.3, 6.2, 6.1, 5.2, 5.3      |
| Faturama itiraz etmek istiyorum, şikâyetimi nasıl yaparım? | `dispute`                          | 7.1, 8.4, 7.2, 7.3           |
| Müşteri hizmetleri paramı geri verebilir mi?               | `dispute review outcome refund`    | 7.3, 7.1, 8.4, 7.2, 6.3      |
| Faturaya vergi dahil mi?                                   | `tax bill calculation formula`     | 4.2, 4.4, 4.1, 4.3           |

The expected section is first or second in every case (6.3/6.2, 7.1/7.2, 7.3, 4.2). One run; the LLM may phrase
queries differently next time.

## Tool definition as returned by `listTools`

<details><summary>Show the full tool definition (input + output schema, annotations)</summary>

```json
{
  "name": "search_billing_documentation",
  "title": "Search billing documentation",
  "description": "Search the Mobile Provider Billing Guide for billing policies, pricing rules, payment, late payment and dispute rules. Query in English. Does NOT contain any subscriber's live usage or bill data. Use the guide's terms; if matches is empty, retry once with different keywords. Topics covered: 1. Scope and terminology; 2. Phone call pricing (2.1 Included minutes, 2.2 Additional minutes, 2.3 Usage recording); 3. Internet pricing (3.1 Included internet allowance, 3.2 Additional internet blocks, 3.3 Units and usage events); 4. Bill calculation (4.1 Billing period, 4.2 Calculation formula, 4.3 Worked example, 4.4 Bill generation); 5. Payments and outstanding balances (5.1 Full and partial payments, 5.2 Payment confirmation, 5.3 Payment result); 6. Late payments and restrictions (6.1 Due date, 6.2 Late payment reminder, 6.3 Service restriction); 7. Billing disputes (7.1 Dispute window, 7.2 Information required, 7.3 Review outcome); 8. Frequently asked questions (8.1 What is the cost of extra internet?, 8.2 Why is my bill higher this month?, 8.3 Can I pay only part of my bill?, 8.4 How can I dispute a charge?).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "minLength": 2,
        "maxLength": 500,
        "description": "Search terms in English"
      },
      "limit": {
        "default": 5,
        "description": "Max sections",
        "type": "integer",
        "minimum": 1,
        "maximum": 5
      }
    },
    "required": ["query"],
    "$schema": "http://json-schema.org/draft-07/schema#"
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "document": {
        "type": "string"
      },
      "documentId": {
        "type": "string"
      },
      "matches": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "section": {
              "type": "string",
              "description": "Section id in the guide, e.g. \"3.2\""
            },
            "heading": {
              "type": "string"
            },
            "text": {
              "type": "string"
            },
            "score": {
              "type": "number",
              "description": "Relevance score (higher is better)"
            }
          },
          "required": ["section", "heading", "text", "score"],
          "additionalProperties": false
        }
      },
      "message": {
        "description": "Present when matches is empty",
        "type": "string"
      }
    },
    "required": ["document", "documentId", "matches"],
    "$schema": "http://json-schema.org/draft-07/schema#",
    "additionalProperties": false
  },
  "annotations": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "execution": {
    "taskSupport": "forbidden"
  }
}
```

</details>

## Full responses

<details><summary>Show the structuredContent of every call</summary>

### `extra internet cost`

```json
{
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
}
```

### `pay part of my bill partial payment`

```json
{
  "document": "Mobile_Provider_Billing_Guide.md",
  "documentId": "MOB-BILLING-2026-01",
  "matches": [
    {
      "section": "5.1",
      "heading": "Full and partial payments",
      "text": "Subscribers may make full or partial payments. A partial payment reduces the outstanding balance but does not mark the bill fully paid.",
      "score": 157.76
    },
    {
      "section": "5.3",
      "heading": "Payment result",
      "text": "The assistant should report success only after the Pay Bill API confirms the transaction. Retries should use idempotency protection to avoid duplicate payment records.",
      "score": 54.25
    },
    {
      "section": "8.3",
      "heading": "Can I pay only part of my bill?",
      "text": "Yes. The unpaid remainder stays outstanding, and the bill is not fully paid until the balance reaches zero. See Section 5.1.",
      "score": 43.84
    },
    {
      "section": "5.2",
      "heading": "Payment confirmation",
      "text": "Before the AI assistant submits a payment, it must identify the subscriber, billing period, and amount and request explicit confirmation. It must not infer consent from a request for payment information.",
      "score": 43.61
    },
    {
      "section": "6.2",
      "heading": "Late payment reminder",
      "text": "An unpaid bill may trigger a reminder after its due date. The reminder itself does not add a fee.",
      "score": 28.7
    }
  ]
}
```

### `dispute a charge deadline`

```json
{
  "document": "Mobile_Provider_Billing_Guide.md",
  "documentId": "MOB-BILLING-2026-01",
  "matches": [
    {
      "section": "8.4",
      "heading": "How can I dispute a charge?",
      "text": "Submit the billing period, disputed amount, and explanation within 15 days of bill issuance. See Section 7.",
      "score": 34.77
    },
    {
      "section": "7.1",
      "heading": "Dispute window",
      "text": "Subscribers may submit a billing dispute within 15 calendar days of the bill issue date.",
      "score": 13.9
    },
    {
      "section": "7.2",
      "heading": "Information required",
      "text": "A dispute should include the subscriber number, billing period, disputed amount, and explanation. The AI assistant may explain this process but does not have a Dispute API in the required midterm endpoints.",
      "score": 6.7
    },
    {
      "section": "7.3",
      "heading": "Review outcome",
      "text": "Dispute decisions are made by customer support. The assistant must not promise a refund or adjustment without a supporting system record.",
      "score": 5.96
    },
    {
      "section": "4.2",
      "heading": "Calculation formula",
      "text": "Phone charge = `$10 × ceil(max(0, minutes − 1000) / 1000)`.\n\nInternet charge = `$50 + $10 × ceil(max(0, internet_GB − 20) / 10)`.\n\nTotal bill = phone charge + internet charge. For this midterm, there are no taxes, activation fees, discounts, or other service charges.",
      "score": 3.05
    }
  ]
}
```

### `service restricted unpaid`

```json
{
  "document": "Mobile_Provider_Billing_Guide.md",
  "documentId": "MOB-BILLING-2026-01",
  "matches": [
    {
      "section": "6.3",
      "heading": "Service restriction",
      "text": "Service may be restricted when a bill remains unpaid for 30 days after the due date, subject to customer support review. This is a policy description, not a live service-status check.",
      "score": 97.81
    },
    {
      "section": "6.2",
      "heading": "Late payment reminder",
      "text": "An unpaid bill may trigger a reminder after its due date. The reminder itself does not add a fee.",
      "score": 11.89
    },
    {
      "section": "4.2",
      "heading": "Calculation formula",
      "text": "Phone charge = `$10 × ceil(max(0, minutes − 1000) / 1000)`.\n\nInternet charge = `$50 + $10 × ceil(max(0, internet_GB − 20) / 10)`.\n\nTotal bill = phone charge + internet charge. For this midterm, there are no taxes, activation fees, discounts, or other service charges.",
      "score": 3.25
    },
    {
      "section": "8.3",
      "heading": "Can I pay only part of my bill?",
      "text": "Yes. The unpaid remainder stays outstanding, and the bill is not fully paid until the balance reaches zero. See Section 5.1.",
      "score": 3.16
    }
  ]
}
```

### `football match results`

```json
{
  "document": "Mobile_Provider_Billing_Guide.md",
  "documentId": "MOB-BILLING-2026-01",
  "matches": [],
  "message": "No relevant section found in the billing guide. Do not answer from general knowledge; retry once with different keywords or tell the user the guide does not cover it."
}
```

</details>
