import { describe, expect, it } from 'vitest';
import {
  isNotionFileUploadBlock,
  notionBlocksToTiptapDocument,
  notionBlocksToTiptapDocumentStrict,
  tiptapDocumentToNotionBlocks,
} from '@/apps/worker/src/blockConversion';

describe('Notion media blocks', () => {
  it('identifies uploads that must be retried instead of replaced by a fallback', () => {
    expect(isNotionFileUploadBlock({
      type: 'image',
      image: { type: 'file_upload', file_upload: { id: 'upload-1' } },
    })).toBe(true);
    expect(isNotionFileUploadBlock({
      type: 'image',
      image: { type: 'external', external: { url: 'https://example.com/image.png' } },
    })).toBe(false);
    expect(isNotionFileUploadBlock({ type: 'paragraph', paragraph: {} })).toBe(false);
  });
});

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

  it('converts heading_2, heading_3, and heading_4 with correct levels', () => {
    const doc = notionBlocksToTiptapDocument([
      { type: 'heading_2', heading_2: { rich_text: richText('H2') } },
      { type: 'heading_3', heading_3: { rich_text: richText('H3') } },
      { type: 'heading_4', heading_4: { rich_text: richText('H4') } },
    ]);
    expect(doc.content[0].attrs.level).toBe(2);
    expect(doc.content[1].attrs.level).toBe(3);
    expect(doc.content[2].attrs.level).toBe(4);
  });

  it('converts quote block to blockquote node', () => {
    const doc = notionBlocksToTiptapDocument([
      { type: 'quote', quote: { rich_text: richText('Quoted') } },
    ]);
    expect(doc.content[0]).toMatchObject({ type: 'blockquote' });
    expect(doc.content[0].content[0].type).toBe('paragraph');
  });

  it('converts code block to codeBlock node and preserves its language', () => {
    const doc = notionBlocksToTiptapDocument([
      {
        type: 'code',
        code: { language: 'javascript', rich_text: [{ plain_text: 'const x = 1' }] },
      },
    ]);
    expect(doc.content[0]).toMatchObject({
      type: 'codeBlock',
      attrs: { language: 'javascript' },
    });
  });

  it('sends a code block language to Notion', () => {
    const [block] = tiptapDocumentToNotionBlocks({
      type: 'doc',
      content: [{
        type: 'codeBlock',
        attrs: { language: 'typescript' },
        content: [{ type: 'text', text: 'const answer: number = 42' }],
      }],
    });

    expect(block).toMatchObject({
      type: 'code',
      code: { language: 'typescript' },
    });
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
      { id: 'notion-image-block', type: 'image', image: { file: { url: 'https://s3.amazonaws.com/img.jpg' } } },
    ]);
    expect(doc.content[0]).toMatchObject({
      type: 'image',
      attrs: {
        src: 'https://s3.amazonaws.com/img.jpg',
        notionBlockId: 'notion-image-block',
      },
    });
  });

  it('preserves image captions and upload identity when converting a file upload', () => {
    const doc = notionBlocksToTiptapDocument([{
      id: 'image-block',
      type: 'image',
      image: {
        file_upload: { id: 'upload-1', url: 'https://example.com/upload.png' },
        caption: richText('Alt text'),
      },
    }]);

    expect(doc.content[0]).toMatchObject({
      type: 'image',
      attrs: {
        src: 'https://example.com/upload.png',
        caption: [{ type: 'text', text: 'Alt text' }],
        notionFileUploadId: 'upload-1',
        uploadState: 'done',
        notionBlockId: 'image-block',
      },
    });
  });

  it('converts video block to youtube node', () => {
    const doc = notionBlocksToTiptapDocument([
      { type: 'video', video: { external: { url: 'https://www.youtube.com/watch?v=abc123' } } },
    ]);
    expect(doc.content[0]).toMatchObject({ type: 'youtube' });
    expect(doc.content[0].attrs.src).toContain('youtube.com');
  });

  it('uses embed and audio URLs from their supported Notion fields', () => {
    const doc = notionBlocksToTiptapDocument([
      { type: 'embed', embed: { url: 'https://www.youtube.com/watch?v=embed' } },
      {
        id: 'audio-block',
        type: 'audio',
        audio: { file_upload: { url: 'https://example.com/audio.mp3' } },
      },
    ]);

    expect(doc.content).toEqual([
      { type: 'youtube', attrs: { src: 'https://www.youtube.com/watch?v=embed' } },
      { type: 'audio', attrs: { src: 'https://example.com/audio.mp3', notionBlockId: 'audio-block' } },
    ]);
  });

  it('skips media blocks without a URL', () => {
    expect(notionBlocksToTiptapDocument([
      { type: 'video', video: {} },
      { type: 'audio', audio: {} },
    ]).content).toEqual([]);
  });

  it('converts an Jottathing YouTube video to a normal linked Notion paragraph', () => {
    const [block] = tiptapDocumentToNotionBlocks({
      type: 'doc',
      content: [{
        type: 'youtube',
        attrs: { src: 'https://youtu.be/abc123?t=1m2s' },
      }],
    });

    expect(block.type).toBe('paragraph');
    expect(block.paragraph.rich_text).toEqual([
      expect.objectContaining({
        type: 'text',
        text: {
          content: 'https://www.youtube.com/watch?v=abc123&t=1m2s',
          link: { url: 'https://www.youtube.com/watch?v=abc123&t=1m2s' },
        },
      }),
    ]);
  });

  it('restores an Jottathing YouTube video from its linked Notion paragraph', () => {
    const url = 'https://www.youtube.com/watch?v=abc123&t=62';
    const doc = notionBlocksToTiptapDocument([{
      type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          plain_text: url,
          href: url,
          text: { content: url, link: { url } },
          annotations: {},
        }],
      },
    }]);

    expect(doc.content[0]).toEqual({ type: 'youtube', attrs: { src: url } });
  });

  it('keeps a paragraph when its linked YouTube text differs from the URL', () => {
    const doc = notionBlocksToTiptapDocument([{
      type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          plain_text: 'Watch this video',
          href: 'https://www.youtube.com/watch?v=abc123',
          text: {
            content: 'Watch this video',
            link: { url: 'https://www.youtube.com/watch?v=abc123' },
          },
          annotations: {},
        }],
      },
    }]);

    expect(doc.content[0].type).toBe('paragraph');
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

  it('strips jottathing_capture_id from plain_text', () => {
    const content = inlineContent([{
      plain_text: 'Hello jottathing_capture_id:abc-123',
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

describe('tiptapNodeToNotionBlock edge cases', () => {
  const listItem = (text: string) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const taskItem = (text: string, checked: boolean) => ({
    type: 'taskItem',
    attrs: { checked },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

  it('clamps heading levels and serializes lists and dividers', () => {
    const blocks = tiptapDocumentToNotionBlocks({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 0 } },
        { type: 'heading', attrs: { level: 8 } },
        { type: 'bulletList', content: [listItem('One')] },
        { type: 'orderedList', content: [listItem('Two')] },
        {
          type: 'taskList',
          content: [taskItem('Done', true), taskItem('Later', false)],
        },
        { type: 'horizontalRule' },
      ],
    });

    expect(blocks.map((block) => block.type)).toEqual([
      'heading_1',
      'heading_4',
      'paragraph',
      'paragraph',
      'paragraph',
      'divider',
    ]);
    expect(blocks[2].paragraph.rich_text[0].text.content).toBe('- One');
    expect(blocks[3].paragraph.rich_text[0].text.content).toBe('- Two');
    expect(blocks[4].paragraph.rich_text[0].text.content).toBe('[x] Done\n[ ] Later');
  });

  it('keeps upload IDs ahead of URLs and falls back for invalid media URLs', () => {
    const [image, invalidImage, audio, uploadedAudio, invalidAudio] = tiptapDocumentToNotionBlocks({
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: {
            src: 'https://example.com/image.png',
            notionFileUploadId: 'image-upload',
            caption: ' Caption ',
          },
        },
        { type: 'image', attrs: { src: 'data:image/png;base64,abc' } },
        { type: 'audio', attrs: { src: 'https://example.com/audio.mp3' } },
        {
          type: 'audio',
          attrs: { src: 'https://example.com/ignored.mp3', notionFileUploadId: 'audio-upload' },
        },
        { type: 'audio', attrs: { src: 'javascript:alert(1)' } },
      ],
    });

    expect(image.image).toMatchObject({
      type: 'file_upload',
      file_upload: { id: 'image-upload' },
      caption: [{ text: { content: 'Caption' } }],
    });
    expect(invalidImage).toMatchObject({
      type: 'paragraph',
      paragraph: { rich_text: [{ text: { content: '' } }] },
    });
    expect(audio).toMatchObject({
      type: 'audio',
      audio: { type: 'external', external: { url: 'https://example.com/audio.mp3' } },
    });
    expect(uploadedAudio).toMatchObject({
      type: 'audio',
      audio: { type: 'file_upload', file_upload: { id: 'audio-upload' } },
    });
    expect(invalidAudio).toMatchObject({
      type: 'paragraph',
      paragraph: { rich_text: [{ text: { content: '' } }] },
    });
  });

  it('preserves links and formatting while using Notion default text color', () => {
    const [block] = tiptapDocumentToNotionBlocks({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'styled',
          marks: [
            { type: 'bold' },
            { type: 'italic' },
            { type: 'strike' },
            { type: 'underline' },
            { type: 'code' },
            { type: 'link', attrs: { href: 'https://example.com' } },
            { type: 'textStyle', attrs: { color: '#ff0000' } },
          ],
        }],
      }],
    });

    expect(block.paragraph.rich_text[0]).toMatchObject({
      text: { content: 'styled', link: { url: 'https://example.com' } },
      annotations: {
        bold: true,
        italic: true,
        strikethrough: true,
        underline: true,
        code: true,
        color: 'default',
      },
    });
  });

  it('keeps unsupported node text and splits long code into Notion-safe chunks', () => {
    const longCode = 'x'.repeat(4_001);
    const [fallback, code] = tiptapDocumentToNotionBlocks({
      type: 'doc',
      content: [
        {
          type: 'customWidget',
          content: [
            { type: 'text', text: 'Keep me' },
            { type: 'hardBreak' },
            { type: 'text', text: 'too' },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: longCode }] },
      ],
    });

    expect(fallback.paragraph.rich_text.map((item) => item.text.content)).toEqual(['Keep me', '\n', 'too']);
    expect(code.code.rich_text.map((item) => item.text.content.length)).toEqual([2_000, 2_000, 1]);
  });
});
