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
});
