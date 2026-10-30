import type { DocumentContent } from '@/src/types/capture';
import type { SourceOpenPayload } from '@/src/types/messages';
import {
  decodeJottathingSource,
  JOTTATHING_SOURCE_ATTR,
  storeJottathingSource,
  type StoredJottathingSource,
} from '@/src/extensions/jottathingLink';
import {
  SOURCE_BLOCK_ID_PREFIX,
  SOURCE_ENTRY_PREFIX,
} from '@/src/lib/projectStateSources';

type SourceRegistry = Record<string, StoredJottathingSource>;
const RETIRED_SOURCE_METADATA_PREFIXES = [
  'jottathing_sources_v1:',
  'jottathing_source_v2:',
  'jottathing_links_v1:',
];

export function sourceFromProjectState(
  stateContent: DocumentContent | undefined,
  blockId: unknown,
) {
  if (typeof blockId !== 'string' || !blockId) {
    return null;
  }

  return decodeJottathingSource(readSourceRegistry(stateContent)[blockId]);
}

export function addSourceToProjectState(
  stateContent: DocumentContent | undefined,
  blockId: string,
  source: SourceOpenPayload,
): DocumentContent {
  const registry = readSourceRegistry(stateContent);
  const visibleContent = visibleProjectStateContent(stateContent);
  const nextRegistry = {
    ...registry,
    [blockId]: storeJottathingSource(source),
  };

  return {
    type: 'doc',
    content: [
      ...stateNodesForStorage(visibleContent),
      ...sourceEntryNodes(nextRegistry),
    ],
  };
}

export function sourceEntryForProjectState(
  blockId: string,
  source: SourceOpenPayload,
): DocumentContent {
  return sourceEntryNode(blockId, storeJottathingSource(source));
}

export function mergeVisibleProjectState(
  visibleContent: DocumentContent,
  previousState: DocumentContent | undefined,
): DocumentContent {
  const registry = readSourceRegistry(previousState);
  const retiredMetadata = (previousState?.content ?? []).filter((node) =>
    isProjectStateMetadataNode(node) &&
    sourceEntryText(node) === null,
  );

  return Object.keys(registry).length || retiredMetadata.length
    ? {
        ...visibleContent,
        type: 'doc',
        content: [
          ...stateNodesForStorage(visibleContent),
          ...sourceEntryNodes(registry),
          ...retiredMetadata,
        ],
      }
    : visibleContent;
}

export function visibleProjectStateContent(
  stateContent: DocumentContent | undefined,
): DocumentContent {
  const content = (stateContent?.content ?? []).filter(
    (node) => !isProjectStateMetadataNode(node),
  );

  return {
    ...(stateContent ?? {}),
    type: 'doc',
    content: content.length ? content : [{ type: 'paragraph' }],
  };
}

export function capturedBlockId(content: DocumentContent[]) {
  const value = content[0]?.attrs?.jottathingBlockId;
  return typeof value === 'string' && value ? value : null;
}

function readSourceRegistry(
  stateContent: DocumentContent | undefined,
): SourceRegistry {
  // Notion project-state blocks are untrusted input. A null prototype keeps
  // imported keys such as "__proto__" from changing lookup behavior.
  const registry = Object.create(null) as SourceRegistry;

  for (const node of stateContent?.content ?? []) {
    const entry = sourceEntry(node);
    if (entry) registry[entry.blockId] = entry.source;
  }

  return registry;
}

function sourceEntryNodes(registry: SourceRegistry) {
  return Object.entries(registry).map(([blockId, source]) =>
    sourceEntryNode(blockId, source),
  );
}

function sourceEntryNode(
  blockId: string,
  source: StoredJottathingSource,
): DocumentContent {
  return {
    type: 'codeBlock',
    attrs: {
      language: 'json',
      jottathingBlockId: `${SOURCE_BLOCK_ID_PREFIX}${encodeURIComponent(blockId)}`,
    },
    content: [{
      type: 'text',
      text: `${SOURCE_ENTRY_PREFIX}${JSON.stringify({ blockId, source })}`,
    }],
  };
}

function stateNodesForStorage(content: DocumentContent) {
  const nodes = content.content ?? [];
  return nodes.length === 1 &&
    nodes[0].type === 'paragraph' &&
    !(nodes[0].content?.length)
    ? []
    : nodes;
}

export function isProjectStateMetadataNode(node: DocumentContent) {
  const text = codeBlockText(node);
  return sourceEntryText(node) !== null || Boolean(
    text && RETIRED_SOURCE_METADATA_PREFIXES.some((prefix) => text.startsWith(prefix)),
  );
}

function sourceEntry(node: DocumentContent): {
  blockId: string;
  source: StoredJottathingSource;
} | null {
  const raw = sourceEntryText(node);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { blockId?: unknown; source?: unknown };
    const source = decodeJottathingSource(parsed.source);
    const blockId = parsed.blockId;
    return typeof blockId === 'string' && blockId && source
      ? { blockId, source: storeJottathingSource(source) }
      : null;
  } catch {
    return null;
  }
}

function sourceEntryText(node: DocumentContent) {
  const text = codeBlockText(node);
  return text?.startsWith(SOURCE_ENTRY_PREFIX) ? text.slice(SOURCE_ENTRY_PREFIX.length) : null;
}

function codeBlockText(node: DocumentContent) {
  if (node.type !== 'codeBlock') return null;
  return (node.content ?? []).map((child) => child.text ?? '').join('');
}
