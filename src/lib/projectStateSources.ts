import type { DocumentContent } from '../types/capture.js';

export const SOURCE_REGISTRY_PREFIX = 'inkwell_sources_v1:';
export const SOURCE_ENTRY_PREFIX = 'inkwell_source_v1:';
export const SOURCE_BLOCK_ID_PREFIX = 'source:';
export const SOURCE_V2_PREFIX = 'inkwell_source_v2:';
export const LINKS_V1_PREFIX = 'inkwell_links_v1:';

/** Removes source entries that point to Inkwell blocks which no longer exist. */
export function pruneOrphanedProjectStateSources(
  stateContent: DocumentContent,
  existingInkwellBlockIds: ReadonlySet<string>,
): DocumentContent {
  let changed = false;
  let hasUnparsedSourceV2 = false;
  const sourceV2Nodes: Array<{ node: DocumentContent; source: SourceV2 }> = [];
  const content = (stateContent.content ?? []).flatMap((node) => {
    const text = codeBlockText(node);
    if (text?.startsWith(SOURCE_V2_PREFIX)) {
      const source = parseSourceV2(text.slice(SOURCE_V2_PREFIX.length));
      if (source?.inkwellBlockId && !existingInkwellBlockIds.has(source.inkwellBlockId)) {
        changed = true;
        return [];
      }
      if (source) sourceV2Nodes.push({ node, source });
      else hasUnparsedSourceV2 = true;
      return [node];
    }

    if (text?.startsWith(SOURCE_ENTRY_PREFIX)) {
      const blockId = sourceEntryBlockId(text);
      if (blockId && !existingInkwellBlockIds.has(blockId)) {
        changed = true;
        return [];
      }
      return [node];
    }

    if (!text?.startsWith(SOURCE_REGISTRY_PREFIX)) return [node];
    const registry = parseRegistry(text.slice(SOURCE_REGISTRY_PREFIX.length));
    if (!registry) return [node];

    const retained = Object.fromEntries(Object.entries(registry)
      .filter(([blockId]) => existingInkwellBlockIds.has(blockId)));
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
    if (!text?.startsWith(LINKS_V1_PREFIX)) return [node];

    const links = parseLinks(text.slice(LINKS_V1_PREFIX.length));
    if (!links) return [node];
    if (hasUnparsedSourceV2) return [node];
    if (!liveSourceNodes.size || !linkRefs.length) {
      changed = true;
      return [];
    }

    // The source v2 records point into this URL array by numeric index. Keep
    // only URLs still referenced by a live Inkwell block, and rewrite those
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

/** Reads captured Inkwell block IDs referenced by one project-state source node. */
export function projectStateSourceBlockIds(node: DocumentContent): string[] {
  const text = codeBlockText(node);
  if (text?.startsWith(SOURCE_ENTRY_PREFIX)) {
    const blockId = sourceEntryBlockId(text);
    return blockId ? [blockId] : [];
  }

  if (text?.startsWith(SOURCE_V2_PREFIX)) {
    const source = parseSourceV2(text.slice(SOURCE_V2_PREFIX.length));
    return source?.inkwellBlockId ? [source.inkwellBlockId] : [];
  }

  if (text?.startsWith(SOURCE_REGISTRY_PREFIX)) {
    const registry = parseRegistry(text.slice(SOURCE_REGISTRY_PREFIX.length));
    return registry ? Object.keys(registry) : [];
  }

  return [];
}

type SourceV2 = {
  inkwellBlockId?: string;
  source: Record<string, unknown> & { u?: unknown };
};

function parseSourceV2(value: string): SourceV2 | undefined {
  try {
    const parsed = JSON.parse(value) as { i?: unknown; s?: unknown };
    if (
      typeof parsed.i !== 'string' ||
      !parsed.i ||
      !parsed.s ||
      typeof parsed.s !== 'object' ||
      Array.isArray(parsed.s)
    ) return undefined;
    return {
      inkwellBlockId: parsed.i,
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

function sourceEntryBlockId(text: string): string | undefined {
  try {
    const value = JSON.parse(text.slice(SOURCE_ENTRY_PREFIX.length)) as { blockId?: unknown };
    return typeof value.blockId === 'string' && value.blockId ? value.blockId : undefined;
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
