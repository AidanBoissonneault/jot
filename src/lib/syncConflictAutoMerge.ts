import type { DocumentContent } from '../types/capture.js';
import type { SyncContentConflict } from '../types/sync.js';

/**
 * Combines independent page additions when all previously shared blocks still
 * match on both sides. Returns undefined whenever a choice could be needed.
 */
export function autoMergeUniquePageAdditions(
  conflict: SyncContentConflict,
): DocumentContent | undefined {
  if (conflict.targetType !== 'page' || !conflict.remoteContent) return undefined;
  if (conflict.localChangedBlockIds?.length || conflict.remoteChangedBlockIds?.length) return undefined;

  const localBlocks = conflict.localContent.content ?? [];
  const remoteBlocks = conflict.remoteContent.content ?? [];
  const baseBlocks = conflict.baseContent?.content ?? [];
  const baseIds = new Set(baseBlocks.map(blockId).filter(isPresent));
  const localById = indexById(localBlocks);
  const remoteById = indexById(remoteBlocks);
  const hasChangeSummary = conflict.localChangedBlockIds !== undefined ||
    conflict.remoteChangedBlockIds !== undefined;

  for (const [id, local] of localById) {
    const remote = remoteById.get(id);
    if (remote && !hasChangeSummary && signature(local) !== signature(remote)) return undefined;
  }

  // A deletion or an edit to a shared block needs the normal conflict review.
  for (const id of baseIds) {
    const local = localById.get(id);
    const remote = remoteById.get(id);
    if (!local || !remote || (!hasChangeSummary && signature(local) !== signature(remote))) return undefined;
  }

  const localSignatures = new Set(localBlocks.map(signature));
  const remoteAdditions: DocumentContent[] = [];
  const additionSignatures = new Set<string>();
  for (const remote of remoteBlocks) {
    const id = blockId(remote);
    if (id && localById.has(id)) continue;
    if (id && baseIds.has(id)) return undefined;

    const contentSignature = signature(remote);
    // Identical additions need the user to decide whether they are duplicates.
    if (localSignatures.has(contentSignature) || additionSignatures.has(contentSignature)) {
      return undefined;
    }
    additionSignatures.add(contentSignature);
    remoteAdditions.push(remote);
  }

  if (!remoteAdditions.length) return undefined;

  return {
    ...conflict.localContent,
    type: conflict.localContent.type ?? 'doc',
    attrs: {
      ...conflict.localContent.attrs,
      inkwellConflictResolution: true,
      inkwellPreserveRemoteBlocks: true,
    },
    content: [...localBlocks, ...remoteAdditions],
  };
}

function blockId(block: DocumentContent): string | undefined {
  const value = block.attrs?.inkwellBlockId;
  return typeof value === 'string' && value ? value : undefined;
}

function indexById(blocks: DocumentContent[]): Map<string, DocumentContent> {
  return new Map(blocks.flatMap((block) => {
    const id = blockId(block);
    return id ? [[id, block] as const] : [];
  }));
}

function signature(block: DocumentContent): string {
  return JSON.stringify(withoutIdentity(block));
}

function withoutIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIdentity);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const isFileUpload = Boolean(record.notionFileUploadId);
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== 'inkwellBlockId' && key !== 'notionBlockId' &&
      key !== 'inkwellConflictResolution' && key !== 'inkwellPreserveRemoteBlocks' &&
      key !== 'uploadState' && !(isFileUpload && key === 'src'))
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, nested]) => [key, key === 'src' ? stableMediaUrl(nested) : withoutIdentity(nested)]));
}

function stableMediaUrl(value: unknown): unknown {
  if (typeof value !== 'string') return withoutIdentity(value);
  try {
    const url = new URL(value);
    if (url.searchParams.has('X-Amz-Signature') || url.hostname.startsWith('prod-files-secure.s3.')) {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // Keep non-URL media values exact.
  }
  return value;
}

function isPresent(value: string | undefined): value is string {
  return Boolean(value);
}
