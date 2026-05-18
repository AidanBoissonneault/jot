import { describe, expect, it } from 'vitest';
import {
  notionBlocksToTiptapDocument,
  notionBlocksToTiptapDocumentStrict,
} from '@/apps/worker/src/blockConversion';

// ─── helpers ────────────────────────────────────────────────────────────────

function richText(plain_text: string, annotations = {}) {
  return [{ plain_text, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, ...annotations } }];
}

// ─── notionBlockToTiptapNode (via notionBlocksToTiptapDocument) ──────────────

describe('notionBlockToTiptapNode', () => {
  it('converts heading_1 to heading node with level 1', () => {
    const doc = notionBlocksToTiptapDocument([
      { type: 'heading_1', heading_1: { rich_text: richText('Hello') } },
    ]);
    expect(doc.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
  });

  it('converts heading_2 and heading_3 with correct levels', () => {
    const doc = notionBlocksToTiptapDocument([
      { type: 'heading_2', heading_2: { rich_text: richText('H2') } },
      { type: 'heading_3', heading_3: { rich_text: richText('H3') } },
    ]);
    expect(doc.content[0].attrs.level).toBe(2);
    expect(doc.content[1].attrs.level).toBe(3);
  });

  it('converts quote block to blockquote node', () => {
    const doc = notionBlocksToTiptapDocument([
      { type: 'quote', quote: { rich_text: richText('Quoted') } },
    ]);
    expect(doc.content[0]).toMatchObject({ type: 'blockquote' });
    expect(doc.content[0].content[0].type).toBe('paragraph');
  });

  it('converts code block to codeBlock node', () => {
    const doc = notionBlocksToTiptapDocument([
      { type: 'code', code: { rich_text: [{ plain_text: 'const x = 1' }] } },
    ]);
    expect(doc.content[0]).toMatchObject({ type: 'codeBlock' });
  });

  it('converts divider block to horizontalRule node', () => {
    const doc = notionBlocksToTiptapDocument([{ type: 'divider' }]);
    expect(doc.content[0]).toMatchObject({ type: 'horizontalRule' });
  });

  it('converts image block with external URL to image node', () => {
    const doc = notionBlocksToTiptapDocument([
      { type: 'image', image: { external: { url: 'https://example.com/pic.png' } } },
    ]);
    expect(doc.content[0]).toMatchObject({ type: 'image', attrs: { src: 'https://example.com/pic.png' } });
  });

  it('converts image block with file URL to image node', () => {
    const doc = notionBlocksToTiptapDocument([
      { type: 'image', image: { file: { url: 'https://s3.amazonaws.com/img.jpg' } } },
    ]);
    expect(doc.content[0]).toMatchObject({ type: 'image', attrs: { src: 'https://s3.amazonaws.com/img.jpg' } });
  });

  it('converts video block to youtube node', () => {
    const doc = notionBlocksToTiptapDocument([
      { type: 'video', video: { external: { url: 'https://www.youtube.com/watch?v=abc123' } } },
    ]);
    expect(doc.content[0]).toMatchObject({ type: 'youtube' });
    expect(doc.content[0].attrs.src).toContain('youtube.com');
  });

  it('returns null for image block with no URL (strict mode drops it)', () => {
    const doc = notionBlocksToTiptapDocumentStrict([
      { type: 'image', image: {} },
    ]);
    expect(doc).toBeNull();
  });

  it('converts paragraph block to paragraph node', () => {
    const doc = notionBlocksToTiptapDocument([
      { type: 'paragraph', paragraph: { rich_text: richText('Hello world') } },
    ]);
    expect(doc.content[0]).toMatchObject({ type: 'paragraph' });
  });

  it('returns null for unknown block types (strict mode)', () => {
    const result = notionBlocksToTiptapDocumentStrict([{ type: 'table' }]);
    expect(result).toBeNull();
  });
});

// ─── richTextToTiptapInline (tested via paragraph conversion) ────────────────

describe('richTextToTiptapInline', () => {
  function inlineContent(richTextItems: object[]) {
    const doc = notionBlocksToTiptapDocument([
      { type: 'paragraph', paragraph: { rich_text: richTextItems } },
    ]);
    return doc.content[0].content;
  }

  it('converts plain text to a single text node', () => {
    const content = inlineContent(richText('Hello'));
    expect(content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('splits newlines into hardBreak + text nodes', () => {
    const content = inlineContent([{ plain_text: 'line1\nline2', annotations: {} }]);
    expect(content).toEqual([
      { type: 'text', text: 'line1' },
      { type: 'hardBreak' },
      { type: 'text', text: 'line2' },
    ]);
  });

  it('applies bold and italic marks', () => {
    const content = inlineContent([{
      plain_text: 'styled',
      annotations: { bold: true, italic: true, strikethrough: false, underline: false, code: false },
    }]);
    expect(content[0].marks).toEqual(
      expect.arrayContaining([{ type: 'bold' }, { type: 'italic' }]),
    );
  });

  it('strips inkwell_capture_id from plain_text', () => {
    const content = inlineContent([{
      plain_text: 'Hello inkwell_capture_id:abc-123',
      annotations: {},
    }]);
    expect(content[0].text).toBe('Hello');
  });

  it('returns undefined for empty rich text array', () => {
    const doc = notionBlocksToTiptapDocument([
      { type: 'paragraph', paragraph: { rich_text: [] } },
    ]);
    expect(doc.content[0].content).toBeUndefined();
  });
});
