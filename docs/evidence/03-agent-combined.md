# Agent scenario 3 — combined (API + MCP)

From the live **cloud** demo run on 2026-11-18 (`npm run demo:cloud -- --reseed`): agent on a
local machine, REST calls through **GCP API Gateway** → Cloud Run billing-api → Cloud SQL, documentation search
through the **Cloud Run MCP server**, LLM `gemini:gemini-3.5-flash-lite`, logged in as subscriber `5551000002` (JWT).
Full trace: [traces/2026-11-18-cloud-demo.json](traces/2026-11-18-cloud-demo.json) (no tokens, passwords or keys in it).

**Question (TR):** "Ekim faturam neden yüksek?" (_Why is my October bill high?_)

**Expected (guide 8.2):** `query_bill_detailed` for the real usage **and** `search_billing_documentation` for
the pricing rules (sections 2–4); usage is not invented. ✔ Both tools were called in the same LLM turn.

## Console trace

```text
> Ekim faturam neden yüksek?
  · LLM turn 1 (4294 ms: Gemini 874 ms, pacing 3420 ms | 1536 in / 53 out) → query_bill_detailed, search_billing_documentation
  ▶ query_bill_detailed {"year":2026,"month":10} (580 ms) → total 80, paid 0, remaining 80, UNPAID
  ▶ search_billing_documentation {"query":"why is my bill higher this month extra internet phone call pricing"} (458 ms) → sections 2.1, 4.3, 3.1, 1, 8.2
  · LLM turn 2 (3802 ms: Gemini 1608 ms, pacing 2188 ms | 3025 in / 294 out)
  ⇒ Ekim 2026 faturanız 80.00 US dolarıdır. Faturanızın yüksek olmasının sebebi, dahili limitlerinizi aşarak ek kullanım yapmış olmanızdır. Ekim ayındaki detaylı kullanımınız ve ücretlendirme kuralları şu şekildedir:

- Telefon kullanımı: 1.350 dakika kullandınız. Bölüm 2.1'e göre ilk 1.000 dakika ücrete dahildir. Ekstra 350 dakika için 1 adet ek 1.000 dakikalık blok ücreti olarak 10.00 US doları yansıtılmıştır (Bölüm 4.3).
- İnternet kullanımı: 35 GB (35.000 MB) kullandınız. Bölüm 3.1'e göre aylık baz ücret 20 GB'a kadar 50.00 US dolarıdır. 20 GB üzerindeki kullanım için her 10 GB'lık ek blok başına ücret uygulanır; 35 GB kullanımınız için 2 ek blok (toplam 20.00 US doları) eklenmiş ve internet toplamı 70.00 US doları olmuştur (Bölüm 4.3).

Toplam tutar 80.00 US dolarıdır (Bölüm 4.3).
```

## Answer in English (translation)

> Your October 2026 bill is USD 80.00. It is higher because you used more than your included limits:
>
> - Phone: you used 1,350 minutes. Per Section 2.1 the first 1,000 minutes are included; one additional
>   1,000-minute block is charged $10.00 for the extra 350 minutes (Section 4.3).
> - Internet: you used 35 GB (35,000 MB). Per Section 3.1 the base price covers up to 20 GB for $50.00;
>   each additional 10 GB block is charged; 35 GB needs 2 extra blocks ($20.00), so internet totals $70.00
>   (Section 4.3).
>
> The total is USD 80.00 (Section 4.3).

All numbers come from the `query_bill_detailed` result (1,350 min, 35 GB, phone $10, internet $70,
total $80); the rules come from the MCP sections.

## Trace steps (JSON, from the trace file)

<details><summary>Show the raw steps</summary>

