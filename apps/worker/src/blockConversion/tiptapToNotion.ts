/** @file Converts local Tiptap nodes and formatting into Notion block payloads. */
import { normalizeCodeLanguage } from '../../../../src/lib/codeLanguages.js';
import type { DocumentContent } from '../../../../src/types/capture.js';
import type { NotionBlockPayload, NotionRichTextPayload } from '../types.js';
import { objectProperty, stringProperty } from './valueReaders.js';
import { normalizeYoutubeVideoUrl } from './youtubeUrls.js';
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

type TiptapNodeConverter = (node: DocumentContent) => NotionBlockPayload;

// Nodes without a specialized writer become ordinary paragraphs.
const tiptapNodeConverters: Partial<Record<string, TiptapNodeConverter>> = {
  heading: headingBlock,
  blockquote: quoteBlock,
  codeBlock: codeBlock,
  bulletList: listBlock,
  orderedList: listBlock,
  taskList: taskListBlock,
  horizontalRule: () => ({ object: 'block', type: 'divider', divider: {} }),
  image: imageBlock,
  youtube: youtubeBlock,
  audio: audioBlock,
};

/**
 * Converts one supported Tiptap node to its closest Notion block representation.
 * @param node - Tiptap node to convert.
 * @returns A Notion child-block payload.
 */
function tiptapNodeToNotionBlock(node: DocumentContent): NotionBlockPayload {
  const converter = node.type ? tiptapNodeConverters[node.type] : undefined;
  return converter?.(node) ?? fallbackBlock(node);
}

function headingBlock(node: DocumentContent): NotionBlockPayload {
  // Notion's current block API supports headings 1 through 4.
  const level = Math.min(4, Math.max(1, Number(node.attrs?.level ?? 2)));
  return {
    object: 'block',
    type: `heading_${level}`,
    [`heading_${level}`]: {
      rich_text: inlineContentToRichText(node.content),
      color: 'default',
      is_toggleable: false,
    },
  };
}

function quoteBlock(node: DocumentContent): NotionBlockPayload {
  return {
    object: 'block',
    type: 'quote',
    quote: { rich_text: inlineContentToRichText(node.content), color: 'default' },
  };
}

function codeBlock(node: DocumentContent): NotionBlockPayload {
  return {
    object: 'block',
    type: 'code',
    code: {
      rich_text: plainRichText(textFromNode(node)),
      language: normalizeCodeLanguage(node.attrs?.language),
    },
  };
}

function listBlock(node: DocumentContent): NotionBlockPayload {
  const items = node.content ?? [];
  return paragraphFallback(plainRichText(items.map((item) => `- ${textFromNode(item)}`).join('\n')));
}

function taskListBlock(node: DocumentContent): NotionBlockPayload {
  const items = (node.content ?? [])
    .map((item) => `${item.attrs?.checked ? '[x]' : '[ ]'} ${textFromNode(item)}`)
    .join('\n');
  return paragraphFallback(plainRichText(items));
}

function imageBlock(node: DocumentContent): NotionBlockPayload {
  const src = stringProperty(node.attrs, 'src');
  const fileUploadId = stringProperty(node.attrs, 'notionFileUploadId');
  const rawCaption = node.attrs?.caption;
  const caption = Array.isArray(rawCaption)
    ? inlineContentToRichText(rawCaption as DocumentContent[])
    : typeof rawCaption === 'string' && rawCaption.trim()
      ? plainRichText(rawCaption.trim())
      : [];
  const captionPayload = caption.length ? { caption } : {};

  if (fileUploadId) {
    return {
      object: 'block',
      type: 'image',
      image: { type: 'file_upload', file_upload: { id: fileUploadId }, ...captionPayload },
    };
  }

  if (!src || !/^https?:\/\//i.test(src)) return paragraphFallback('');
  return {
    object: 'block',
    type: 'image',
    image: { type: 'external', external: { url: src }, ...captionPayload },
  };
}

function youtubeBlock(node: DocumentContent): NotionBlockPayload {
  const src = stringProperty(node.attrs, 'src');
  const videoUrl = src ? normalizeYoutubeVideoUrl(src) : '';
  if (!videoUrl) return paragraphFallback('');

  // Keep playback as a link so it works in Notion clients without video support.
  return paragraphFallback([textNodeToRichText({
    type: 'text',
    text: videoUrl,
    marks: [{ type: 'link', attrs: { href: videoUrl } }],
  })]);
}

function audioBlock(node: DocumentContent): NotionBlockPayload {
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
  return {
    object: 'block',
    type: 'audio',
    audio: { type: 'external', external: { url: src } },
  };
}

function fallbackBlock(node: DocumentContent): NotionBlockPayload {
  const richText = inlineContentToRichText(node.content);
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
      color: 'default',
    },
  };
}

/**
 * Creates unformatted Notion rich text.
 * @param text - Text content.
 * @returns Notion rich-text items split to fit the API's per-item limit.
 */
function plainRichText(text: string): NotionRichTextPayload[] {
  // Notion limits each rich-text object's content to 2,000 characters. Source
  // records are serialized into code blocks and can exceed that limit when a
  // page has a long URL, XPath, or captured passage.
  const chunks: string[] = [];
  let chunk = '';
  for (const character of text) {
    if (chunk.length + character.length > 2_000) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk || !chunks.length) chunks.push(chunk);

  return chunks.map((content) => ({
    type: 'text',
    text: { content },
  }));
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
