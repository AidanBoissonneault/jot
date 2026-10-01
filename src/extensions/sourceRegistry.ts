import type { DocumentContent } from '@/src/types/capture';
import type { SourceOpenPayload } from '@/src/types/messages';
import {
  decodeInkwellSource,
  INKWELL_SOURCE_ATTR,
  storeInkwellSource,
  type StoredInkwellSource,
} from '@/src/extensions/inkwellLink';
import {
  SOURCE_BLOCK_ID_PREFIX,
  SOURCE_ENTRY_PREFIX,
  SOURCE_V2_PREFIX,
  LINKS_V1_PREFIX,
  SOURCE_REGISTRY_PREFIX,
} from '@/src/lib/projectStateSources';

type SourceRegistry = Record<string, StoredInkwellSource>;

export function sourceFromProjectState(
  stateContent: DocumentContent | undefined,
  blockId: unknown,
) {
  if (typeof blockId !== 'string' || !blockId) {
    return null;
  }

  return decodeInkwellSource(readSourceRegistry(stateContent)[blockId]);
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
    [blockId]: storeInkwellSource(source),
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
  return sourceEntryNode(blockId, storeInkwellSource(source));
}

export function mergeVisibleProjectState(
  visibleContent: DocumentContent,
  previousState: DocumentContent | undefined,
): DocumentContent {
  const registry = readSourceRegistry(previousState);
  const legacyMetadata = (previousState?.content ?? []).filter((node) =>
    isProjectStateMetadataNode(node) &&
    sourceRegistryText(node) === null &&
    sourceEntryText(node) === null,
  );

  return Object.keys(registry).length || legacyMetadata.length
    ? {
        ...visibleContent,
        type: 'doc',
        content: [
          ...stateNodesForStorage(visibleContent),
          ...sourceEntryNodes(registry),
          ...legacyMetadata,
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
  const value = content[0]?.attrs?.inkwellBlockId;
  return typeof value === 'string' && value ? value : null;
}

export function migratePageSourcesToProjectState(
  pageContent: DocumentContent,
  stateContent: DocumentContent | undefined,
) {
  let nextState = stateContent ?? { type: 'doc', content: [{ type: 'paragraph' }] };
  let changed = false;
  let migratedPreviousBlock = false;
  const content: DocumentContent[] = [];

  for (const node of pageContent.content ?? []) {
    const source = decodeInkwellSource(node.attrs?.[INKWELL_SOURCE_ATTR]);
    const blockId = node.attrs?.inkwellBlockId;

    if (source && typeof blockId === 'string' && blockId) {
      const storedSource = sourceFromProjectState(nextState, blockId);
      if (
        JSON.stringify(storeInkwellSource(storedSource ?? source)) !==
        JSON.stringify(storeInkwellSource(source)) ||
        !storedSource
      ) {
        nextState = addSourceToProjectState(nextState, blockId, source);
        changed = true;
      }
      content.push(node);
      migratedPreviousBlock = true;
      continue;
    }

    if (migratedPreviousBlock && isGeneratedSourceParagraph(node)) {
      migratedPreviousBlock = false;
      changed = true;
      continue;
    }

    migratedPreviousBlock = false;
    content.push(node);
  }

  return {
    changed,
    content: changed ? { ...pageContent, content } : pageContent,
    stateContent: nextState,
  };
}

function readSourceRegistry(
  stateContent: DocumentContent | undefined,
): SourceRegistry {
  // Notion project-state blocks are untrusted input. A null prototype keeps
  // imported keys such as "__proto__" from changing lookup behavior.
  const registry = Object.create(null) as SourceRegistry;

  for (const node of stateContent?.content ?? []) {
    const entry = sourceEntry(node);
    if (entry) {
      registry[entry.blockId] = entry.source;
      continue;
    }

    const raw = sourceRegistryText(node);
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as SourceRegistry;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [blockId, source] of Object.entries(parsed)) {
          registry[blockId] = source;
        }
      }
    } catch {
      // Leave a malformed state block untouched and start a valid registry.
    }
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
  source: StoredInkwellSource,
): DocumentContent {
  return {
    type: 'codeBlock',
    attrs: {
      language: 'json',
      inkwellBlockId: `${SOURCE_BLOCK_ID_PREFIX}${encodeURIComponent(blockId)}`,
    },
    content: [{
      type: 'text',
      text: `${SOURCE_ENTRY_PREFIX}${JSON.stringify({ blockId, source })}`,
    }],
  };
}

function isGeneratedSourceParagraph(node: DocumentContent) {
  if (node.type !== 'paragraph') {
    return false;
  }

  const text = (node.content ?? []).map(textFromNode).join('');
  return /^Source:\s.+\s-\shttps?:\/\//i.test(text) && hasLink(node);
}

function hasLink(node: DocumentContent): boolean {
  return (node.marks ?? []).some((mark) => mark.type === 'link') ||
    (node.content ?? []).some(hasLink);
}

function textFromNode(node: DocumentContent): string {
  return node.text ?? (node.content ?? []).map(textFromNode).join('');
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
  return sourceRegistryText(node) !== null || sourceEntryText(node) !== null ||
    Boolean(text?.startsWith(SOURCE_V2_PREFIX) || text?.startsWith(LINKS_V1_PREFIX));
}

function sourceEntry(node: DocumentContent): {
  blockId: string;
  source: StoredInkwellSource;
} | null {
  const raw = sourceEntryText(node);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { blockId?: unknown; source?: unknown };
    const source = decodeInkwellSource(parsed.source);
    return typeof parsed.blockId === 'string' && parsed.blockId && source
      ? { blockId: parsed.blockId, source: storeInkwellSource(source) }
      : null;
  } catch {
    return null;
  }
}

function sourceEntryText(node: DocumentContent) {
  const text = codeBlockText(node);
  return text?.startsWith(SOURCE_ENTRY_PREFIX)
    ? text.slice(SOURCE_ENTRY_PREFIX.length)
    : null;
}

function sourceRegistryText(node: DocumentContent) {
  const text = codeBlockText(node);
  return text?.startsWith(SOURCE_REGISTRY_PREFIX)
    ? text.slice(SOURCE_REGISTRY_PREFIX.length)
    : null;
}

function codeBlockText(node: DocumentContent) {
  if (node.type !== 'codeBlock') return null;
  return (node.content ?? []).map((child) => child.text ?? '').join('');
}
