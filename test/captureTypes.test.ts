import { describe, expect, it } from 'vitest';
import { tiptapDocumentToNotionBlocks } from '@/apps/worker/src/blockConversion';
import { createCapturedContent } from '@/src/services/notionClient';
import type { CaptureSelectionPayload } from '@/src/types/messages';

function capture(
  sourceBlockType: NonNullable<CaptureSelectionPayload['highlightMeta']['sourceBlockType']>,
): CaptureSelectionPayload {
  return {
    text: 'Captured item',
    sourceUrl: 'https://example.com/article',
    pageTitle: 'Example article',
    highlightMeta: {
      text: 'Captured item',
      sourceBlockType,
      isHeading: sourceBlockType === 'heading',
      headingLevel: sourceBlockType === 'heading' ? 1 : undefined,
      isCodeBlock: sourceBlockType === 'codeBlock',
    },
  };
}

describe('captured source block types', () => {
  it('keeps a source paragraph as a paragraph through Notion conversion', () => {
    const content = createCapturedContent(capture('paragraph'));

    expect(content[0]).toMatchObject({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Captured item' }],
    });
    expect(tiptapDocumentToNotionBlocks({ type: 'doc', content: [content[0]] } )[0])
      .toMatchObject({
        type: 'paragraph',
        paragraph: {
          rich_text: [expect.objectContaining({ text: { content: 'Captured item' } })],
        },
      });
  });

  it('keeps a source blockquote as a Notion quote', () => {
    const content = createCapturedContent(capture('blockquote'));

    expect(content[0]).toMatchObject({
      type: 'blockquote',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'Captured item' }],
      }],
    });
    expect(tiptapDocumentToNotionBlocks({ type: 'doc', content: [content[0]] })[0])
      .toMatchObject({ type: 'quote', quote: { rich_text: [expect.any(Object)] } });
  });

  it('keeps a preformatted source block as Notion code with its language', () => {
    const payload = capture('codeBlock');
    payload.highlightMeta.codeLanguage = 'js';
    const content = createCapturedContent(payload);

    expect(content[0]).toMatchObject({
      type: 'codeBlock',
      attrs: { language: 'javascript' },
      content: [{ type: 'text', text: 'Captured item' }],
    });
    expect(tiptapDocumentToNotionBlocks({ type: 'doc', content: [content[0]] })[0])
      .toMatchObject({
        type: 'code',
        code: { language: 'javascript', rich_text: [expect.any(Object)] },
      });
  });
});
