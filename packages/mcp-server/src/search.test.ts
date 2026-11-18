import { readFileSync } from 'node:fs';
import { chunkGuide } from './chunker';
import { GUIDE_PATH } from './paths';
import {
  EXCLUDED_SECTIONS,
  MIN_COVERAGE,
  MIN_SCORE,
  queryContentTerms,
  SearchEngine,
  tokenize,
} from './search';

const engine = SearchEngine.fromChunks(chunkGuide(readFileSync(GUIDE_PATH, 'utf8')).chunks);
const LIMIT = 5;

describe('index contents', () => {
  it('indexes every chunk except section 9 (developer guidance, not policy)', () => {
    expect(EXCLUDED_SECTIONS).toEqual(['9']);
    expect(engine.documentCount).toBe(25);
    expect(engine.topics.map((t) => t.section)).not.toContain('9');
  });

  it('"bill" is the only term in more than half of the indexed chunks', () => {
    expect([...engine.common]).toEqual(['bill']);
  });
});

describe('tokenize / query terms', () => {
  it('keeps contractions as one token and drops single-letter fragments', () => {
    expect(tokenize("I don't pay, can't wait")).toEqual(['dont', 'pay', 'cant', 'wait']);
  });

  it('removes stop words and stems', () => {
    expect(queryContentTerms('how is the bill calculated')).toEqual(['bill', 'calculat']);
  });
});

// Calibration set (ADR #27). The four retrieval queries of the vault note + six LLM-style ones.
// Top hit must be one of the expected sections and clear the gate.
describe.each([
  ['extra internet cost', ['3.2', '8.1']],
  ['pay part of my bill partial payment', ['5.1', '8.3']],
  ['dispute a charge deadline', ['7.1', '8.4']],
  ['service restricted unpaid', ['6.3']],
  ['free minutes included', ['2.1']],
  ['how is the bill calculated', ['4.2']],
  ['bill due date', ['6.1']],
  ['late payment fee', ['6.2']],
  ['can I get a refund', ['7.3']],
])('relevant: "%s"', (query, expected) => {
  it(`top hit is ${expected.join(' or ')} and passes the gate`, () => {
    const { hits, passedGate } = engine.search(query, LIMIT);
    expect(passedGate).toBe(true);
    expect(expected).toContain(hits[0]?.section);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(MIN_SCORE);
    expect(hits[0]!.coverage).toBeGreaterThanOrEqual(MIN_COVERAGE);
  });
});

it('known lexical limitation: "does the bill include tax" → 4.2 is within the top 5, not first', () => {
  const { hits, passedGate } = engine.search('does the bill include tax', LIMIT);
  expect(passedGate).toBe(true);
  expect(hits.map((h) => h.section)).toContain('4.2');
});

describe.each([
  'how do I bake a chocolate cake',
  'football match results',
  'weather forecast tomorrow',
  'who won the election',
  'best pizza recipe',
  'learn python programming',
  'cat',
  'translate hello to french',
  'stock market news',
  'what is the capital of France',
  'the and of',
])('irrelevant: "%s"', (query) => {
  it('returns no matches', () => {
    expect(engine.search(query, LIMIT).hits).toEqual([]);
  });
});

describe('gate mechanics', () => {
  it('blocks when the best hit covers too little of the query (football → 5.3 "Payment result")', () => {
    const raw = engine.rawSearch('football match results');
    expect(raw[0]).toMatchObject({ section: '5.3' });
    expect(raw[0]!.score).toBeGreaterThan(MIN_SCORE); // a score threshold alone would let it in
    expect(raw[0]!.coverage).toBeLessThan(MIN_COVERAGE);
    expect(engine.search('football match results', LIMIT)).toEqual({ hits: [], passedGate: false });
  });

  it('drops hits below MIN_SCORE even when the gate passes (election → fuzzy "select")', () => {
    const raw = engine.rawSearch('who won the election');
    expect(raw[0]!.coverage).toBeGreaterThanOrEqual(MIN_COVERAGE);
    expect(raw[0]!.score).toBeLessThan(MIN_SCORE);
    expect(engine.search('who won the election', LIMIT)).toEqual({ hits: [], passedGate: true });
  });

  it('respects the limit', () => {
    expect(engine.search('bill payment', 2).hits).toHaveLength(2);
  });
});
