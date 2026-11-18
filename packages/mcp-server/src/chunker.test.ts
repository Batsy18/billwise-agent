import { readFileSync } from 'node:fs';
import { chunkGuide, type Chunk } from './chunker';
import { GUIDE_PATH } from './paths';

const guide = readFileSync(GUIDE_PATH, 'utf8');
const doc = chunkGuide(guide);
const bySection = (id: string): Chunk => {
  const c = doc.chunks.find((x) => x.section === id);
  if (!c) throw new Error(`no chunk ${id}`);
  return c;
};

describe('chunkGuide on the instructor guide', () => {
  it('keeps the document id from the header', () => {
    expect(doc.documentId).toBe('MOB-BILLING-2026-01');
  });

  it('produces every expected section id, in document order', () => {
    expect(doc.chunks.map((c) => c.section)).toEqual([
      'preamble',
      '1',
      '2.1', '2.2', '2.3',
      '3.1', '3.2', '3.3',
      '4.1', '4.2', '4.3', '4.4',
      '5.1', '5.2', '5.3',
      '6.1', '6.2', '6.3',
      '7.1', '7.2', '7.3',
      '8.1', '8.2', '8.3', '8.4',
      '9',
    ]); // prettier-ignore
  });

  it('### subsections carry heading + parent heading', () => {
    expect(bySection('3.2')).toMatchObject({
      heading: 'Additional internet blocks',
      parentHeading: '3. Internet pricing',
    });
    expect(bySection('3.2').text).toBe(
      'Each additional 10 GB block costs $10. A partially used additional block is charged as a full block. For example, 20 GB costs $50; 21 GB costs $60; 30 GB costs $60; 35 GB costs $70.',
    );
  });

  it('## sections without subsections are one chunk with no parent', () => {
    expect(bySection('1')).toMatchObject({ heading: 'Scope and terminology', parentHeading: '' });
    expect(bySection('9').heading).toBe('Guidance for AI/MCP implementation');
    expect(bySection('9').text).toContain('"section": "3.2"'); // code fence kept as text
  });

  it('the title block and disclaimer become the preamble', () => {
    const p = bySection('preamble');
    expect(p.heading).toBe('Mobile Provider Billing Guide');
    expect(p.text).toContain('Document ID: MOB-BILLING-2026-01');
    expect(p.text).toContain('The Billing REST API and its database are the authoritative sources');
  });

  it('strips **bold** markers but keeps `formula` backticks', () => {
    expect(bySection('2.1').text).toBe(
      'The first 1,000 minutes of phone calls in a billing month are free.',
    );
    expect(bySection('4.2').text).toContain('`$10 × ceil(max(0, minutes − 1000) / 1000)`');
  });

  it('loses no text: every content line of the guide is in exactly one chunk', () => {
    const norm = (s: string) => s.replace(/\*\*/g, '').replace(/^>\s?/, '').trim();
    const headingLine = /^#{1,3}\s/;
    const lines = guide
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((l) => l.trim() !== '' && !headingLine.test(l))
      .map(norm)
      .filter((l) => l !== '');
    for (const line of lines) {
      const holders = doc.chunks.filter((c) =>
        c.text
          .split('\n')
          .map((t) => t.trim())
          .includes(line),
      );
      expect({ line, holders: holders.length }).toEqual({ line, holders: 1 });
    }
  });
});

describe('chunkGuide edge cases', () => {
  const mini = [
    '# T',
    '',
    '**Document ID:** DOC-1',
    '',
    '## 1. Alpha',
    '',
    'Intro before any subsection.',
    '',
    '### 1.1 First',
    '',
    'One.',
    '',
    '```md',
    '### 9.9 Not a heading inside a fence',
    '```',
    '',
    '### 1.2 Second',
    '',
    'Two.',
  ];

  it('handles CRLF, keeps intro text of a ## section, ignores headings inside code fences', () => {
    const d = chunkGuide(mini.join('\r\n'));
    expect(d.chunks.map((c) => c.section)).toEqual(['preamble', '1', '1.1', '1.2']);
    expect(d.chunks[1]).toMatchObject({ heading: 'Alpha', text: 'Intro before any subsection.' });
    expect(d.chunks[2]?.text).toContain('### 9.9 Not a heading inside a fence');
  });

  it('fails without a Document ID line', () => {
    expect(() => chunkGuide('# T\n\n## 1. A\n\nx')).toThrow(/Document ID/);
  });
});
