import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import MiniSearch from 'minisearch';
import { buildIndexFile, loadIndexFile, writeIndexFile } from './index-file';
import { GUIDE_PATH } from './paths';

const guide = readFileSync(GUIDE_PATH, 'utf8');
const dir = mkdtempSync(path.join(tmpdir(), 'billwise-index-'));
const indexPath = path.join(dir, 'search-index.json');
writeIndexFile(indexPath, buildIndexFile(guide, new Date('2026-11-18T00:00:00Z')));

describe('index file', () => {
  it('round-trips: the loaded engine answers like a freshly built one', () => {
    const loaded = loadIndexFile(indexPath, GUIDE_PATH);
    expect(loaded).toMatchObject({
      document: 'Mobile_Provider_Billing_Guide.md',
      documentId: 'MOB-BILLING-2026-01',
    });
    expect(loaded.engine.documentCount).toBe(25);
    expect(loaded.engine.search('extra internet cost', 5).hits[0]?.section).toBe('8.1');
  });

  it('queries never index: no MiniSearch.add / addAll after loading', () => {
    const loaded = loadIndexFile(indexPath, GUIDE_PATH);
    const add = jest.spyOn(MiniSearch.prototype, 'add');
    const addAll = jest.spyOn(MiniSearch.prototype, 'addAll');
    for (const q of ['late payment fee', 'bill due date', 'refund', 'cake'])
      loaded.engine.search(q, 5);
    expect(add).not.toHaveBeenCalled();
    expect(addAll).not.toHaveBeenCalled();
  });

  it('fails fast when the index file is missing', () => {
    expect(() => loadIndexFile(path.join(dir, 'nope.json'), GUIDE_PATH)).toThrow(/build-index/);
  });

  it('fails fast when the guide changed since the index was built (stale)', () => {
    const changedGuide = path.join(dir, 'guide.md');
    writeFileSync(changedGuide, `${guide}\nextra line`);
    expect(() => loadIndexFile(indexPath, changedGuide)).toThrow(/stale/);
  });

  it('fails fast on a corrupt or wrong-version file', () => {
    const corrupt = path.join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{ not json');
    expect(() => loadIndexFile(corrupt, GUIDE_PATH)).toThrow(/not valid JSON/);
    const old = path.join(dir, 'old.json');
    writeFileSync(old, JSON.stringify({ version: 0 }));
    expect(() => loadIndexFile(old, GUIDE_PATH)).toThrow(/format/);
  });
});
