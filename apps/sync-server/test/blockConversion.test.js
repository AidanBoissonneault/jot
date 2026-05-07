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

test('tiptap http image syncs to Notion external image block', () => {
  const blocks = tiptapDocumentToNotionBlocks({
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: {
          src: 'https://example.com/image.png',
        },
      },
    ],
  });

  assert.deepEqual(blocks[0], {
    object: 'block',
    type: 'image',
    image: {
      type: 'external',
      external: {
        url: 'https://example.com/image.png',
      },
    },
  });
});

test('tiptap uploaded image syncs to Notion file_upload image block', () => {
  const blocks = tiptapDocumentToNotionBlocks({
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: {
          src: 'blob:local-preview',
          notionFileUploadId: 'upload-id',
        },
      },
    ],
  });

  assert.deepEqual(blocks[0], {
    object: 'block',
    type: 'image',
    image: {
      type: 'file_upload',
      file_upload: {
        id: 'upload-id',
      },
    },
  });
});

test('tiptap transient image sources do not sync as Notion image blocks', () => {
  const blocks = tiptapDocumentToNotionBlocks({
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: {
          src: 'blob:local-preview',
        },
      },
      {
        type: 'image',
        attrs: {
          src: 'data:image/png;base64,abc',
        },
      },
    ],
  });

  assert.deepEqual(blocks.map((block) => block.type), ['paragraph', 'paragraph']);
});

test('Notion file image imports as Tiptap image with file URL', () => {
  const doc = notionBlocksToTiptapDocument([
    {
      type: 'image',
      image: {
        type: 'file',
        file: {
          url: 'https://secure.notion-static.com/image.png',
        },
      },
    },
  ]);

  assert.deepEqual(doc.content, [
    {
      type: 'image',
      attrs: {
        src: 'https://secure.notion-static.com/image.png',
      },
    },
  ]);
});

test('tiptap YouTube syncs to Notion external video block', () => {
  const blocks = tiptapDocumentToNotionBlocks({
    type: 'doc',
    content: [
      {
        type: 'youtube',
        attrs: {
          src: 'https://youtu.be/dQw4w9WgXcQ?t=12',
        },
      },
    ],
  });

  assert.deepEqual(blocks[0], {
    object: 'block',
    type: 'video',
    video: {
      type: 'external',
      external: {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12',
      },
    },
  });
});

test('Notion video imports as Tiptap YouTube node', () => {
  const doc = notionBlocksToTiptapDocument([
    {
      type: 'video',
      video: {
        type: 'external',
        external: {
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        },
      },
    },
  ]);

  assert.deepEqual(doc.content, [
    {
      type: 'youtube',
      attrs: {
        src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      },
    },
  ]);
});

test('tiptap uploaded audio syncs to Notion file_upload audio block', () => {
  const blocks = tiptapDocumentToNotionBlocks({
    type: 'doc',
    content: [
      {
        type: 'audio',
        attrs: {
          src: 'blob:local-recording',
          notionFileUploadId: 'audio-upload-id',
        },
      },
    ],
  });

  assert.deepEqual(blocks[0], {
    object: 'block',
    type: 'audio',
    audio: {
      type: 'file_upload',
      file_upload: {
        id: 'audio-upload-id',
      },
    },
  });
});

test('tiptap transient audio sources do not sync as Notion audio blocks', () => {
  const blocks = tiptapDocumentToNotionBlocks({
    type: 'doc',
    content: [
      {
        type: 'audio',
        attrs: {
          src: 'blob:local-recording',
        },
      },
    ],
  });

  assert.equal(blocks[0].type, 'paragraph');
});
