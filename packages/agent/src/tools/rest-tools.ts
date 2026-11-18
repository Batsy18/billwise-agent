/**
 * REST tools offered to the LLM. Deliberately NO subscriberNo parameter anywhere: the
 * executor always uses the logged-in subscriber (JWT `sub`), so a number in the prompt can
 * never reach the API (vault note "MCP ve Agent" → Güvenlik kararı). Admin operations
 * (usage, calculate) are not exposed.
 */
import type { ToolDeclaration } from '../llm/types';

const period = {
  month: { type: 'integer', minimum: 1, maximum: 12, description: 'Billing month, 1–12' },
  year: { type: 'integer', minimum: 2000, maximum: 2100, description: 'Billing year, e.g. 2026' },
};

export const QUERY_BILL: ToolDeclaration = {
  name: 'query_bill',
  description:
    "Get the logged-in subscriber's STORED bill for a month: total, paid amount, remaining balance, status (UNPAID / PARTIALLY_PAID / PAID) and due date. Returns status 'not_calculated' if no bill exists yet.",
  parameters: {
    type: 'object',
    properties: period,
    required: ['month', 'year'],
    additionalProperties: false,
  },
};

export const QUERY_BILL_DETAILED: ToolDeclaration = {
  name: 'query_bill_detailed',
  description:
    "Get the logged-in subscriber's bill with usage (phone minutes, internet MB/GB) and the charge breakdown (included minutes, extra blocks, internet base and extra blocks), plus a page of usage events. Use this to explain WHY a bill is what it is.",
  parameters: {
    type: 'object',
    properties: {
      ...period,
      page: {
        type: 'integer',
        minimum: 1,
        description: 'Usage-event page (default 1); the breakdown is the same on every page',
      },
    },
    required: ['month', 'year'],
    additionalProperties: false,
  },
};

export const PAY_BILL: ToolDeclaration = {
  name: 'pay_bill',
  description:
    "Pay all or part of the logged-in subscriber's bill. The system itself shows the user a summary and asks for explicit confirmation before paying; do not ask for confirmation in your own words first. Report success only if the result status is 'paid'.",
  parameters: {
    type: 'object',
    properties: {
      ...period,
      amount: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'Amount in US dollars, at most 2 decimals',
      },
    },
    required: ['month', 'year', 'amount'],
    additionalProperties: false,
  },
};

export const REST_TOOLS: readonly ToolDeclaration[] = [QUERY_BILL, QUERY_BILL_DETAILED, PAY_BILL];
