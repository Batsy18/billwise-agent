/**
 * Tiny English suffix stemmer so word forms meet in the index:
 * calculated / calculation / calculates / calculate → "calculat", taxes → "tax",
 * charges / charged / charge → "charg". Applied to both indexed text and queries, so it only
 * has to be consistent, not linguistically perfect. The first matching rule wins, and only if
 * at least MIN_STEM letters remain (fee / fees both stay "fee"; due stays "due").
 */
const RULES: readonly [suffix: string, replacement: string][] = [
  ['ies', 'y'],
  ['ions', ''],
  ['ion', ''],
  ['ings', ''],
  ['ing', ''],
  ['ed', ''],
  ['es', ''],
  ['s', ''],
  ['e', ''],
];
const MIN_STEM = 3;

export function stem(word: string): string {
  for (const [suffix, replacement] of RULES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= MIN_STEM) {
      return word.slice(0, word.length - suffix.length) + replacement;
    }
  }
  return word;
}
