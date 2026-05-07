import assert from 'node:assert/strict';
import test from 'node:test';
import {
  notionBlocksToTiptapDocument,
  tiptapDocumentToNotionBlocks,
} from '../src/blockConversion.js';

test('tiptap hardBreak syncs to Notion rich text newline', () => {
  const blocks = tiptapDocumentToNotionBlocks({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Line one' },
          { type: 'hardBreak' },
          { type: 'text', text: 'Line two' },
        ],
      },
    ],
  });

  assert.deepEqual(blocks[0].paragraph.rich_text.map((item) => item.text.content), [
    'Line one',
    '\n',
    'Line two',
  ]);
});

test('Notion rich text newlines import as Tiptap hardBreak nodes', () => {
  const doc = notionBlocksToTiptapDocument([
    {
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            plain_text: 'Line one\nLine two',
            annotations: {},
          },
        ],
      },
    },
  ]);

  assert.deepEqual(doc.content[0].content, [
    { type: 'text', text: 'Line one' },
    { type: 'hardBreak' },
    { type: 'text', text: 'Line two' },
  ]);
});
