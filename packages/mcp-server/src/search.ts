/**
 * Full-text search over the guide chunks with MiniSearch (BM25-style scoring).
 * The index is built ONCE (npm run build-index) and loaded once at startup; `search()` only
 * reads it.
 *
 * Relevance gate (ADR #27): a single score threshold cannot separate relevant from irrelevant
 * queries, because MiniSearch scores grow with the number of matched query terms and with
 * heading hits ("can I get a refund" → 7.3 scores 4.50, "football match results" → 5.3
 * "Payment result" scores 9.60). So:
 *   1. if the best hit matches fewer than MIN_COVERAGE of the query's content terms → []
 *   2. otherwise return the hits with score >= MIN_SCORE
 * An empty result tells the LLM there is no policy text to cite, instead of a weak section
 * it might present as policy.
 */
import MiniSearch, { type Options, type SearchOptions } from 'minisearch';
import type { Chunk } from './chunker';
import { stem } from './stem';

/**
 * Section 9 is implementation guidance for developers, not subscriber-facing policy; its
 * wording ("payment", "bill", "REST API") would compete with the real policy sections.
 * The chunker still produces it, the index skips it (Varsayımlar).
 */
export const EXCLUDED_SECTIONS: readonly string[] = ['9'];

/** Calibrated: weakest correct top hit 4.50 vs strongest gated irrelevant hit 1.39 (ADR #27). */
export const MIN_SCORE = 3.0;
/** Best hit must match at least half of the query's content terms (ADR #27). */
export const MIN_COVERAGE = 0.5;
/** Terms found in more than this share of indexed chunks are down-weighted (ADR #28). */
export const COMMON_TERM_SHARE = 0.5;
export const COMMON_TERM_WEIGHT = 0.3;

/**
 * Filler words that would otherwise match many chunks weakly ("my", "the", "what") and push
 * irrelevant queries over the gate. Domain words (bill, payment, internet…) stay.
 */
const STOP_WORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from get got has have how i if ' +
    'in into is it its me my of on or our please so than that the their them then there these ' +
    'this to was we were what when where which who why will with would you your'
  ).split(' '),
);

const defaultTokenize = MiniSearch.getDefault('tokenize') as (text: string) => string[];

/**
 * MiniSearch's tokenizer, except that contractions stay one token ("don't" → "dont",
 * "can't" → "cant") and single-character fragments are dropped. Without this "don't" became
 * the junk terms "don" + "t", which also lowered the query's coverage. Used for both indexing
 * and queries.
 */