```json
[
  {
    "type": "llm",
    "turn": 1,
    "durationMs": 4294,
    "usage": {
      "inputTokens": 1536,
      "outputTokens": 53,
      "thinkingTokens": 0
    },
    "timing": {
      "pacingMs": 3420,
      "retries": [],
      "apiMs": 874,
      "attempts": 1
    },
    "toolCalls": ["query_bill_detailed", "search_billing_documentation"]
  },
  {
    "type": "tool",
    "name": "query_bill_detailed",
    "input": {
      "year": 2026,
      "month": 10
    },
    "result": {
      "status": "ok",
      "bill": {
        "subscriberNo": "5551000002",
        "month": 10,
        "year": 2026,
        "total": 80,
        "paidAmount": 0,
        "remainingBalance": 80,
        "status": "UNPAID",
        "dueDate": "2026-11-15",
        "usage": {
          "phoneMinutes": 1350,
          "internetMB": 35000,
          "internetGB": 35
        },
        "charges": {
          "phone": {
            "includedMinutes": 1000,
            "extraBlocks": 1,
            "amount": 10
          },
          "internet": {
            "base": 50,
            "extraBlocks": 2,
            "amount": 70
          }
        },
        "usageEvents": {
          "items": [
            {
              "id": "005b3d8d-ff44-4830-b206-7d084bff0694",
              "usageType": "PHONE",
              "amount": 10,
              "unit": "MIN",
              "createdAt": "2026-11-18T20:05:20.192Z"
            },
            {
              "id": "02356435-38f4-4e89-961a-423e07f49d1b",
              "usageType": "PHONE",
              "amount": 10,
              "unit": "MIN",
              "createdAt": "2026-11-18T20:05:20.192Z"
            },
            {
              "id": "02906e89-4492-4f39-9e74-a8071fc89dba",
              "usageType": "PHONE",
              "amount": 10,
              "unit": "MIN",
              "createdAt": "2026-11-18T20:05:20.192Z"
            },
            {
              "id": "055a42ac-fd02-4888-b817-03bdb2499ee6",
              "usageType": "PHONE",
              "amount": 10,
              "unit": "MIN",
              "createdAt": "2026-11-18T20:05:20.192Z"
            },
            {
              "id": "070a0889-0a6d-4bcc-948c-c98ada6a31ad",
              "usageType": "PHONE",
              "amount": 10,
              "unit": "MIN",
              "createdAt": "2026-11-18T20:05:20.192Z"
            },
            {
              "id": "081772b4-ede4-4cca-a52c-0784ce0af457",
              "usageType": "PHONE",
              "amount": 10,
              "unit": "MIN",
              "createdAt": "2026-11-18T20:05:20.192Z"
            },
            {
              "id": "09f20677-9f13-4b5a-837b-e71549f9b4d2",
              "usageType": "PHONE",
              "amount": 10,
              "unit": "MIN",
              "createdAt": "2026-11-18T20:05:20.192Z"
            },
            {
              "id": "0c155620-b0ae-4720-9e96-fb92afede095",
              "usageType": "PHONE",
              "amount": 10,
              "unit": "MIN",
              "createdAt": "2026-11-18T20:05:20.192Z"
            },
            {
              "id": "122d1560-e683-4c35-8c8a-01de459551ef",
              "usageType": "PHONE",
              "amount": 10,
              "unit": "MIN",
              "createdAt": "2026-11-18T20:05:20.192Z"
            },
            {
              "id": "1406ac19-f2f1-4449-85f7-8a73f642ff48",
              "usageType": "PHONE",
              "amount": 10,
              "unit": "MIN",
              "createdAt": "2026-11-18T20:05:20.192Z"
            }
          ],
          "page": 1,
          "pageSize": 10,
          "totalItems": 35135,
          "totalPages": 3514
        },
        "calculatedAt": "2026-11-18T20:05:26.931Z"
      }
    },
    "durationMs": 580
  },
  {
    "type": "tool",
    "name": "search_billing_documentation",
    "input": {
      "query": "why is my bill higher this month extra internet phone call pricing"
    },
    "result": {
      "document": "Mobile_Provider_Billing_Guide.md",
      "documentId": "MOB-BILLING-2026-01",
      "matches": [
        {
          "section": "2.1",
          "heading": "Included minutes",
          "text": "The first 1,000 minutes of phone calls in a billing month are free.",
          "score": 84.72
        },
        {
          "section": "4.3",
          "heading": "Worked example",
          "text": "A subscriber uses 1,350 phone minutes and 35 GB of internet in a month. Phone: $10 for one extra 1,000-minute block. Internet: $50 base + $20 for two additional 10 GB blocks. Total = $80.",
          "score": 54.12
        },
        {
          "section": "3.1",
          "heading": "Included internet allowance",
          "text": "Internet access costs $50 per month for up to 20 GB, including months with zero usage.",
          "score": 47.91
        },
        {
          "section": "1",
          "heading": "Scope and terminology",
          "text": "Subscriber number identifies a mobile account. Billing period is a calendar month and year. Phone usage is measured in minutes. Internet usage is measured in MB and converted to GB for pricing. Paid status indicates whether the bill has been fully settled in the billing database.",
          "score": 44.59
        },
        {
          "section": "8.2",
          "heading": "Why is my bill higher this month?",
          "text": "Use Query Bill Detailed to retrieve actual usage and charge breakdown, then use Sections 2–4 to explain the applicable rules. Do not invent usage amounts.",
          "score": 43.83
        }
      ]
    },
    "durationMs": 458
  },
  {
    "type": "llm",
    "turn": 2,
    "durationMs": 3802,
    "usage": {
      "inputTokens": 3025,
      "outputTokens": 294,
      "thinkingTokens": 0
    },
    "timing": {
      "pacingMs": 2188,
      "retries": [],
      "apiMs": 1608,
      "attempts": 1
    },
    "toolCalls": []
  },
  {
    "type": "final",
    "answer": "Ekim 2026 faturanız 80.00 US dolarıdır. Faturanızın yüksek olmasının sebebi, dahili limitlerinizi aşarak ek kullanım yapmış olmanızdır. Ekim ayındaki detaylı kullanımınız ve ücretlendirme kuralları şu şekildedir:\n\n- Telefon kullanımı: 1.350 dakika kullandınız. Bölüm 2.1'e göre ilk 1.000 dakika ücrete dahildir. Ekstra 350 dakika için 1 adet ek 1.000 dakikalık blok ücreti olarak 10.00 US doları yansıtılmıştır (Bölüm 4.3).\n- İnternet kullanımı: 35 GB (35.000 MB) kullandınız. Bölüm 3.1'e göre aylık baz ücret 20 GB'a kadar 50.00 US dolarıdır. 20 GB üzerindeki kullanım için her 10 GB'lık ek blok başına ücret uygulanır; 35 GB kullanımınız için 2 ek blok (toplam 20.00 US doları) eklenmiş ve internet toplamı 70.00 US doları olmuştur (Bölüm 4.3).\n\nToplam tutar 80.00 US dolarıdır (Bölüm 4.3).",
    "reason": "llm"
  }
]
```

</details>
