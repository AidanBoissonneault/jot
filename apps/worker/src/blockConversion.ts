/**
 * @file Converts supported Tiptap document nodes to and from Notion block payloads.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import { normalizeCodeLanguage } from '../../../src/lib/codeLanguages.js';
import type { DocumentContent } from '../../../src/types/capture.js';
import type {
  JsonObject,
  NotionBlock,
  NotionBlockPayload,
  NotionRichText,
  NotionRichTextPayload,
} from './types.js';

/**
 * Converts a Tiptap document into Notion child-block payloads.
 * @param doc - Tiptap document to convert.
 * @returns One Notion payload for each top-level Tiptap node.
 */
export function tiptapDocumentToNotionBlocks(doc: DocumentContent): NotionBlockPayload[] {
  return (doc?.content ?? []).map((node) => tiptapNodeToNotionBlock(node));
}

/**
 * Checks whether a block references a Notion-managed file upload.
 * @param block - Notion block payload to inspect.
 * @returns Whether the image or audio block has a file-upload identifier.
 */
export function isNotionFileUploadBlock(block: NotionBlockPayload): boolean {
  const type = block?.type;
  const content = objectProperty(block, type);
  return (
    (type === 'image' || type === 'audio') &&
    Boolean(stringProperty(objectProperty(content, 'file_upload'), 'id'))
  );
}

/**
 * Converts one supported Tiptap node to its closest Notion block representation.
 * @param node - Tiptap node to convert.
 * @returns A Notion child-block payload.
 */
function tiptapNodeToNotionBlock(node: DocumentContent): NotionBlockPayload {
  const richText = inlineContentToRichText(node.content);

  if (node.type === 'heading') {
    const level = Math.min(3, Math.max(1, Number(node.attrs?.level ?? 2)));
    return {
      object: 'block',
      type: `heading_${level}`,
      [`heading_${level}`]: {
        rich_text: richText,
        color: 'default',
        is_toggleable: false,
      },
    };
  }

  if (node.type === 'blockquote') {
    return {
      object: 'block',
      type: 'quote',
      quote: {
        rich_text: richText,
        color: 'default',
      },
    };
  }

  if (node.type === 'codeBlock') {
    return {
      object: 'block',
      type: 'code',
      code: {
        rich_text: plainRichText(textFromNode(node)),
        language: normalizeCodeLanguage(node.attrs?.language),
      },
    };
  }

  if (node.type === 'bulletList' || node.type === 'orderedList') {
    const listItems = node.content ?? [];
    return {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: plainRichText(listItems.map((item) => `- ${textFromNode(item)}`).join('\n')),
        color: 'default',
      },
    };
  }

  if (node.type === 'taskList') {
    return {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: plainRichText(
          (node.content ?? [])
            .map((item) => `${item.attrs?.checked ? '[x]' : '[ ]'} ${textFromNode(item)}`)
            .join('\n'),
        ),
        color: 'default',
      },
    };
  }

  if (node.type === 'horizontalRule') {
    return {
      object: 'block',
      type: 'divider',
      divider: {},
    };
  }

  if (node.type === 'image') {
    const src = stringProperty(node.attrs, 'src');
    const fileUploadId = stringProperty(node.attrs, 'notionFileUploadId');

    if (fileUploadId) {
      return {
        object: 'block',
        type: 'image',
        image: { type: 'file_upload', file_upload: { id: fileUploadId } },
      };
    }

    if (!src || !/^https?:\/\//i.test(src)) {
      return paragraphFallback('');
    }

    return { object: 'block', type: 'image', image: { type: 'external', external: { url: src } } };
  }

  if (node.type === 'youtube') {
    const src = stringProperty(node.attrs, 'src');
    if (!src) return paragraphFallback('');
    const videoUrl = normalizeYoutubeVideoUrl(src);
    if (!videoUrl) return paragraphFallback('');

    // Keep playback as an Inkwell concern. A regular linked paragraph remains
    // usable in Notion clients and exports that do not support video embeds.
    return paragraphFallback([
      textNodeToRichText({
        type: 'text',
        text: videoUrl,
        marks: [{ type: 'link', attrs: { href: videoUrl } }],
      }),
    ]);
  }

  if (node.type === 'audio') {
    const src = stringProperty(node.attrs, 'src');
    const fileUploadId = stringProperty(node.attrs, 'notionFileUploadId');

    if (fileUploadId) {
      return {
        object: 'block',
        type: 'audio',
        audio: { type: 'file_upload', file_upload: { id: fileUploadId } },
      };
    }

    if (!src || !/^https?:\/\//i.test(src)) return paragraphFallback('');
    return { object: 'block', type: 'audio', audio: { type: 'external', external: { url: src } } };
  }

  return paragraphFallback(richText.length ? richText : plainRichText(''));
}

/**
 * Wraps rich text in a standard Notion paragraph payload.
 * @param richText - Plain text or pre-built Notion rich text.
 * @returns A paragraph block payload.
 */
function paragraphFallback(richText: string | NotionRichTextPayload[]): NotionBlockPayload {
  const rt = typeof richText === 'string' ? plainRichText(richText) : richText;
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: rt,
      color: 'default',
    },
  };
}

/**
 * Converts inline Tiptap content into Notion rich-text objects.
 * @param content - Inline Tiptap nodes.
 * @returns Converted Notion rich text.
 */
