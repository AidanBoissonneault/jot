import type { DocumentContent } from '@/src/types/capture';
import type { SourceOpenPayload } from '@/src/types/messages';
import {
  decodeInkwellSource,
  INKWELL_SOURCE_ATTR,
  storeInkwellSource,
  type StoredInkwellSource,
} from '@/src/extensions/inkwellLink';

const SOURCE_REGISTRY_PREFIX = 'inkwell_sources_v1:';

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
      sourceRegistryNode(nextRegistry),
    ],
  };
}

export function mergeVisibleProjectState(
  visibleContent: DocumentContent,
  previousState: DocumentContent | undefined,
): DocumentContent {
  const registry = readSourceRegistry(previousState);

  return Object.keys(registry).length
    ? {
        ...visibleContent,
        type: 'doc',
        content: [
          ...stateNodesForStorage(visibleContent),
          sourceRegistryNode(registry),
        ],
      }
    : visibleContent;
}

export function visibleProjectStateContent(
  stateContent: DocumentContent | undefined,
): DocumentContent {
  const content = (stateContent?.content ?? []).filter(
    (node) => !isSourceRegistryNode(node),
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
      nextState = addSourceToProjectState(nextState, blockId, source);
      const { [INKWELL_SOURCE_ATTR]: _source, ...attrs } = node.attrs ?? {};
      content.push({
        ...node,
        attrs,
      });
      migratedPreviousBlock = true;
      changed = true;
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
  for (const node of stateContent?.content ?? []) {
    const raw = sourceRegistryText(node);
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as SourceRegistry;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Leave a malformed state block untouched and start a valid registry.
    }
  }

  return {};
}

function sourceRegistryNode(registry: SourceRegistry): DocumentContent {
  return {
    type: 'codeBlock',
    attrs: { language: 'json' },
    content: [{
      type: 'text',
      text: `${SOURCE_REGISTRY_PREFIX}${JSON.stringify(registry)}`,
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

function isSourceRegistryNode(node: DocumentContent) {
  return sourceRegistryText(node) !== null;
}

function sourceRegistryText(node: DocumentContent) {
  if (node.type !== 'codeBlock') {
    return null;
  }

  const text = (node.content ?? []).map((child) => child.text ?? '').join('');
  return text.startsWith(SOURCE_REGISTRY_PREFIX)
    ? text.slice(SOURCE_REGISTRY_PREFIX.length)
    : null;
}
