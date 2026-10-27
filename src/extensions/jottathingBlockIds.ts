import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { DocumentContent } from '@/src/types/capture';
import {
  decodeJottathingSource,
  encodeJottathingSource,
  JOTTATHING_SOURCE_ATTR,
  storeJottathingSource,
} from '@/src/extensions/jottathingLink';

const JOTTATHING_BLOCK_ID_ATTR = 'jottathingBlockId';
const LEGACY_BLOCK_ID_ATTR = 'inkwellBlockId';
const LEGACY_BLOCK_ID_DATA_ATTR = 'data-inkwell-block-id';
const LEGACY_SOURCE_DATA_ATTR = 'data-inkwell-source';

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

export const JottathingBlockIds = Extension.create({
  name: 'jottathingBlockIds',

  addGlobalAttributes() {
    return [
      {
        types: TOP_LEVEL_BLOCK_TYPES,
        attributes: {
          [JOTTATHING_BLOCK_ID_ATTR]: {
            default: null,
            parseHTML: (element) =>
              element.getAttribute('data-jottathing-block-id') ??
              element.getAttribute(LEGACY_BLOCK_ID_DATA_ATTR),
            renderHTML: (attributes) => {
              const value = attributes[JOTTATHING_BLOCK_ID_ATTR];

              return typeof value === 'string' && value
                ? { 'data-jottathing-block-id': value }
                : {};
            },
          },
          [JOTTATHING_SOURCE_ATTR]: {
            default: null,
            parseHTML: (element) => {
              const payload = decodeJottathingSource(
                element.getAttribute('data-jottathing-source') ??
                element.getAttribute(LEGACY_SOURCE_DATA_ATTR),
              );
              return payload ? storeJottathingSource(payload) : null;
            },
            renderHTML: (attributes) => {
              const payload = decodeJottathingSource(attributes[JOTTATHING_SOURCE_ATTR]);
              return payload
                ? { 'data-jottathing-source': encodeJottathingSource(payload) }
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

            const value = node.attrs[JOTTATHING_BLOCK_ID_ATTR];
            const id = typeof value === 'string' && value ? value : '';

            if (id && !seen.has(id)) {
              seen.add(id);
              return;
            }

            const nextId = createJottathingBlockId();
            seen.add(nextId);
            transaction = transaction.setNodeMarkup(offset, undefined, {
              ...node.attrs,
              [JOTTATHING_BLOCK_ID_ATTR]: nextId,
            });
            changed = true;
          });

          return changed ? transaction : null;
        },
      }),
    ];
  },
});

export function normalizeJottathingBlockIds(content: DocumentContent): DocumentContent {
  const seen = new Set<string>();
  let changed = false;
  const children = content.content ?? [];
  const normalizedChildren = children.map((originalNode, index) => {
    let node = stripEmptySourceAttributes(originalNode);
    changed ||= node !== originalNode;
    const legacyAttrs = node.attrs ?? {};
    if (LEGACY_BLOCK_ID_ATTR in legacyAttrs) {
      const { [LEGACY_BLOCK_ID_ATTR]: legacyId, ...attrs } = legacyAttrs;
      node = {
        ...node,
        attrs: {
          ...attrs,
          ...(attrs[JOTTATHING_BLOCK_ID_ATTR] == null && typeof legacyId === 'string'
            ? { [JOTTATHING_BLOCK_ID_ATTR]: legacyId }
            : {}),
        },
      };
      changed = true;
    }
    const sourceAttrs = node.attrs ?? {};
    if ('inkwellSource' in sourceAttrs) {
      const { inkwellSource, ...attrs } = sourceAttrs;
      node = {
        ...node,
        attrs: {
          ...attrs,
          ...(attrs[JOTTATHING_SOURCE_ATTR] == null ? { [JOTTATHING_SOURCE_ATTR]: inkwellSource } : {}),
        },
      };
      changed = true;
    }
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
      !decodeJottathingSource(node.attrs?.[JOTTATHING_SOURCE_ATTR]) &&
      source
    ) {
      node = {
        ...node,
        attrs: {
          ...node.attrs,
          [JOTTATHING_SOURCE_ATTR]: storeJottathingSource(source),
        },
      };
      changed = true;
    }

    const attrs = node.attrs ?? {};
    const value = attrs[JOTTATHING_BLOCK_ID_ATTR];
    const id = typeof value === 'string' && value ? value : '';

    if (id && !seen.has(id)) {
      seen.add(id);
      return node;
    }

    changed = true;
    const nextId = createJottathingBlockId();
    seen.add(nextId);
    return {
      ...node,
      attrs: {
        ...attrs,
        [JOTTATHING_BLOCK_ID_ATTR]: nextId,
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

  if (attrs && attrs[JOTTATHING_SOURCE_ATTR] == null) {
    const { [JOTTATHING_SOURCE_ATTR]: _emptySource, ...remainingAttrs } = attrs;
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
): ReturnType<typeof decodeJottathingSource> {
  if (!node) {
    return null;
  }

  const nodeSource = decodeJottathingSource(node.attrs?.[JOTTATHING_SOURCE_ATTR]);
  if (nodeSource) {
    return nodeSource;
  }

  for (const mark of node.marks ?? []) {
    const markSource = decodeJottathingSource(mark.attrs?.[JOTTATHING_SOURCE_ATTR]);
    if (markSource) {
      return markSource;
    }
  }

  for (const child of node.content ?? []) {
    const childSource: ReturnType<typeof decodeJottathingSource> = sourceFromNode(child);
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
): ReturnType<typeof decodeJottathingSource> {
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

export function createJottathingBlockId() {
  return `jottathing-block-${globalThis.crypto?.randomUUID?.() ?? fallbackId()}`;
}

function fallbackId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
