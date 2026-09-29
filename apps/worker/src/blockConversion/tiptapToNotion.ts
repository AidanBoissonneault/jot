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

/** Maps an editor color to Notion's supported annotation color. */
function notionColor(color: unknown): 'default' {
  return typeof color === 'string' && color ? 'default' : 'default';
}
