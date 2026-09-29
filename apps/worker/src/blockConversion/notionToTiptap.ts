/** @file Converts Notion blocks and rich text into supported Tiptap document nodes. */
import { normalizeCodeLanguage } from '../../../../src/lib/codeLanguages.js';
import type { DocumentContent } from '../../../../src/types/capture.js';
import type { NotionBlock, NotionBlockPayload, NotionRichText } from '../types.js';
import { objectProperty, richTextProperty, stringProperty } from './valueReaders.js';
import { normalizeYoutubeVideoUrl, youtubeWatchUrl } from './youtubeUrls.js';
/**
 * Converts supported Notion blocks to a Tiptap document, skipping unsupported blocks.
 * @param blocks - Notion blocks to convert.
 * @returns A Tiptap document.
 */
export function notionBlocksToTiptapDocument(blocks: NotionBlock[]): DocumentContent {
  return {
    type: 'doc',
    content: blocks
      .map(notionBlockToTiptapNode)
      .filter((node: DocumentContent | null): node is DocumentContent => node !== null),
  };
}

/**
 * Converts Notion blocks only when every block has a safe Tiptap representation.
 * @param blocks - Notion blocks to convert.
 * @returns A Tiptap document, or null when a block is unsupported.
 */
export function notionBlocksToTiptapDocumentStrict(blocks: NotionBlock[]): DocumentContent | null {
  const content: DocumentContent[] = [];

  for (const block of blocks) {
    const node = notionBlockToTiptapNode(block);

    if (!node) {
      return null;
    }

    content.push(node);
  }

  return {
    type: 'doc',
    content,
  };
}

/**
 * Converts one Notion block to a Tiptap node.
 * @param block - Notion block to convert.
 * @returns The converted node, or null for unsupported blocks.
 */
function notionBlockToTiptapNode(block: NotionBlock): DocumentContent | null {
  if (block.type?.startsWith('heading_')) {
    return {
      type: 'heading',
      attrs: {
        level: Number(block.type.replace('heading_', '')),
      },
      content: richTextToTiptapInline(
        richTextProperty(objectProperty(block, block.type), 'rich_text'),
      ),
    };
  }

  if (block.type === 'quote') {
    return {
      type: 'blockquote',
      content: [
        {
          type: 'paragraph',
          content: richTextToTiptapInline(block.quote.rich_text),
        },
      ],
    };
  }

  if (block.type === 'code') {
    return {
      type: 'codeBlock',
      attrs: {
        language: normalizeCodeLanguage(block.code.language),
      },
      content: plainTiptapText(block.code.rich_text.map((text) => text.plain_text).join('')),
    };
  }

  if (block.type === 'divider') {
    return {
      type: 'horizontalRule',
    };
  }

  if (block.type === 'image') {
    const url =
      block.image?.external?.url ?? block.image?.file?.url ?? block.image?.file_upload?.url;
    if (!url) return null;
    return {
      type: 'image',
      attrs: {
        src: url,
        ...(block.id ? { notionBlockId: block.id } : {}),
      },
    };
  }

  if (block.type === 'video' || block.type === 'embed') {
    const data = block[block.type];
    const url = data?.external?.url ?? data?.url ?? data?.file?.url;
    if (!url) return null;
    return { type: 'youtube', attrs: { src: url } };
  }

  if (block.type === 'audio') {
    const url =
      block.audio?.external?.url ?? block.audio?.file?.url ?? block.audio?.file_upload?.url;
    if (!url) return null;
    return {
      type: 'audio',
      attrs: {
        src: url,
        ...(block.id ? { notionBlockId: block.id } : {}),
      },
    };
  }

  if (block.type !== 'paragraph') {
    return null;
  }

  const youtubeUrl = youtubeUrlFromLinkedParagraph(block.paragraph.rich_text);
  if (youtubeUrl) {
    return { type: 'youtube', attrs: { src: youtubeUrl } };
  }

  return {
    type: 'paragraph',
    content: richTextToTiptapInline(block.paragraph.rich_text),
  };
}

/**
 * Extracts a YouTube URL from a paragraph containing one self-linked URL.
 * @param richText - Notion paragraph rich text.
 * @returns A normalized watch URL or an empty string.
 */
function youtubeUrlFromLinkedParagraph(richText: NotionRichText[] = []): string {
  if (richText.length !== 1) {
    return '';
  }

  const item = richText[0];
  const textObject = objectProperty(item, 'text');
  const href = item.href ?? stringProperty(objectProperty(textObject, 'link'), 'url');
  const text = item.plain_text || stringProperty(textObject, 'content');

  if (!href || text !== href) {
    return '';
  }

  return normalizeYoutubeVideoUrl(href);
}

/**
 * Converts Notion rich text into Tiptap inline nodes.
 * @param richText - Notion rich-text array.
 * @returns Tiptap inline nodes, or undefined for empty content.
 */
function richTextToTiptapInline(richText: NotionRichText[] = []): DocumentContent[] | undefined {
  const content: DocumentContent[] = [];

  for (const item of richText) {
    const plainText = String(item.plain_text ?? '').replace(/\s*inkwell_capture_id:[\w-]+/g, '');

    if (!plainText) {
      continue;
    }

    const marks = marksFromRichText(item);
    const parts = plainText.split('\n');

    parts.forEach((part, index) => {
      if (index > 0) {
        content.push({ type: 'hardBreak' });
      }

      if (part) {
        content.push({
          type: 'text',
          text: part,
          ...(marks.length ? { marks } : {}),
        });
      }
    });
  }

  return content.length ? content : undefined;
}

/**
 * Converts Notion annotations and links to Tiptap marks.
 * @param item - Notion rich-text item.
 * @returns Tiptap marks in stable order.
 */
function marksFromRichText(item: NotionRichText): NonNullable<DocumentContent['marks']> {
  const marks: NonNullable<DocumentContent['marks']> = [];
  const annotations = item.annotations ?? {};

  if (annotations.bold) marks.push({ type: 'bold' });
  if (annotations.italic) marks.push({ type: 'italic' });
  if (annotations.strikethrough) marks.push({ type: 'strike' });
  if (annotations.underline) marks.push({ type: 'underline' });
  if (annotations.code) marks.push({ type: 'code' });
  if (item.href) marks.push({ type: 'link', attrs: { href: item.href } });

  return marks;
}

/**
 * Creates a plain Tiptap text node array.
 * @param text - Text content.
 * @returns A one-node array, or undefined for empty text.
 */
function plainTiptapText(text: string): DocumentContent[] | undefined {
  return text
    ? [
        {
          type: 'text',
          text,
        },
      ]
    : undefined;
}

/**
 * Classifies a Notion block for mapping compatibility decisions.
 * @param block - Notion block or outbound block payload.
 * @returns Stable Inkwell block category.
 */
export function kindFromNotionBlock(block: Pick<NotionBlockPayload, 'type'>): string {
  if (block.type?.startsWith('heading_')) return 'heading';
  if (block.type === 'quote') return 'quote';
  if (['image', 'video', 'audio', 'embed', 'file'].includes(block.type)) return 'media';
  return block.type === 'paragraph' ? 'paragraph' : 'source';
}
