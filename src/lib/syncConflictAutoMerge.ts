import type { DocumentContent } from '../types/capture.js';
import type { SyncContentConflict } from '../types/sync.js';
import { syncConflictContentSignature } from './syncConflictSignature.js';

type BlockIndex = Map<string, DocumentContent>;

/**
 * Combines independent page additions when the server reports no block edits
 * and every base block remains present on both sides. Returns undefined when
 * the conflict needs user review.
 */
export function autoMergeUniquePageAdditions(
  conflict: SyncContentConflict,
): DocumentContent | undefined {
  if (!canMergePageAdditions(conflict)) return undefined;

  const localBlocks = conflict.localContent.content ?? [];
  const remoteBlocks = conflict.remoteContent.content ?? [];
  const baseIds = new Set((conflict.baseContent?.content ?? []).map(blockId).filter(isPresent));
  const localById = indexById(localBlocks);
  const remoteById = indexById(remoteBlocks);
  const hasChangeSummary = conflict.localChangedBlockIds !== undefined ||
    conflict.remoteChangedBlockIds !== undefined;

  if (sharedBlocksConflict(localById, remoteById, baseIds, hasChangeSummary)) return undefined;

  const remoteAdditions = collectRemoteAdditions(localBlocks, remoteBlocks, localById, baseIds);
  if (!remoteAdditions?.length) return undefined;

  return {
    ...conflict.localContent,
    type: conflict.localContent.type ?? 'doc',
    attrs: {
      ...conflict.localContent.attrs,
      jottathingConflictResolution: true,
      jottathingPreserveRemoteBlocks: true,
    },
    content: [...localBlocks, ...remoteAdditions],
  };
}

/** Restricts the automatic path to page snapshots with no reported block edits. */
function canMergePageAdditions(
  conflict: SyncContentConflict,
): conflict is SyncContentConflict & { remoteContent: DocumentContent } {
  return conflict.targetType === 'page' &&
    conflict.remoteContent !== null &&
    !conflict.localChangedBlockIds?.length &&
    !conflict.remoteChangedBlockIds?.length;
}

/** Requires base blocks to remain present and rejects unreported shared edits. */
function sharedBlocksConflict(
  localById: BlockIndex,
  remoteById: BlockIndex,
  baseIds: ReadonlySet<string>,
  hasChangeSummary: boolean,
): boolean {
  if (!hasChangeSummary) {
    for (const [id, local] of localById) {
      const remote = remoteById.get(id);
      if (remote && signature(local) !== signature(remote)) return true;
    }
  }

  for (const id of baseIds) {
    const local = localById.get(id);
    const remote = remoteById.get(id);
    if (!local || !remote) return true;
  }

  return false;
}

/** Returns remote-only blocks, or undefined if an addition may duplicate local content. */
function collectRemoteAdditions(
  localBlocks: DocumentContent[],
  remoteBlocks: DocumentContent[],
  localById: BlockIndex,
  baseIds: ReadonlySet<string>,
): DocumentContent[] | undefined {
  const localSignatures = new Set(localBlocks.map(signature));
  const additionSignatures = new Set<string>();
  const additions: DocumentContent[] = [];

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
    additions.push(remote);
  }

  return additions;
}

function blockId(block: DocumentContent): string | undefined {
  const value = block.attrs?.jottathingBlockId;
  return typeof value === 'string' && value ? value : undefined;
}

function indexById(blocks: DocumentContent[]): BlockIndex {
  return new Map(blocks.flatMap((block) => {
    const id = blockId(block);
    return id ? [[id, block] as const] : [];
  }));
}

function signature(block: DocumentContent): string {
  return syncConflictContentSignature(block, true);
}

function isPresent(value: string | undefined): value is string {
  return Boolean(value);
}
