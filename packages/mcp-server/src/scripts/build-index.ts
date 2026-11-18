/**
 * npm run build-index — chunk the guide, build the MiniSearch index and write it to
 * generated/search-index.json. Also runs as the second half of `npm run build`, so a fresh
 * clone or a Docker build gets an index without an extra step.
 */
import { readFileSync } from 'node:fs';
import { buildIndexFile, writeIndexFile } from '../index-file';
import { GUIDE_PATH, INDEX_PATH } from '../paths';

function main(): void {
  const file = buildIndexFile(readFileSync(GUIDE_PATH, 'utf8'));
  writeIndexFile(INDEX_PATH, file);
  console.log(
    `Indexed ${file.chunks.length} sections of ${file.documentId} (${file.document}) → ${INDEX_PATH}`,
  );
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
