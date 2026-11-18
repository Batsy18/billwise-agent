/**
 * The serialized search index (generated/search-index.json, gitignored).
 * Written by `npm run build-index` (also part of `npm run build`), loaded ONCE at server
 * startup. Loading fails fast instead of silently re-indexing: missing file, unknown format
 * version, or a guide whose hash no longer matches the one the index was built from.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import MiniSearch, { type AsPlainObject } from 'minisearch';
import { chunkGuide } from './chunker';
import { GUIDE_FILE_NAME } from './paths';
import {
  buildIndex,
  indexableChunks,
  MINISEARCH_OPTIONS,
  SearchEngine,
  type IndexedChunk,
} from './search';

export const INDEX_FORMAT_VERSION = 1;

export interface IndexFile {
  version: number;
  document: string;
  documentId: string;
  guideSha256: string;
  builtAt: string;
  chunks: IndexedChunk[];
  index: AsPlainObject;
}

export interface LoadedIndex {
  document: string;
  documentId: string;
  engine: SearchEngine;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function buildIndexFile(guideMarkdown: string, now: Date = new Date()): IndexFile {
  const doc = chunkGuide(guideMarkdown);
  return {
    version: INDEX_FORMAT_VERSION,
    document: GUIDE_FILE_NAME,
    documentId: doc.documentId,
    guideSha256: sha256(guideMarkdown),
    builtAt: now.toISOString(),
    chunks: indexableChunks(doc.chunks),
    index: buildIndex(doc.chunks).toJSON(),
  };
}

export function writeIndexFile(indexPath: string, file: IndexFile): void {
  mkdirSync(path.dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, JSON.stringify(file));
}

/** Load once at startup. `guidePath` is used only to verify the hash (no re-indexing). */
export function loadIndexFile(indexPath: string, guidePath: string): LoadedIndex {
  if (!existsSync(indexPath)) {
    throw new Error(
      `Search index not found at ${indexPath}. Run \`npm run build-index -w @billwise/mcp-server\`.`,
    );
  }
  let file: IndexFile;
  try {
    file = JSON.parse(readFileSync(indexPath, 'utf8')) as IndexFile;
  } catch (err) {
    throw new Error(`Search index at ${indexPath} is not valid JSON; rebuild it.`, { cause: err });
  }
  if (file.version !== INDEX_FORMAT_VERSION) {
    throw new Error(
      `Search index format ${file.version} is not ${INDEX_FORMAT_VERSION}; rebuild it.`,
    );
  }
  if (sha256(readFileSync(guidePath, 'utf8')) !== file.guideSha256) {
    throw new Error(
      'Search index is stale: the guide changed since it was built. Run `npm run build-index`.',
    );
  }
  const index = MiniSearch.loadJS<IndexedChunk>(file.index, MINISEARCH_OPTIONS);
  return {
    document: file.document,
    documentId: file.documentId,
    engine: new SearchEngine(index, file.chunks),
  };
}
