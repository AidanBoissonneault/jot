import type { DocumentContent } from '@/src/types/capture';
import type { SourceOpenPayload, WebsiteHighlight } from '@/src/types/messages';
import {
  decodeInkwellSource,
  INKWELL_SOURCE_ATTR,
  storeInkwellSource,
  type StoredInkwellSource,
} from '@/src/extensions/inkwellLink';

const SOURCE_REGISTRY_PREFIX = 'inkwell_sources_v1:';
const WEBSITE_HIGHLIGHT_REGISTRY_PREFIX = 'inkwell_website_highlights_v1:';
const LINK_REGISTRY_PREFIX = 'inkwell_links_v1:';
const SOURCE_RECORD_PREFIX = 'inkwell_source_v2:';
const WEBSITE_HIGHLIGHT_RECORD_PREFIX = 'inkwell_website_highlight_v2:';

type SourceRegistry = Record<string, StoredInkwellSource>;
type WebsiteHighlightRegistry = Record<string, WebsiteHighlight>;

export function websiteHighlightsFromProjectState(
  stateContent: DocumentContent | undefined,
  url?: string,
) {
  const highlights = Object.values(readWebsiteHighlightRegistry(stateContent));
  return url ? highlights.filter((highlight) => highlight.url === url) : highlights;
}

export function addWebsiteHighlightToProjectState(
  stateContent: DocumentContent | undefined,
  highlight: WebsiteHighlight,
): DocumentContent {
  const registry = readWebsiteHighlightRegistry(stateContent);
  return replaceStateRegistries(stateContent, readSourceRegistry(stateContent), {
    ...registry,
    [highlight.id]: highlight,
  });
}

export function removeWebsiteHighlightsFromProjectState(
  stateContent: DocumentContent | undefined,
  ids: string[],
): DocumentContent {
  const registry = { ...readWebsiteHighlightRegistry(stateContent) };
  for (const id of ids) delete registry[id];
  return replaceStateRegistries(stateContent, readSourceRegistry(stateContent), registry);
}

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
  return stateWithRegistries(
    visibleContent,
    stateContent,
    nextRegistry,
    readWebsiteHighlightRegistry(stateContent),
  );
}

export function mergeVisibleProjectState(
  visibleContent: DocumentContent,
  previousState: DocumentContent | undefined,
): DocumentContent {
  const registry = readSourceRegistry(previousState);
  const highlights = readWebsiteHighlightRegistry(previousState);

  return Object.keys(registry).length || Object.keys(highlights).length
    ? stateWithRegistries(visibleContent, previousState, registry, highlights)
    : visibleContent;
}

export function visibleProjectStateContent(
  stateContent: DocumentContent | undefined,
): DocumentContent {
  const content = (stateContent?.content ?? []).filter(
    (node) => !isInternalStateNode(node),
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
  const registry: SourceRegistry = {};
  const links = readLinkRegistry(stateContent);

  for (const node of stateContent?.content ?? []) {
    const raw = sourceRegistryText(node);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as SourceRegistry;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.assign(registry, parsed);
        }
      } catch {
        // Leave a malformed legacy state block untouched until the next valid write.
      }
      continue;
    }

    const record = parseRecord(node, SOURCE_RECORD_PREFIX) as {
      i?: string;
      s?: Omit<StoredInkwellSource, 'u'> & { u?: string | number };
    } | null;
    if (record?.i && record.s && typeof record.s.u === 'number' && links[record.s.u]) {
      registry[record.i] = { ...record.s, u: links[record.s.u] } as StoredInkwellSource;
    }
  }

  return registry;
}

