import type { DocumentContent } from '../types/capture.js';

export const SOURCE_REGISTRY_PREFIX = 'jottathing_sources_v1:';
export const SOURCE_ENTRY_PREFIX = 'jottathing_source_v1:';
export const SOURCE_BLOCK_ID_PREFIX = 'source:';
export const SOURCE_V2_PREFIX = 'jottathing_source_v2:';
export const LINKS_V1_PREFIX = 'jottathing_links_v1:';

/** Removes source entries that point to Jottathing blocks which no longer exist. */
export function pruneOrphanedProjectStateSources(
  stateContent: DocumentContent,
  existingJottathingBlockIds: ReadonlySet<string>,
): DocumentContent {
  let changed = false;
  let hasUnparsedSourceV2 = false;
  const sourceV2Nodes: Array<{ node: DocumentContent; source: SourceV2 }> = [];
  const content = (stateContent.content ?? []).flatMap((node) => {
    const text = codeBlockText(node);
    const sourceV2Payload = text ? prefixedPayload(text, SOURCE_V2_PREFIX) : undefined;
    if (sourceV2Payload !== undefined) {
      const source = parseSourceV2(sourceV2Payload);
      if (source?.jottathingBlockId && !existingJottathingBlockIds.has(source.jottathingBlockId)) {
        changed = true;
        return [];
      }
      if (source) sourceV2Nodes.push({ node, source });
      else hasUnparsedSourceV2 = true;
      return [node];
    }

    const sourceEntryPayload = text ? prefixedPayload(text, SOURCE_ENTRY_PREFIX) : undefined;
    if (sourceEntryPayload !== undefined) {
      const blockId = sourceEntryBlockId(sourceEntryPayload);
      if (blockId && !existingJottathingBlockIds.has(blockId)) {
        changed = true;
        return [];
      }
      return [node];
    }

    const registryPayload = text ? prefixedPayload(text, SOURCE_REGISTRY_PREFIX) : undefined;
    if (registryPayload === undefined) return [node];
    const registry = parseRegistry(registryPayload);
    if (!registry) return [node];

    const retained = Object.fromEntries(Object.entries(registry)
      .filter(([blockId]) => existingJottathingBlockIds.has(blockId)));
    if (Object.keys(retained).length === Object.keys(registry).length) return [node];

    changed = true;
    if (!Object.keys(retained).length) return [];

    const textNode = node.content?.find((child) => child.type === 'text');
    return [{
      ...node,
      content: [{
        ...(textNode ?? { type: 'text' }),
        text: `${SOURCE_REGISTRY_PREFIX}${JSON.stringify(retained)}`,
      }],
    }];
  });

  const liveSourceNodes = new Set(sourceV2Nodes.map(({ node }) => node));
  const linkRefs = sourceV2Nodes
    .map(({ source }) => source.source.u)
    .filter((value): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0,
    );
  const sourceV2Replacements = new Map<DocumentContent, DocumentContent>();
  const contentWithLinks = content.flatMap((node) => {
    const text = codeBlockText(node);
    const linksPayload = text ? prefixedPayload(text, LINKS_V1_PREFIX) : undefined;
    if (linksPayload === undefined) return [node];

    const links = parseLinks(linksPayload);
    if (!links) return [node];
    if (hasUnparsedSourceV2) return [node];
    if (!liveSourceNodes.size || !linkRefs.length) {
      changed = true;
      return [];
    }

    // The source v2 records point into this URL array by numeric index. Keep
    // only URLs still referenced by a live Jottathing block, and rewrite those
    // indexes when removing gaps from the array.
    const referencedIndexes = [...new Set(linkRefs)].sort((first, second) => first - second);
    if (referencedIndexes.some((index) => index >= links.length)) return [node];
    const indexMap = new Map(referencedIndexes.map((index, next) => [index, next]));
    for (const entry of sourceV2Nodes) {
      const previousIndex = entry.source.source.u;
      if (typeof previousIndex !== 'number') continue;
      const nextIndex = indexMap.get(previousIndex);
      if (nextIndex === undefined || nextIndex === previousIndex) continue;
      entry.source.source.u = nextIndex;
      sourceV2Replacements.set(
        entry.node,
        replaceCodeBlockText(
          entry.node,
          `${SOURCE_V2_PREFIX}${JSON.stringify(entry.source)}`,
        ),
      );
      changed = true;
    }

    const retainedLinks = referencedIndexes.map((index) => links[index]);
    if (retainedLinks.length === links.length && retainedLinks.every((url, index) => url === links[index])) {
      return [node];
    }
    changed = true;
    return [replaceCodeBlockText(node, `${LINKS_V1_PREFIX}${JSON.stringify(retainedLinks)}`)];
  });

  return changed
    ? {
        ...stateContent,
        type: stateContent.type ?? 'doc',
        content: contentWithLinks.map((node) => sourceV2Replacements.get(node) ?? node),
      }
    : stateContent;
}

/** Reads captured Jottathing block IDs referenced by one project-state source node. */
export function projectStateSourceBlockIds(node: DocumentContent): string[] {
  const text = codeBlockText(node);
  const sourceEntryPayload = text ? prefixedPayload(text, SOURCE_ENTRY_PREFIX) : undefined;
  if (sourceEntryPayload !== undefined) {
    const blockId = sourceEntryBlockId(sourceEntryPayload);
    return blockId ? [blockId] : [];
  }

  const sourceV2Payload = text ? prefixedPayload(text, SOURCE_V2_PREFIX) : undefined;
  if (sourceV2Payload !== undefined) {
    const source = parseSourceV2(sourceV2Payload);
    return source?.jottathingBlockId ? [source.jottathingBlockId] : [];
  }

  const registryPayload = text ? prefixedPayload(text, SOURCE_REGISTRY_PREFIX) : undefined;
  if (registryPayload !== undefined) {
    const registry = parseRegistry(registryPayload);
    return registry ? Object.keys(registry) : [];
  }

  return [];
}

type SourceV2 = {
  jottathingBlockId?: string;
  source: Record<string, unknown> & { u?: unknown };
};

function prefixedPayload(text: string, prefix: string): string | undefined {
  return text.startsWith(prefix) ? text.slice(prefix.length) : undefined;
}

function parseSourceV2(value: string): SourceV2 | undefined {
  try {
    const parsed = JSON.parse(value) as { i?: unknown; s?: unknown };
    const blockId = parsed.i;
    if (
      typeof blockId !== 'string' ||
      !blockId ||
      !parsed.s ||
      typeof parsed.s !== 'object' ||
      Array.isArray(parsed.s)
    ) return undefined;
    return {
      jottathingBlockId: blockId,
      source: parsed.s as Record<string, unknown> & { u?: unknown },
    };
  } catch {
    return undefined;
  }
}

function parseLinks(value: string): string[] | undefined {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((link) => typeof link === 'string')
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function replaceCodeBlockText(node: DocumentContent, text: string): DocumentContent {
  const firstTextNode = node.content?.find((child) => child.type === 'text');
  return {
    ...node,
    content: [{ ...(firstTextNode ?? { type: 'text' }), text }],
  };
}

function sourceEntryBlockId(payload: string): string | undefined {
  try {
    const value = JSON.parse(payload) as { blockId?: unknown };
    const blockId = value.blockId;
    return typeof blockId === 'string' && blockId ? blockId : undefined;
  } catch {
    return undefined;
  }
}

function parseRegistry(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function codeBlockText(node: DocumentContent): string | undefined {
  return node.type === 'codeBlock'
    ? (node.content ?? []).map((child) => child.text ?? '').join('')
    : undefined;
}
