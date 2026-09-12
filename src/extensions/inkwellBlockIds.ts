import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { DocumentContent } from '@/src/types/capture';
import {
  decodeInkwellSource,
  encodeInkwellSource,
  INKWELL_SOURCE_ATTR,
  storeInkwellSource,
} from '@/src/extensions/inkwellLink';

const INKWELL_BLOCK_ID_ATTR = 'inkwellBlockId';

const TOP_LEVEL_BLOCK_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'image',
  'youtube',
  'audio',
  'bulletList',
  'orderedList',
  'taskList',
];

export const InkwellBlockIds = Extension.create({
  name: 'inkwellBlockIds',

  addGlobalAttributes() {
    return [
      {
        types: TOP_LEVEL_BLOCK_TYPES,
        attributes: {
          [INKWELL_BLOCK_ID_ATTR]: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-inkwell-block-id'),
            renderHTML: (attributes) => {
              const value = attributes[INKWELL_BLOCK_ID_ATTR];

              return typeof value === 'string' && value
                ? { 'data-inkwell-block-id': value }
                : {};
            },
          },
          [INKWELL_SOURCE_ATTR]: {
            default: null,
            parseHTML: (element) => {
              const payload = decodeInkwellSource(
                element.getAttribute('data-inkwell-source'),
              );
              return payload ? storeInkwellSource(payload) : null;
            },
            renderHTML: (attributes) => {
              const payload = decodeInkwellSource(attributes[INKWELL_SOURCE_ATTR]);
              return payload
                ? { 'data-inkwell-source': encodeInkwellSource(payload) }
                : {};
            },
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (_transactions, _oldState, newState) => {
          const seen = new Set<string>();
          let transaction = newState.tr;
          let changed = false;

          newState.doc.forEach((node, offset) => {
            if (!TOP_LEVEL_BLOCK_TYPES.includes(node.type.name)) {
              return;
            }

            const value = node.attrs[INKWELL_BLOCK_ID_ATTR];
            const id = typeof value === 'string' && value ? value : '';

            if (id && !seen.has(id)) {
              seen.add(id);
              return;
            }

            const nextId = createInkwellBlockId();
            seen.add(nextId);
            transaction = transaction.setNodeMarkup(offset, undefined, {
              ...node.attrs,
              [INKWELL_BLOCK_ID_ATTR]: nextId,
            });
            changed = true;
          });

          return changed ? transaction : null;
        },
      }),
    ];
  },
});

export function normalizeInkwellBlockIds(content: DocumentContent): DocumentContent {
  const seen = new Set<string>();
  let changed = false;
  const children = content.content ?? [];
  const normalizedChildren = children.map((originalNode, index) => {
    let node = stripEmptySourceAttributes(originalNode);
    changed ||= node !== originalNode;
    const canOwnSource =
      node.type === 'blockquote' ||
      node.type === 'codeBlock' ||
      node.type === 'heading';
    const ownSource = canOwnSource
      ? sourceFromNode(node) ?? (
          node.type === 'heading'
            ? sourceFromLink(node, textFromDocumentNode(node))
            : null
        )
      : null;
    const adjacentSource =
      node.type === 'blockquote' || node.type === 'codeBlock'
        ? sourceFromNode(children[index + 1]) ?? sourceFromSourceParagraph(
            children[index + 1],
            textFromDocumentNode(node),
          )
        : null;
    const source = ownSource ?? adjacentSource;

    if (
      canOwnSource &&
      !decodeInkwellSource(node.attrs?.[INKWELL_SOURCE_ATTR]) &&
      source
    ) {
      node = {
        ...node,
        attrs: {
          ...node.attrs,
          [INKWELL_SOURCE_ATTR]: storeInkwellSource(source),
        },
      };
      changed = true;
    }

    const attrs = node.attrs ?? {};
    const value = attrs[INKWELL_BLOCK_ID_ATTR];
    const id = typeof value === 'string' && value ? value : '';

    if (id && !seen.has(id)) {
      seen.add(id);
      return node;
    }

    changed = true;
    const nextId = createInkwellBlockId();
    seen.add(nextId);
    return {
      ...node,
      attrs: {
        ...attrs,
        [INKWELL_BLOCK_ID_ATTR]: nextId,
      },
    };
  });

  return changed
    ? {
        ...content,
        type: content.type ?? 'doc',
        content: normalizedChildren,
      }
    : content;
}

