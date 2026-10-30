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

  const additions = collectRemoteAdditions(localBlocks, remoteBlocks, localById, baseIds);
  if (!additions || (!additions.blocks.length && !additions.replacements.size)) return undefined;

  const mergedLocalBlocks = localBlocks.map((block, index) =>
    additions.replacements.get(index) ?? block,
  );

  return {
    ...conflict.localContent,
    type: conflict.localContent.type ?? 'doc',
    attrs: {
      ...conflict.localContent.attrs,
      jottathingConflictResolution: true,
      jottathingPreserveRemoteBlocks: true,
    },
    content: [...mergedLocalBlocks, ...additions.blocks],
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

/** Merges remote-only blocks and safely adopts Notion's identity for one empty duplicate. */
function collectRemoteAdditions(
  localBlocks: DocumentContent[],
  remoteBlocks: DocumentContent[],
  localById: BlockIndex,
  baseIds: ReadonlySet<string>,
): { blocks: DocumentContent[]; replacements: Map<number, DocumentContent> } | undefined {
  const localIndexesBySignature = new Map<string, number[]>();
  localBlocks.forEach((block, index) => {
    const id = blockId(block);
    if (id && baseIds.has(id)) return;
    const matches = localIndexesBySignature.get(signature(block)) ?? [];
    matches.push(index);
    localIndexesBySignature.set(signature(block), matches);
  });

  const remoteAdditionGroups = new Map<string, DocumentContent[]>();
  for (const remote of remoteBlocks) {
    const id = blockId(remote);
    if (id && localById.has(id)) continue;
    if (id && baseIds.has(id)) return undefined;
    const matches = remoteAdditionGroups.get(signature(remote)) ?? [];
    matches.push(remote);
    remoteAdditionGroups.set(signature(remote), matches);
  }

  const blocks: DocumentContent[] = [];
  const replacements = new Map<number, DocumentContent>();

  for (const [contentSignature, remoteMatches] of remoteAdditionGroups) {
    const localMatches = localIndexesBySignature.get(contentSignature) ?? [];
    if (localMatches.length || remoteMatches.length > 1) {
      // A lone empty paragraph on each side is a common page-creation race.
      // Keep Notion's block and identity; other identical additions need review.
      if (
        localMatches.length === 1 && remoteMatches.length === 1 &&
        isEmptyParagraph(localBlocks[localMatches[0]]) && isEmptyParagraph(remoteMatches[0])
      ) {
        replacements.set(localMatches[0], remoteMatches[0]);
        continue;
      }
      return undefined;
    }

    blocks.push(remoteMatches[0]);
  }

  return { blocks, replacements };
}

/** Recognizes a blank paragraph without treating other visually empty blocks as disposable. */
function isEmptyParagraph(block: DocumentContent | undefined): boolean {
  return block?.type === 'paragraph' && (block.content ?? []).every((child) =>
    child.type === 'text' && !child.text?.trim(),
  );
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
  if (isEmptyParagraph(block)) return 'empty-paragraph';
  return syncConflictContentSignature(block, true);
}

function isPresent(value: string | undefined): value is string {
  return Boolean(value);
}
