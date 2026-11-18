/**
 * Splits the billing guide into searchable chunks (vault note "MCP ve Agent" → İndeksleme):
 *   - every `### 3.2 Heading` subsection → one chunk (section "3.2", parent "3. Internet pricing")
 *   - a `## N. Heading` section without subsections (1, 9) → one chunk (section "N")
 *   - text of a `##` section before its first `###` (none in the guide today) → its own chunk,
 *     so nothing is silently dropped
 *   - the `#` title block + disclaimer → section "preamble"
 * Pure: string in, chunks out. Headings inside ``` code fences are ignored.
 */

export interface Chunk {
  /** "3.2", "1", or "preamble" */
  section: string;
  heading: string;
  /** "3. Internet pricing" for subsections, "" for top-level chunks */
  parentHeading: string;
  text: string;
}

export interface ChunkedDocument {
  documentId: string;
  title: string;
  chunks: Chunk[];
}

const H1 = /^#\s+(.+)$/;
const H2 = /^##\s+(\d+)\.\s+(.+)$/;
const H3 = /^###\s+(\d+\.\d+)\s+(.+)$/;
const FENCE = /^\s*```/;
const DOC_ID = /\*\*Document ID:\*\*\s*(\S+)/;

/** Inline cleanup for returned text: drop **bold** markers and the `>` of quotes. */
function cleanLine(line: string): string {
  return line.replace(/\*\*/g, '').replace(/^>\s?/, '').trimEnd();
}

/** Join lines, collapsing runs of blank lines to a single paragraph break. */
function joinText(lines: string[]): string {
  return lines
    .map(cleanLine)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkGuide(markdown: string): ChunkedDocument {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');

  const docId = DOC_ID.exec(markdown)?.[1];
  if (!docId) throw new Error('Guide has no "**Document ID:**" line in its header');

  const chunks: Chunk[] = [];
  let title = '';
  let current: { section: string; heading: string; parentHeading: string; lines: string[] } = {
    section: 'preamble',
    heading: '',
    parentHeading: '',
    lines: [],
  };
  let parent: { section: string; heading: string; hasSubsections: boolean } | null = null;
  let inFence = false;

  const flush = (alwaysKeep: boolean) => {
    const text = joinText(current.lines);
    if (text !== '' || alwaysKeep) {
      chunks.push({
        section: current.section,
        heading: current.heading,
        parentHeading: current.parentHeading,
        text,
      });
    }
  };

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const h1 = !inFence ? H1.exec(line) : null;
    const h2 = !inFence ? H2.exec(line) : null;
    const h3 = !inFence ? H3.exec(line) : null;

    if (h1 && current.section === 'preamble' && title === '') {
      title = h1[1]!.trim();
      current.heading = title;
      continue;
    }
    if (h2) {
      // Close the previous chunk. A ## section with no ### keeps its chunk even if empty.
      flush(current.section === parent?.section && !parent.hasSubsections);
      parent = { section: h2[1]!, heading: h2[2]!.trim(), hasSubsections: false };
      current = { section: parent.section, heading: parent.heading, parentHeading: '', lines: [] };
      continue;
    }
    if (h3) {
      if (!parent) throw new Error(`Subsection "${line}" appears before any ## section`);
      flush(false); // intro text of the ## section (if any) or the previous subsection
      parent.hasSubsections = true;
      current = {
        section: h3[1]!,
        heading: h3[2]!.trim(),
        parentHeading: `${parent.section}. ${parent.heading}`,
        lines: [],
      };
      continue;
    }
    current.lines.push(line);
  }
  flush(current.section === parent?.section && !parent.hasSubsections);

  return { documentId: docId, title, chunks };
}