function readWebsiteHighlightRegistry(
  stateContent: DocumentContent | undefined,
): WebsiteHighlightRegistry {
  const registry: WebsiteHighlightRegistry = {};
  const links = readLinkRegistry(stateContent);

  for (const node of stateContent?.content ?? []) {
    const raw = websiteHighlightRegistryText(node);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as WebsiteHighlightRegistry;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.assign(registry, parsed);
        }
      } catch {
        // A malformed legacy registry is ignored and replaced on the next write.
      }
      continue;
    }

    const record = parseRecord(node, WEBSITE_HIGHLIGHT_RECORD_PREFIX) as {
      i?: string;
      u?: number;
      v?: Omit<WebsiteHighlight, 'id' | 'url'>;
    } | null;
    if (record?.i && typeof record.u === 'number' && links[record.u] && record.v) {
      registry[record.i] = { id: record.i, url: links[record.u], ...record.v };
    }
  }
  return registry;
}

function replaceStateRegistries(
  stateContent: DocumentContent | undefined,
  sources: SourceRegistry,
  highlights: WebsiteHighlightRegistry,
): DocumentContent {
  return stateWithRegistries(
    visibleProjectStateContent(stateContent),
    stateContent,
    sources,
    highlights,
  );
}

function stateWithRegistries(
  visibleContent: DocumentContent,
  previousState: DocumentContent | undefined,
  sources: SourceRegistry,
  highlights: WebsiteHighlightRegistry,
): DocumentContent {
  const links = readLinkRegistry(previousState);
  const linkIndex = (url: string) => {
    const existing = links.indexOf(url);
    if (existing >= 0) return existing;
    return links.push(url) - 1;
  };
  const sourceNodes = Object.entries(sources).map(([id, source]) => recordNode(
    `${SOURCE_RECORD_PREFIX}${JSON.stringify({ i: id, s: { ...source, u: linkIndex(source.u) } })}`,
    `inkwell-source:${id}`,
  ));
  const highlightNodes = Object.values(highlights).map(({ id, url, ...value }) => recordNode(
    `${WEBSITE_HIGHLIGHT_RECORD_PREFIX}${JSON.stringify({ i: id, u: linkIndex(url), v: value })}`,
    `inkwell-highlight:${id}`,
  ));

  return {
    ...visibleContent,
    type: 'doc',
    content: [
      ...stateNodesForStorage(visibleContent),
      ...(links.length ? [recordNode(`${LINK_REGISTRY_PREFIX}${JSON.stringify(links)}`, 'inkwell-links')] : []),
      ...sourceNodes,
      ...highlightNodes,
    ],
  };
}

function readLinkRegistry(stateContent: DocumentContent | undefined) {
  for (const node of stateContent?.content ?? []) {
    const raw = prefixedText(node, LINK_REGISTRY_PREFIX);
    if (!raw) continue;
    try {
      const links = JSON.parse(raw);
      if (Array.isArray(links) && links.every((url) => typeof url === 'string')) return links;
    } catch {
      // Rebuild malformed declarations from the legacy records on the next write.
    }
  }
  return [] as string[];
}

function recordNode(text: string, inkwellBlockId: string): DocumentContent {
  return {
    type: 'codeBlock',
    attrs: { language: 'json', inkwellBlockId },
    content: [{ type: 'text', text }],
  };
}

function parseRecord(node: DocumentContent, prefix: string) {
  const raw = prefixedText(node, prefix);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isWebsiteHighlightRegistryNode(node: DocumentContent) {
  return websiteHighlightRegistryText(node) !== null;
}

function websiteHighlightRegistryText(node: DocumentContent) {
  return prefixedText(node, WEBSITE_HIGHLIGHT_REGISTRY_PREFIX);
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
  return prefixedText(node, SOURCE_REGISTRY_PREFIX);
}

function isInternalStateNode(node: DocumentContent) {
  return isSourceRegistryNode(node) ||
    isWebsiteHighlightRegistryNode(node) ||
    prefixedText(node, LINK_REGISTRY_PREFIX) !== null ||
    prefixedText(node, SOURCE_RECORD_PREFIX) !== null ||
    prefixedText(node, WEBSITE_HIGHLIGHT_RECORD_PREFIX) !== null;
}

function prefixedText(node: DocumentContent, prefix: string) {
  if (node.type !== 'codeBlock') {
    return null;
  }

  const text = (node.content ?? []).map((child) => child.text ?? '').join('');
  return text.startsWith(prefix)
    ? text.slice(prefix.length)
    : null;
}