export function tokenize(text: string): string[] {
  const joined = text.replace(/(\p{L})['’](\p{L})/gu, '$1$2');
  return defaultTokenize(joined).filter((t) => [...t].length > 1);
}

/** Index-time term processing: lowercase, drop stop words, stem. */
function indexTerm(term: string): string | null {
  const t = term.toLowerCase();
  return STOP_WORDS.has(t) ? null : stem(t);
}

/** Distinct content terms of a query, exactly as the search sees them. */
export function queryContentTerms(query: string): string[] {
  return [
    ...new Set(
      tokenize(query)
        .map(indexTerm)
        .filter((t): t is string => !!t),
    ),
  ];
}

export interface IndexedChunk extends Chunk {
  id: number;
}

export interface SearchHit {
  section: string;
  heading: string;
  parentHeading: string;
  text: string;
  score: number;
  /** Share of the query's content terms this hit matched (0–1). */
  coverage: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** True when the gate let the query through (best hit covered enough of the query). */
  passedGate: boolean;
}

/** Fuzzy only on longer terms: on short ones a single edit turns unrelated words into guide
 * words ("bake"/"cake" → "make"). Terms arrive here already stemmed. */
const BASE_SEARCH_OPTIONS: SearchOptions = {
  boost: { heading: 2 },
  prefix: true,
  fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
  combineWith: 'OR',
  tokenize,
};

/** Options shared by build and load; MiniSearch requires identical ones on both sides. */
export const MINISEARCH_OPTIONS: Options<IndexedChunk> = {
  idField: 'id',
  fields: ['heading', 'parentHeading', 'text'],
  storeFields: ['section', 'heading', 'parentHeading', 'text'],
  tokenize,
  processTerm: indexTerm,
  searchOptions: BASE_SEARCH_OPTIONS,
};

export function indexableChunks(chunks: readonly Chunk[]): IndexedChunk[] {
  return chunks
    .filter((c) => !EXCLUDED_SECTIONS.includes(c.section))
    .map((c, i) => ({ ...c, id: i }));
}

export function buildIndex(chunks: readonly Chunk[]): MiniSearch<IndexedChunk> {
  const ms = new MiniSearch<IndexedChunk>(MINISEARCH_OPTIONS);
  ms.addAll(indexableChunks(chunks));
  return ms;
}

export function loadIndex(serialized: string): MiniSearch<IndexedChunk> {
  return MiniSearch.loadJSON<IndexedChunk>(serialized, MINISEARCH_OPTIONS);
}

/** Terms present in more than COMMON_TERM_SHARE of the indexed chunks ("bill": 21 of 25). */
export function commonTerms(chunks: readonly IndexedChunk[]): Set<string> {
  const df = new Map<string, number>();
  for (const c of chunks) {
    const terms = tokenize(`${c.heading} ${c.parentHeading} ${c.text}`).map(indexTerm);
    for (const t of new Set(terms)) if (t) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return new Set([...df].filter(([, n]) => n / chunks.length > COMMON_TERM_SHARE).map(([t]) => t));
}

export interface SearchEngineOptions {
  minScore?: number;
  minCoverage?: number;
}

export class SearchEngine {
  private readonly searchOptions: SearchOptions;
  readonly common: ReadonlySet<string>;

  /** `chunks` must be the chunks the index was built from (used once for term statistics). */
  constructor(
    private readonly index: MiniSearch<IndexedChunk>,
    private readonly indexed: readonly IndexedChunk[],
    private readonly opts: SearchEngineOptions = {},
  ) {
    this.common = commonTerms(indexed);
    this.searchOptions = {
      ...BASE_SEARCH_OPTIONS,
      boostTerm: (term) => (this.common.has(term) ? COMMON_TERM_WEIGHT : 1),
    };
  }

  static fromChunks(chunks: readonly Chunk[], opts?: SearchEngineOptions): SearchEngine {
    return new SearchEngine(buildIndex(chunks), indexableChunks(chunks), opts);
  }

  /** All hits, best first, no gate (calibration and debugging). */
  rawSearch(query: string): SearchHit[] {
    const n = queryContentTerms(query).length;
    if (n === 0) return [];
    return this.index.search(query, this.searchOptions).map((r) => ({
      section: r.section as string,
      heading: r.heading as string,
      parentHeading: r.parentHeading as string,
      text: r.text as string,
      score: r.score,
      coverage: r.queryTerms.length / n,
    }));
  }

  /** Gated search: see the module comment. */
  search(query: string, limit: number): SearchResult {
    const all = this.rawSearch(query);
    const best = all[0];
    const minCoverage = this.opts.minCoverage ?? MIN_COVERAGE;
    const minScore = this.opts.minScore ?? MIN_SCORE;
    if (!best || best.coverage < minCoverage) return { hits: [], passedGate: false };
    return { hits: all.filter((h) => h.score >= minScore).slice(0, limit), passedGate: true };
  }

  /** Indexed sections in document order, e.g. { section: "7.1", heading: "Dispute window" }. */
  get topics(): readonly { section: string; heading: string; parentHeading: string }[] {
    return this.indexed.map(({ section, heading, parentHeading }) => ({
      section,
      heading,
      parentHeading,
    }));
  }

  get documentCount(): number {
    return this.index.documentCount;
  }
}