function inlineContentToRichText(content: DocumentContent[] = []): NotionRichTextPayload[] {
  const richText: NotionRichTextPayload[] = [];

  for (const node of content) {
    if (node.type === 'text') {
      richText.push(textNodeToRichText(node));
    } else if (node.type === 'hardBreak') {
      richText.push(...plainRichText('\n'));
    } else {
      richText.push(...inlineContentToRichText(node.content ?? []));
    }
  }

  return richText.length ? richText : [];
}

/**
 * Converts one Tiptap text node and its marks to Notion rich text.
 * @param node - Tiptap text node.
 * @returns A Notion rich-text object.
 */
function textNodeToRichText(node: DocumentContent): NotionRichTextPayload {
  const marks = node.marks ?? [];
  const link = stringProperty(marks.find((mark) => mark.type === 'link')?.attrs, 'href');
  const textStyle = marks.find((mark) => mark.type === 'textStyle')?.attrs ?? {};

  return {
    type: 'text',
    text: {
      content: node.text ?? '',
      ...(link ? { link: { url: link } } : {}),
    },
    annotations: {
      bold: marks.some((mark) => mark.type === 'bold'),
      italic: marks.some((mark) => mark.type === 'italic'),
      strikethrough: marks.some((mark) => mark.type === 'strike'),
      underline: marks.some((mark) => mark.type === 'underline'),
      code: marks.some((mark) => mark.type === 'code'),
      color: notionColor(textStyle.color),
    },
  };
}

/**
 * Creates unformatted Notion rich text.
 * @param text - Text content.
 * @returns A single-item Notion rich-text array.
 */
function plainRichText(text: string): NotionRichTextPayload[] {
  return [
    {
      type: 'text',
      text: {
        content: text,
      },
    },
  ];
}

/**
 * Converts supported Notion blocks to a Tiptap document, skipping unsupported blocks.
 * @param blocks - Notion blocks to convert.
 * @returns A Tiptap document.
 */
export function notionBlocksToTiptapDocument(blocks: NotionBlock[]): DocumentContent {
  return {
    type: 'doc',
    content: blocks.map(notionBlockToTiptapNode).filter(
      (node: DocumentContent | null): node is DocumentContent => node !== null,
    ),
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
    const url = block.image?.external?.url ?? block.image?.file?.url ?? block.image?.file_upload?.url;
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
    const url = block.audio?.external?.url ?? block.audio?.file?.url ?? block.audio?.file_upload?.url;
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
 * Recursively extracts plain text from a Tiptap node.
 * @param node - Tiptap node to traverse.
 * @returns Concatenated plain text.
 */
function textFromNode(node: DocumentContent): string {
  if (node.text) {
    return node.text;
  }

  if (node.type === 'hardBreak') {
    return '\n';
  }

  return (node.content ?? []).map(textFromNode).join('');
}

/**
 * Maps an editor color to Notion's supported annotation color.
 * @param color - Editor color attribute.
 * @returns The safe Notion color value.
 */
function notionColor(color: unknown): 'default' {
  return typeof color === 'string' && color ? 'default' : 'default';
}

/**
 * Normalizes supported YouTube URLs to a canonical watch URL.
 * @param src - Candidate YouTube URL.
 * @returns Canonical URL or an empty string when invalid.
 */
function normalizeYoutubeVideoUrl(src: string): string {
  try {
    const url = new URL(src);
    const host = url.hostname.toLowerCase();

    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id && /^[\w-]+$/.test(id) ? youtubeWatchUrl(id, url.searchParams) : '';
    }

    if (
      host !== 'youtube.com' &&
      !host.endsWith('.youtube.com') &&
      host !== 'youtube-nocookie.com' &&
      !host.endsWith('.youtube-nocookie.com')
    ) {
      return '';
    }

    const embedMatch = url.pathname.match(/^\/(?:embed|shorts|v)\/([\w-]+)/i);
    const id = url.searchParams.get('v') ?? embedMatch?.[1];

    if (!id) {
      return '';
    }

    return /^[\w-]+$/.test(id) ? youtubeWatchUrl(id, url.searchParams) : '';
  } catch {
    return '';
  }
}

/**
 * Builds a canonical YouTube watch URL and preserves its start time.
 * @param id - YouTube video identifier.
 * @param sourceParams - Query parameters from the source URL.
 * @returns Canonical watch URL.
 */
function youtubeWatchUrl(id: string, sourceParams: URLSearchParams): string {
  const url = new URL('https://www.youtube.com/watch');
  url.searchParams.set('v', id);

  const start = sourceParams.get('t') ?? sourceParams.get('start');
  if (start) {
    url.searchParams.set('t', start);
  }

  return url.toString();
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

/**
 * Reads an object-valued property from an unknown record.
 * @param value - Candidate record.
 * @param key - Property name.
 * @returns The nested object or an empty object.
 */
function objectProperty(value: unknown, key: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const property: unknown = (value as JsonObject)[key];
  return property && typeof property === 'object' && !Array.isArray(property)
    ? property as JsonObject
    : {};
}

/**
 * Reads a string property from an unknown record.
 * @param value - Candidate record.
 * @param key - Property name.
 * @returns The string property or undefined.
 */
function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property: unknown = (value as JsonObject)[key];
  return typeof property === 'string' ? property : undefined;
}

/**
 * Reads a rich-text array from an unknown record.
 * @param value - Candidate record.
 * @param key - Property name.
 * @returns The rich-text array, or an empty array.
 */
function richTextProperty(value: unknown, key: string): NotionRichText[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const property: unknown = (value as JsonObject)[key];
  return Array.isArray(property) ? property as NotionRichText[] : [];
}