function stripEmptySourceAttributes(node: DocumentContent): DocumentContent {
  let changed = false;
  let attrs = node.attrs;

  if (attrs && attrs[INKWELL_SOURCE_ATTR] == null) {
    const { [INKWELL_SOURCE_ATTR]: _emptySource, ...remainingAttrs } = attrs;
    attrs = remainingAttrs;
    changed = true;
  }

  const children = node.content?.map((child) => {
    const normalized = stripEmptySourceAttributes(child);
    changed ||= normalized !== child;
    return normalized;
  });

  return changed
    ? {
        ...node,
        ...(attrs && Object.keys(attrs).length ? { attrs } : { attrs: undefined }),
        ...(children ? { content: children } : {}),
      }
    : node;
}

function sourceFromNode(
  node: DocumentContent | undefined,
): ReturnType<typeof decodeInkwellSource> {
  if (!node) {
    return null;
  }

  const nodeSource = decodeInkwellSource(node.attrs?.[INKWELL_SOURCE_ATTR]);
  if (nodeSource) {
    return nodeSource;
  }

  for (const mark of node.marks ?? []) {
    const markSource = decodeInkwellSource(mark.attrs?.[INKWELL_SOURCE_ATTR]);
    if (markSource) {
      return markSource;
    }
  }

  for (const child of node.content ?? []) {
    const childSource: ReturnType<typeof decodeInkwellSource> = sourceFromNode(child);
    if (childSource) {
      return childSource;
    }
  }

  return null;
}

function sourceFromSourceParagraph(
  node: DocumentContent | undefined,
  sourceText: string,
) {
  if (!node || node.type !== 'paragraph' || !/^Source:\s/i.test(textFromDocumentNode(node))) {
    return null;
  }

  return sourceFromLink(node, sourceText);
}

function sourceFromLink(
  node: DocumentContent,
  sourceText: string,
): ReturnType<typeof decodeInkwellSource> {
  for (const mark of node.marks ?? []) {
    const href = mark.type === 'link' ? mark.attrs?.href : undefined;
    const payload = sourcePayloadFromHref(href, sourceText);
    if (payload) {
      return payload;
    }
  }

  for (const child of node.content ?? []) {
    const payload = sourceFromLink(child, sourceText);
    if (payload) {
      return payload;
    }
  }

  return null;
}

function sourcePayloadFromHref(href: unknown, text: string) {
  if (typeof href !== 'string' || !text) {
    return null;
  }

  try {
    const sourceLink = new URL(href);
    if (sourceLink.protocol !== 'http:' && sourceLink.protocol !== 'https:') {
      return null;
    }

    const sourceUrl = new URL(sourceLink);
    const textDirectiveIndex = sourceUrl.hash.indexOf(':~:text=');
    if (textDirectiveIndex >= 0) {
      const remainingHash = sourceUrl.hash.slice(0, textDirectiveIndex);
      sourceUrl.hash = remainingHash === '#' ? '' : remainingHash;
    }

    return {
      sourceUrl: sourceUrl.toString(),
      highlightMeta: {
        text,
        sourceLink: sourceLink.toString(),
      },
    };
  } catch {
    return null;
  }
}

function textFromDocumentNode(node: DocumentContent): string {
  if (node.text) {
    return node.text;
  }

  if (node.type === 'hardBreak') {
    return '\n';
  }

  return (node.content ?? []).map(textFromDocumentNode).join('');
}

export function createInkwellBlockId() {
  return `inkwell-block-${globalThis.crypto?.randomUUID?.() ?? fallbackId()}`;
}

function fallbackId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
