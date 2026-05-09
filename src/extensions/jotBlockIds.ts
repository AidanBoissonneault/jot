import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { DocumentContent } from '@/src/types/capture';

export const JOT_BLOCK_ID_ATTR = 'jotBlockId';

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

export const JotBlockIds = Extension.create({
  name: 'jotBlockIds',

  addGlobalAttributes() {
    return [
      {
        types: TOP_LEVEL_BLOCK_TYPES,
        attributes: {
          [JOT_BLOCK_ID_ATTR]: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-jot-block-id'),
            renderHTML: (attributes) => {
              const value = attributes[JOT_BLOCK_ID_ATTR];

              return typeof value === 'string' && value
                ? { 'data-jot-block-id': value }
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

            const value = node.attrs[JOT_BLOCK_ID_ATTR];
            const id = typeof value === 'string' && value ? value : '';

            if (id && !seen.has(id)) {
              seen.add(id);
              return;
            }

            const nextId = createJotBlockId();
            seen.add(nextId);
            transaction = transaction.setNodeMarkup(offset, undefined, {
              ...node.attrs,
              [JOT_BLOCK_ID_ATTR]: nextId,
            });
            changed = true;
          });

          return changed ? transaction : null;
        },
      }),
    ];
  },
});

export function normalizeJotBlockIds(content: DocumentContent): DocumentContent {
  const seen = new Set<string>();
  let changed = false;
  const normalizedChildren = (content.content ?? []).map((node) => {
    const attrs = node.attrs ?? {};
    const value = attrs[JOT_BLOCK_ID_ATTR];
    const id = typeof value === 'string' && value ? value : '';

    if (id && !seen.has(id)) {
      seen.add(id);
      return node;
    }

    changed = true;
    const nextId = createJotBlockId();
    seen.add(nextId);
    return {
      ...node,
      attrs: {
        ...attrs,
        [JOT_BLOCK_ID_ATTR]: nextId,
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

function createJotBlockId() {
  return `jot-block-${globalThis.crypto?.randomUUID?.() ?? fallbackId()}`;
}

function fallbackId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
