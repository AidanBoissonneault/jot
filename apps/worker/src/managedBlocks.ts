/**
 * @file Reconciles ordered local editor blocks with their managed Notion block counterparts.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { DocumentContent } from '../../../src/types/capture.js';
import type {
  BlockMapping,
  HashValue,
  ListAllBlockChildren,
  ManagedBlockResult,
  NotionBlock,
  NotionBlockPayload,
  WorkerStore,
} from './types.js';
import {
  desiredManagedBlocks,
  hasReorderedManagedBlocks,
  isUpdateCompatible,
  mappingFromDesired,
  positionAfter,
} from './managedBlockIdentity.js';
import { managedBlockSignature } from './managedBlockSignatures.js';
import type { BlockPosition, DesiredManagedBlock } from './managedBlockIdentity.js';
import { rebuildReorderedRange, reconcileManagedBlocks } from './managedBlockReconciliation.js';
import { notionBlocksToTiptapDocumentStrict } from './blockConversion/notionToTiptap.js';
import { mediaFallbackBlock } from './workerUtils.js';

export const UNMAPPED_NOTION_CONTENT_CODE = 'unmapped_notion_content';
export const UNMAPPED_NOTION_CONTENT_MESSAGE =
  'Notion and local content differ in blocks that could not be matched automatically. Review the sync diff and merge the blocks.';

export type UnmappedNotionContentDiff = {
  baseContent?: DocumentContent | null;
  reason?: 'merge' | 'duplicates';
  localChangedBlockIds?: string[];
  remoteChangedBlockIds?: string[];
  localContent: DocumentContent;
  remoteContent: DocumentContent | null;
};

/** A safe-to-stop sync conflict caused by remote blocks absent from local mappings. */
export class UnmappedNotionContentError extends Error {
  readonly code = UNMAPPED_NOTION_CONTENT_CODE;
  readonly diff: UnmappedNotionContentDiff;

  constructor(diff: UnmappedNotionContentDiff) {
    super(diff.reason === 'duplicates'
      ? 'Identical new blocks were added in Jottathing and Notion. Choose which copies to keep.'
      : UNMAPPED_NOTION_CONTENT_MESSAGE);
    this.name = 'UnmappedNotionContentError';
    this.diff = diff;
  }
}

/** Identifies the content conflict that must be resolved by reloading remote state. */
export function isUnmappedNotionContentError(error: unknown): error is UnmappedNotionContentError {
  return error instanceof UnmappedNotionContentError || (
    error instanceof Error &&
    'code' in error &&
    error.code === UNMAPPED_NOTION_CONTENT_CODE
  );
}

/** Describes the append managed blocks contract used by this API feature. */
type AppendManagedBlocks = (
  store: WorkerStore,
  notionPageId: string,
  blocks: NotionBlockPayload[],
  position?: BlockPosition,
) => Promise<NotionBlock[]>;
/** Describes the delete managed block contract used by this API feature. */
type DeleteManagedBlock = (store: WorkerStore, blockId: string) => Promise<unknown>;
/** Describes the update managed block contract used by this API feature. */
type UpdateManagedBlock = (
  store: WorkerStore,
  blockId: string,
  block: NotionBlockPayload,
) => Promise<unknown>;
/** Describes the convert document contract used by this API feature. */
type ConvertDocument = (content: DocumentContent) => NotionBlockPayload[];
/** Describes the classify block contract used by this API feature. */
type ClassifyBlock = (block: Pick<NotionBlockPayload, 'type'>) => string;

/** Describes the managed block dependencies contract used by this API feature. */
interface ManagedBlockDependencies {
  appendManagedBlocks: AppendManagedBlocks;
  deleteManagedBlock: DeleteManagedBlock;
  hash: HashValue;
  kindFromNotionBlock: ClassifyBlock;
  tiptapDocumentToNotionBlocks: ConvertDocument;
  updateManagedBlock: UpdateManagedBlock;
}

/** Describes the replace managed blocks options contract used by this API feature. */
interface ReplaceManagedBlocksOptions extends ManagedBlockDependencies {
  baselineContent?: DocumentContent;
  content: DocumentContent;
  listAllBlockChildren: ListAllBlockChildren;
  localPageId: string;
  notionPageId: string;
  store: WorkerStore;
}

/**
 * Reconciles an entire local document with its managed Notion children.
 * @param options - Document state, mapping store, and Notion mutation dependencies.
 * @returns Created blocks aligned to local order and the outbound payloads.
 */
export async function replaceManagedBlocks({
  store,
  localPageId,
  notionPageId,
  content,
  baselineContent,
  listAllBlockChildren,
  deleteManagedBlock,
  appendManagedBlocks,
  updateManagedBlock,
  tiptapDocumentToNotionBlocks,
  kindFromNotionBlock,
  hash,
}: ReplaceManagedBlocksOptions) {
  let notionBlocks = tiptapDocumentToNotionBlocks(content);
  let desiredBlocks = desiredManagedBlocks({
    content,
    hash,
    kindFromNotionBlock,
    localPageId,
    notionBlocks,
  });
  const existingMappings = store.blockMappings[localPageId] ?? [];
  restoreLocalBlockBaseline(
    existingMappings,
    baselineContent,
    hash,
    kindFromNotionBlock,
    localPageId,
    tiptapDocumentToNotionBlocks,
  );
  const isUserReviewedReplacement = content.attrs?.jottathingConflictResolution === true;

  // An empty document may be a partial queue envelope. Never interpret it as
  // permission to erase the remote note.
  if (!desiredBlocks.length && !isUserReviewedReplacement) {
    return { createdBlocks: [], content, baselineContent: baselineContent ?? content, notionBlocks };
  }

  if (isUserReviewedReplacement) {
    const result = await replaceAfterUserConflictResolution({
      appendManagedBlocks,
      deleteManagedBlock,
      desiredBlocks,
      content,
      listAllBlockChildren,
      localPageId,
      notionBlocks,
      notionPageId,
      store,
      updateManagedBlock,
    });
    return { ...result, content, baselineContent: content };
  }

  if (!existingMappings.length) {
    const remoteBlocks = await listAllBlockChildren(store, notionPageId);
    if (
      hasUnresolvedExactDuplicates(existingMappings, desiredBlocks, remoteBlocks) &&
      notionBlocksToTiptapDocumentStrict(remoteBlocks)
    ) {
      throw createContentConflict(content, remoteBlocks, existingMappings, desiredBlocks, 'duplicates');
    }
    const mergedContent = appendRemoteOnlyAdditions(
      content,
      desiredBlocks,
      remoteBlocks,
      new Set(),
    );
    if (mergedContent !== content) {
      content = mergedContent;
      notionBlocks = tiptapDocumentToNotionBlocks(content);
      desiredBlocks = desiredManagedBlocks({
        content,
        hash,
        kindFromNotionBlock,
        localPageId,
        notionBlocks,
      });
    }

    const result = await replaceAllManagedBlocks({
      appendManagedBlocks,
      desiredBlocks,
      listAllBlockChildren,
      localPageId,
      notionBlocks,
      notionPageId,
      store,
    });
    await pruneExactRemoteDuplicates({
      deleteManagedBlock,
      desiredBlocks,
      listAllBlockChildren,
      localPageId,
      notionPageId,
      store,
    });
    return { ...result, content, baselineContent: content };
  }

  const remoteBlocks = await listAllBlockChildren(store, notionPageId);
  repairMappingsByContent(existingMappings, desiredBlocks, remoteBlocks, content);
  if (hasUnresolvedRemoteChanges(existingMappings, desiredBlocks, remoteBlocks)) {
    throw createContentConflict(content, remoteBlocks, existingMappings, desiredBlocks, 'merge');
  }
  if (hasUnresolvedExactDuplicates(existingMappings, desiredBlocks, remoteBlocks)) {
    if (notionBlocksToTiptapDocumentStrict(remoteBlocks)) {
      throw createContentConflict(content, remoteBlocks, existingMappings, desiredBlocks, 'duplicates');
    }
  }

  let mergedContent = mergeRemoteOnlyChangesIntoContent(
    content,
    existingMappings,
    desiredBlocks,
    remoteBlocks,
  );
  mergedContent = appendRemoteOnlyAdditions(
    mergedContent,
    desiredBlocks,
    remoteBlocks,
    new Set(existingMappings.map((mapping) => mapping.notionBlockId).filter(isPresent)),
  );
  if (mergedContent !== content) {
    content = mergedContent;
    notionBlocks = tiptapDocumentToNotionBlocks(content);
    desiredBlocks = desiredManagedBlocks({
      content,
      hash,
      kindFromNotionBlock,
      localPageId,
      notionBlocks,
    });
    repairMappingsByContent(existingMappings, desiredBlocks, remoteBlocks, content);
  }

  let result: ManagedBlockResult;
  if (hasReorderedManagedBlocks(existingMappings, desiredBlocks)) {
    result = await rebuildReorderedRange({
      appendManagedBlocks,
      deleteManagedBlock,
      desiredBlocks,
      existingMappings,
      listAllBlockChildren,
      localPageId,
      notionBlocks,
      notionPageId,
      store,
    });
  } else {
    result = await reconcileManagedBlocks({
      appendManagedBlocks,
      deleteManagedBlock,
      desiredBlocks,
      existingMappings,
      listAllBlockChildren,
      localPageId,
      notionBlocks,
      notionPageId,
      store,
      updateManagedBlock,
    });
  }

  await pruneExactRemoteDuplicates({
    deleteManagedBlock,
    desiredBlocks,
    listAllBlockChildren,
    localPageId,
    notionPageId,
    store,
  });

  return { ...result, content, baselineContent: content };
}

/** Rehydrates comparison baselines from the locally stored last synced snapshot. */
export function restoreLocalBlockBaseline(
  mappings: BlockMapping[],
  baselineContent: DocumentContent | undefined,
  hash: HashValue,
  kindFromNotionBlock: ClassifyBlock,
  localPageId: string,
  tiptapDocumentToNotionBlocks: ConvertDocument,
): void {
  if (!baselineContent) return;
  const baselineBlocks = tiptapDocumentToNotionBlocks(baselineContent);
  const desired = desiredManagedBlocks({
    content: baselineContent,
    hash,
    kindFromNotionBlock,
    localPageId,
    notionBlocks: baselineBlocks,
  });
  const baselineById = new Map(desired.map((entry) => [entry.jottathingBlockId, entry]));
  for (const mapping of mappings) {
    const id = mapping.jottathingBlockId ?? mapping.localNodeId;
    const baseline = baselineById.get(id);
    if (!baseline) continue;
    mapping.localBaselineAcknowledged = true;
    mapping.newState = baseline.notionBlock;
    mapping.lastSyncedHash = baseline.lastSyncedHash;
  }
}

/** Adds remote-only children while leaving exact local/remote additions for deduplication. */
function appendRemoteOnlyAdditions(
  content: DocumentContent,
  desiredBlocks: DesiredManagedBlock[],
  remoteBlocks: NotionBlock[],
  mappedRemoteIds: Set<string>,
): DocumentContent {
  const localSignatures = new Set(desiredBlocks.map((desired) =>
    managedBlockSignature(desired.notionBlock),
  ));
  const additions = remoteBlocks.flatMap((remote) => {
    if (
      mappedRemoteIds.has(remote.id) ||
      localSignatures.has(managedBlockSignature(remote))
    ) return [];

    const imported = notionBlocksToTiptapDocumentStrict([remote])?.content?.[0];
    if (!imported) return [];
    const uploadId = fileUploadIdFromBlock(remote);
    return [{
      ...imported,
      attrs: {
        ...imported.attrs,
        jottathingBlockId: `notion-${remote.id}`,
        notionBlockId: remote.id,
        ...(uploadId ? { notionFileUploadId: uploadId, uploadState: 'done' } : {}),
      },
    }];
  });

  return additions.length
    ? { ...content, type: content.type ?? 'doc', content: [...(content.content ?? []), ...additions] }
    : content;
}

/** Removes redundant remote copies after a conflict-free reconciliation. */
async function pruneExactRemoteDuplicates({
  deleteManagedBlock,
  desiredBlocks,
  listAllBlockChildren,
  localPageId,
  notionPageId,
  store,
}: {
  deleteManagedBlock: DeleteManagedBlock;
  desiredBlocks: DesiredManagedBlock[];
  listAllBlockChildren: ListAllBlockChildren;
  localPageId: string;
  notionPageId: string;
  store: WorkerStore;
}): Promise<void> {
  const remoteBlocks = await listAllBlockChildren(store, notionPageId);
  const mappings = store.blockMappings[localPageId] ?? [];
  const mappedRemoteIds = new Set(mappings.map((mapping) => mapping.notionBlockId).filter(isPresent));
  const desiredCapacity = new Map<string, number>();
  for (const desired of desiredBlocks) {
    const signature = managedBlockSignature(desired.notionBlock);
    desiredCapacity.set(signature, (desiredCapacity.get(signature) ?? 0) + 1);
  }
  const mappedCapacity = new Map<string, number>();
  for (const mapping of mappings) {
    const remote = remoteBlocks.find((block) => block.id === mapping.notionBlockId);
    if (!remote) continue;
    const signature = managedBlockSignature(remote);
    if (!desiredCapacity.has(signature)) continue;
    mappedCapacity.set(signature, (mappedCapacity.get(signature) ?? 0) + 1);
  }

  for (const remote of remoteBlocks) {
    if (mappedRemoteIds.has(remote.id)) continue;
    const signature = managedBlockSignature(remote);
    const capacity = desiredCapacity.get(signature) ?? 0;
    if (capacity && (mappedCapacity.get(signature) ?? 0) >= capacity) {
      await deleteManagedBlock(store, remote.id);
    }
  }
}

/** Imports remote-only edits into the local snapshot after the three-way check. */
function mergeRemoteOnlyChangesIntoContent(
  content: DocumentContent,
  mappings: BlockMapping[],
  desiredBlocks: DesiredManagedBlock[],
  remoteBlocks: NotionBlock[],
): DocumentContent {
  const localNodes = content.content ?? [];
  const desiredById = new Map(desiredBlocks.map((desired) => [desired.jottathingBlockId, desired]));
  const remoteById = new Map(remoteBlocks.map((block) => [block.id, block]));
  const removedNodeIndexes = new Set<number>();
  const replacementsByIndex = new Map<number, DocumentContent>();
  let changed = false;

  for (const mapping of mappings) {
    if (!mapping.newState) continue;
    const blockId = mapping.jottathingBlockId ?? mapping.localNodeId;
    const desired = desiredById.get(blockId);
    const nodeIndex = desired?.order;
    const local = nodeIndex === undefined ? undefined : localNodes[nodeIndex];
    if (!desired || nodeIndex === undefined || !local) continue;

    const remote = mapping.notionBlockId ? remoteById.get(mapping.notionBlockId) : undefined;
    const baseSignature = managedBlockSignature(mapping.newState);
    const localMatchesBase = localMediaMatchesBaseline(mapping, desired) ??
      managedBlockSignature(desired.notionBlock) === baseSignature;

    if (!remote && localMatchesBase) {
      removedNodeIndexes.add(nodeIndex);
      changed = true;
      continue;
    }
    if (!remote || !localMatchesBase) continue;

    const remoteMatchesBase = remoteMediaMatchesBaseline(mapping, desired, remote) ??
      managedBlockSignature(remote) === baseSignature;
    if (remoteMatchesBase) continue;

    const imported = notionBlocksToTiptapDocumentStrict([remote])?.content?.[0];
    if (!imported) continue;
    const isMedia = imported.type === 'image' || imported.type === 'audio';
    const uploadId = fileUploadIdFromBlock(remote) ?? fileUploadIdFromState(mapping.newState);
    replacementsByIndex.set(nodeIndex, {
      ...imported,
      attrs: {
        ...(isMedia ? local?.attrs : {}),
        ...imported.attrs,
        jottathingBlockId: blockId,
        notionBlockId: remote.id,
        ...(uploadId ? { notionFileUploadId: uploadId, uploadState: 'done' } : {}),
      },
    });
    changed = true;
  }

  return changed
    ? {
        ...content,
        type: content.type ?? 'doc',
        content: localNodes.flatMap((node, index) =>
          removedNodeIndexes.has(index)
            ? []
            : [replacementsByIndex.get(index) ?? node],
        ),
      }
    : content;
}

/** Replaces all managed children after the user reviews and confirms the merged document. */
async function replaceAfterUserConflictResolution({
  appendManagedBlocks,
  deleteManagedBlock,
  desiredBlocks,
  content,
  listAllBlockChildren,
  localPageId,
  notionBlocks,
  notionPageId,
  store,
  updateManagedBlock,
}: {
  appendManagedBlocks: AppendManagedBlocks;
  deleteManagedBlock: DeleteManagedBlock;
  desiredBlocks: DesiredManagedBlock[];
  content: DocumentContent;
  listAllBlockChildren: ListAllBlockChildren;
  localPageId: string;
  notionBlocks: NotionBlockPayload[];
  notionPageId: string;
  store: WorkerStore;
  updateManagedBlock: UpdateManagedBlock;
}) {
  if (content.attrs?.jottathingPreserveRemoteBlocks === true) {
    return preserveRemoteBlocksAfterUserConflictResolution({
      appendManagedBlocks,
      content,
      deleteManagedBlock,
      desiredBlocks,
      listAllBlockChildren,
      localPageId,
      notionBlocks,
      notionPageId,
      store,
      updateManagedBlock,
    });
  }

  const remoteBlocks = await listAllBlockChildren(store, notionPageId);
  const mappingByJottathingId = new Map(
    (store.blockMappings[localPageId] ?? []).map((mapping) => [
      mapping.jottathingBlockId ?? mapping.localNodeId,
      mapping,
    ]),
  );
  let reusedCount = 0;
  const maxReusable = Math.min(remoteBlocks.length, desiredBlocks.length);
  for (let count = maxReusable; count > 0; count -= 1) {
    const suffix = remoteBlocks.slice(-count);
    const matches = suffix.every((remote, index) => {
      const desired = desiredBlocks[index];
      if (!desired) return false;
      const mapping = mappingByJottathingId.get(desired.jottathingBlockId);
      return managedBlockSignature(remote) === managedBlockSignature(desired.notionBlock) ||
        Boolean(mapping && mappedMediaMatches(mapping, desired, remote));
    });
    if (matches) {
      reusedCount = count;
      break;
    }
  }

  const reusedBlocks = reusedCount ? remoteBlocks.slice(-reusedCount) : [];
  const appendedBlocks = notionBlocks.length > reusedCount
    ? await appendManagedBlocks(store, notionPageId, notionBlocks.slice(reusedCount))
    : [];
  if (appendedBlocks.length !== notionBlocks.length - reusedCount) {
    throw new Error('Notion did not confirm every merged block; the original sync remains available for retry.');
  }

  const createdBlocks = [...reusedBlocks, ...appendedBlocks];
  const retainedIds = new Set(reusedBlocks.map((block) => block.id));
  // Keep the prior remote copy until Notion confirms the complete replacement.
  // A permission error or rejected media block must not erase the only copy.
  for (const block of remoteBlocks) {
    if (!retainedIds.has(block.id)) await deleteManagedBlock(store, block.id);
  }

  store.blockMappings[localPageId] = desiredBlocks
    .map((entry, index) => mappingFromDesired(entry, createdBlocks[index]?.id, {}, createdBlocks[index]))
    .filter((mapping) => mapping.notionBlockId);
  return { createdBlocks, notionBlocks };
}

/** Applies a reviewed additive merge while retaining each confirmed Notion child. */
async function preserveRemoteBlocksAfterUserConflictResolution({
  appendManagedBlocks,
  content,
  deleteManagedBlock,
  desiredBlocks,
  listAllBlockChildren,
  localPageId,
  notionBlocks,
  notionPageId,
  store,
  updateManagedBlock,
}: {
  appendManagedBlocks: AppendManagedBlocks;
  content: DocumentContent;
  deleteManagedBlock: DeleteManagedBlock;
  desiredBlocks: DesiredManagedBlock[];
  listAllBlockChildren: ListAllBlockChildren;
  localPageId: string;
  notionBlocks: NotionBlockPayload[];
  notionPageId: string;
  store: WorkerStore;
  updateManagedBlock: UpdateManagedBlock;
}) {
  const remoteBlocks = await listAllBlockChildren(store, notionPageId);
  const remoteById = new Map(remoteBlocks.map((block) => [block.id, block]));
  const isUserReviewedMerge = content.attrs?.jottathingConflictResolution === true;
  const knownRemoteIds = new Set(remoteBlocks.map((block) => block.id));
  const mappingByJottathingId = new Map(
    (store.blockMappings[localPageId] ?? []).map((mapping) => [
      mapping.jottathingBlockId ?? mapping.localNodeId,
      mapping,
    ]),
  );
  const forcedRemoteIds = new Set<string>();
  for (const desired of desiredBlocks) {
    const node = content.content?.[desired.order];
    const mapping = mappingByJottathingId.get(desired.jottathingBlockId);
    const explicitRemoteId = stringValue(node?.attrs?.notionBlockId);
    if (explicitRemoteId) forcedRemoteIds.add(explicitRemoteId);
    if (mapping?.notionBlockId) forcedRemoteIds.add(mapping.notionBlockId);
  }

  const usedRemoteIds = new Set<string>();
  const createdBlocks: Array<NotionBlock | undefined> = [];
  const nextMappings: BlockMapping[] = [];
  let previousBlockId: string | undefined;

  for (const desired of desiredBlocks) {
    const node = content.content?.[desired.order];
    const mapping = mappingByJottathingId.get(desired.jottathingBlockId);
    const explicitRemoteId = stringValue(node?.attrs?.notionBlockId);
    const mappedRemoteId = mapping?.notionBlockId;
    let remote = explicitRemoteId ? remoteById.get(explicitRemoteId) : undefined;
    if (!remote && mappedRemoteId) remote = remoteById.get(mappedRemoteId);
    let wasUpdated = false;

    if (remote && usedRemoteIds.has(remote.id)) remote = undefined;
    if (!remote) {
      const signature = managedBlockSignature(desired.notionBlock);
      remote = remoteBlocks.find((block) =>
        !usedRemoteIds.has(block.id) &&
        !forcedRemoteIds.has(block.id) &&
        managedBlockSignature(block) === signature,
      );
    }

    if (remote) {
      const matches = managedBlockSignature(remote) === managedBlockSignature(desired.notionBlock) ||
        Boolean(mapping && mappedMediaMatches(mapping, desired, remote));
      const isReviewedChoice = isUserReviewedMerge && Boolean(mapping || explicitRemoteId);
      // Stored mappings can lag a remote type change; Notion rejects PATCHes
      // that send one block type's fields to a different existing block type.
      const canUpdateBlockInPlace = mapping &&
        remote.type === desired.notionBlock.type &&
        isUpdateCompatible(mapping, desired);
      if (!matches && isReviewedChoice && canUpdateBlockInPlace) {
        await updateManagedBlock(store, remote.id, desired.notionBlock);
        wasUpdated = true;
      } else if (!matches && isReviewedChoice) {
        const superseded = remote;
        const desiredSignature = managedBlockSignature(desired.notionBlock);
        const replacementAlreadyCreated = remoteBlocks.find((block) =>
          block.id !== superseded.id &&
          !usedRemoteIds.has(block.id) &&
          !forcedRemoteIds.has(block.id) &&
          managedBlockSignature(block) === desiredSignature,
        );
        remote = replacementAlreadyCreated ?? await appendReviewedMergeBlock(
          store,
          notionPageId,
          desired.notionBlock,
          positionAfter(previousBlockId),
          knownRemoteIds,
          appendManagedBlocks,
          listAllBlockChildren,
        );
        await deleteManagedBlock(store, superseded.id);
      } else if (!matches) {
        throw new Error('The reviewed Notion block changed again. Reload its latest version and retry the merge.');
      }
    } else {
      const created = await appendReviewedMergeBlock(
        store,
        notionPageId,
        desired.notionBlock,
        positionAfter(previousBlockId),
        knownRemoteIds,
        appendManagedBlocks,
        listAllBlockChildren,
      );
      remote = created;
    }

    usedRemoteIds.add(remote.id);
    createdBlocks[desired.order] = remote;
    nextMappings.push(mappingFromDesired(
      desired,
      remote.id,
      mapping,
      wasUpdated ? desired.notionBlock : remote,
    ));
    previousBlockId = remote.id;
  }

  const explicitlyDeletedIds = new Set(
    Array.isArray(content.attrs?.jottathingDeleteNotionBlockIds)
      ? content.attrs.jottathingDeleteNotionBlockIds.filter((id): id is string => typeof id === 'string')
      : [],
  );
  for (const blockId of explicitlyDeletedIds) {
    if (remoteById.has(blockId) && !usedRemoteIds.has(blockId)) {
      await deleteManagedBlock(store, blockId);
    }
  }

  store.blockMappings[localPageId] = nextMappings.filter((mapping) => mapping.notionBlockId);
  return { createdBlocks, notionBlocks };
}

/** Confirms a merge append by ID or discovers it after an incomplete API response. */
async function appendReviewedMergeBlock(
  store: WorkerStore,
  notionPageId: string,
  notionBlock: NotionBlockPayload,
  position: BlockPosition,
  knownRemoteIds: Set<string>,
  appendManagedBlocks: AppendManagedBlocks,
  listAllBlockChildren: ListAllBlockChildren,
): Promise<NotionBlock> {
  let appendError: unknown;
  try {
    const [created] = await appendManagedBlocks(
      store,
      notionPageId,
      [notionBlock],
      position,
    );
    if (created?.id) {
      knownRemoteIds.add(created.id);
      return created;
    }
  } catch (error) {
    appendError = error;
  }

  let currentBlocks: NotionBlock[];
  try {
    currentBlocks = await listAllBlockChildren(store, notionPageId);
  } catch (readError) {
    throw appendError ?? readError;
  }

  const signatures = new Set([
    managedBlockSignature(notionBlock),
    managedBlockSignature(mediaFallbackBlock(notionBlock)),
  ]);
  const confirmed = currentBlocks.find((block) =>
    !knownRemoteIds.has(block.id) && signatures.has(managedBlockSignature(block)),
  );
  if (confirmed) {
    knownRemoteIds.add(confirmed.id);
    return confirmed;
  }

  if (appendError) throw appendError;
  throw new Error('Notion did not confirm the new merged block; existing content remains available for retry.');
}

/** Repairs stale Notion IDs by matching saved mapping content to current remote blocks. */
function repairMappingsByContent(
  existingMappings: BlockMapping[],
  desiredBlocks: DesiredManagedBlock[],
  remoteBlocks: NotionBlock[],
  content: DocumentContent,
): void {
  const remoteById = new Map(remoteBlocks.map((block) => [block.id, block]));
  const desiredById = new Map(desiredBlocks.map((entry) => [entry.jottathingBlockId, entry]));
  const usedRemoteIds = new Set<string>();
  const orderedMappings = existingMappings.slice().sort((first, second) => first.order - second.order);
  const explicitLocalChoices = new Set(
    (content.content ?? [])
      .filter((node) => node.attrs?.jottathingConflictResolution === true)
      .map((node) => node.attrs?.jottathingBlockId)
      .filter((id): id is string => typeof id === 'string'),
  );

  for (const mapping of orderedMappings) {
    const desired = desiredById.get(mapping.jottathingBlockId ?? mapping.localNodeId);
    const current = mapping.notionBlockId ? remoteById.get(mapping.notionBlockId) : undefined;
    const expectedSignature = mapping.newState ? managedBlockSignature(mapping.newState) : undefined;
    const desiredSignature = desired ? managedBlockSignature(desired.notionBlock) : undefined;

    if (current && explicitLocalChoices.has(mapping.jottathingBlockId ?? mapping.localNodeId)) {
      mapping.newState = current as unknown as NotionBlockPayload;
      usedRemoteIds.add(current.id);
      continue;
    }

    if (current && (
      mappedMediaMatches(mapping, desired, current) ||
      managedBlockSignature(current) === expectedSignature ||
      managedBlockSignature(current) === desiredSignature
    )) {
      usedRemoteIds.add(current.id);
      continue;
    }

    // An existing Notion ID is the block's identity. Do not reassign a
    // changed block to another equal-looking child; that can hide a real
    // two-sided edit when a duplicate happens to exist nearby.
    if (current) {
      usedRemoteIds.add(current.id);
      continue;
    }

    const match = findUnclaimedRemoteBlock(
      remoteBlocks,
      usedRemoteIds,
      [expectedSignature, desiredSignature],
      mapping.order,
    );
    if (match) {
      mapping.notionBlockId = match.id;
      usedRemoteIds.add(match.id);
    } else if (!current) {
      // A remotely deleted block can be safely recreated by the normal reconcile pass.
      mapping.notionBlockId = undefined;
    } else {
      usedRemoteIds.add(current.id);
    }
  }

  // Remote-only additions imported into local content carry their Notion ID.
  // Adopt those by identity, but do not pair unbased local additions by equal
  // content here; the duplicate review pool must see those as separate blocks.
  for (const desired of desiredBlocks) {
    if (existingMappings.some((entry) =>
      (entry.jottathingBlockId ?? entry.localNodeId) === desired.jottathingBlockId,
    )) continue;
    const node = content.content?.[desired.order];
    const notionId = stringValue(node?.attrs?.notionBlockId);
    const remote = notionId ? remoteById.get(notionId) : undefined;
    if (!remote || usedRemoteIds.has(remote.id)) continue;
    existingMappings.push({
      localPageId: desired.localPageId,
      jottathingBlockId: desired.jottathingBlockId,
      localNodeId: desired.localNodeId,
      notionBlockId: remote.id,
      kind: desired.kind,
      order: desired.order,
      lastSyncedHash: desired.lastSyncedHash,
      oldState: null,
      newState: remote as unknown as NotionBlockPayload,
    });
    usedRemoteIds.add(remote.id);
  }

}

function findUnclaimedRemoteBlock(
  remoteBlocks: NotionBlock[],
  claimedIds: Set<string>,
  signatures: Array<string | undefined>,
  expectedOrder: number,
): NotionBlock | undefined {
  const candidates = remoteBlocks.filter((block) =>
    !claimedIds.has(block.id) && signatures.includes(managedBlockSignature(block)),
  );
  return candidates.find((block) => remoteBlocks.indexOf(block) === expectedOrder) ?? candidates[0];
}

function hasUnresolvedRemoteChanges(
  mappings: BlockMapping[],
  desiredBlocks: DesiredManagedBlock[],
  remoteBlocks: NotionBlock[],
): boolean {
  const desiredById = new Map(desiredBlocks.map((entry) => [entry.jottathingBlockId, entry]));
  const remoteById = new Map(remoteBlocks.map((block) => [block.id, block]));

  for (const mapping of mappings) {
    const desired = desiredById.get(mapping.jottathingBlockId ?? mapping.localNodeId);
    const remote = mapping.notionBlockId
      ? remoteById.get(mapping.notionBlockId)
      : undefined;
    const baseState = mapping.newState;

    // Without a shared baseline we cannot say both sides edited the same
    // block. Treat an unmatched new remote block as an addition; the merge
    // pool handles exact duplicate additions separately.
    if (!baseState) continue;

    const baseSignature = managedBlockSignature(baseState);
    const desiredSignature = desired ? managedBlockSignature(desired.notionBlock) : undefined;
    const remoteSignature = remote ? managedBlockSignature(remote) : undefined;
    const localMatchesBase = localMediaMatchesBaseline(mapping, desired);
    const remoteMatchesBase = remote
      ? remoteMediaMatchesBaseline(mapping, desired, remote)
      : undefined;
    const localChanged = !desired || localMatchesBase === false || (
      localMatchesBase === undefined && desiredSignature !== baseSignature
    );
    const remoteChanged = !remote || remoteMatchesBase === false || (
      remoteMatchesBase === undefined && remoteSignature !== baseSignature
    );
    const bothSidesAgree = (!desired && !remote) || Boolean(
      desired && remote && (
        mappedMediaMatches(mapping, desired, remote) || desiredSignature === remoteSignature
      ),
    );

    if (localChanged && remoteChanged && !bothSidesAgree) return true;
  }
  return false;
}

/** Detects identical independent additions so the review pool can ask separately. */
function hasUnresolvedExactDuplicates(
  mappings: BlockMapping[],
  desiredBlocks: DesiredManagedBlock[],
  remoteBlocks: NotionBlock[],
): boolean {
  const mappingByLocalId = new Map(mappings.map((mapping) => [
    mapping.jottathingBlockId ?? mapping.localNodeId,
    mapping,
  ]));
  const mappedRemoteIds = new Set(
    mappings.map((mapping) => mapping.notionBlockId).filter(isPresent),
  );
  const unbasedLocalSignatures = new Set(desiredBlocks.flatMap((desired) => {
    const mapping = mappingByLocalId.get(desired.jottathingBlockId);
    return !mapping?.newState ? [managedBlockSignature(desired.notionBlock)] : [];
  }));

  return remoteBlocks.some((remote) =>
    !mappedRemoteIds.has(remote.id) &&
    unbasedLocalSignatures.has(managedBlockSignature(remote)),
  );
}

/** Matches imported Notion files whose temporary URL shape differs from the upload payload. */
function mappedMediaMatches(
  mapping: BlockMapping,
  desired: DesiredManagedBlock | undefined,
  remote: NotionBlock,
): boolean {
  if (remote.type !== 'image' && remote.type !== 'audio') return false;
  const desiredUrl = desired ? mediaUrlFromState(desired.notionBlock) : undefined;
  const remoteUrl = mediaUrlFromState(remote as unknown as NotionBlockPayload);
  const localMatchesBase = localMediaMatchesBaseline(mapping, desired);
  const remoteMatchesBase = remoteMediaMatchesBaseline(mapping, desired, remote);
  return (localMatchesBase === true && remoteMatchesBase === true) ||
    Boolean(desiredUrl && remoteUrl && stableMediaUrl(desiredUrl) === stableMediaUrl(remoteUrl));
}

function localMediaMatchesBaseline(
  mapping: BlockMapping,
  desired: DesiredManagedBlock | undefined,
): boolean | undefined {
  if (!desired || (desired.notionBlock.type !== 'image' && desired.notionBlock.type !== 'audio')) {
    return undefined;
  }
  const baseUploadId = fileUploadIdFromState(mapping.newState);
  const desiredUploadId = fileUploadIdFromState(desired.notionBlock);
  if (baseUploadId && desiredUploadId) return baseUploadId === desiredUploadId;
  const baseUrl = mapping.newState ? mediaUrlFromState(mapping.newState) : undefined;
  const desiredUrl = mediaUrlFromState(desired.notionBlock);
  if (baseUrl && desiredUrl) return stableMediaUrl(baseUrl) === stableMediaUrl(desiredUrl);
  return undefined;
}

function remoteMediaMatchesBaseline(
  mapping: BlockMapping,
  desired: DesiredManagedBlock | undefined,
  remote: NotionBlock,
): boolean | undefined {
  if (remote.type !== 'image' && remote.type !== 'audio') return undefined;
  const baseUploadId = fileUploadIdFromState(mapping.newState);
  const remoteUploadId = fileUploadIdFromBlock(remote);
  if (baseUploadId && remoteUploadId) return baseUploadId === remoteUploadId;
  const baseUrl = mapping.newState ? mediaUrlFromState(mapping.newState) : undefined;
  const remoteUrl = mediaUrlFromState(remote as unknown as NotionBlockPayload);
  if (baseUrl && remoteUrl) return stableMediaUrl(baseUrl) === stableMediaUrl(remoteUrl);
  const desiredUploadId = desired ? fileUploadIdFromState(desired.notionBlock) : undefined;
  if (baseUploadId && baseUploadId === desiredUploadId && !baseUrl) return true;
  return undefined;
}

function mediaUrlFromState(state: NotionBlockPayload): string | undefined {
  const body = objectValue(state[state.type]);
  return body ? externalUrl(body) ?? fileUrl(body) ?? stringValue(body.url) : undefined;
}

function stableMediaUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.searchParams.has('X-Amz-Signature') || url.hostname.startsWith('prod-files-secure.s3.')) {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // Preserve malformed media URLs for exact comparison.
  }
  return value;
}

function createContentConflict(
  localContent: DocumentContent,
  remoteBlocks: NotionBlock[],
  mappings: BlockMapping[] = [],
  desiredBlocks: DesiredManagedBlock[] = [],
  reason: 'merge' | 'duplicates' = 'merge',
): UnmappedNotionContentError {
  const remoteContent = notionBlocksToTiptapDocumentStrict(remoteBlocks);
  const localById = new Map(
    (localContent.content ?? [])
      .map((node) => [stringValue(node.attrs?.jottathingBlockId), node] as const)
      .filter((entry): entry is readonly [string, DocumentContent] => Boolean(entry[0])),
  );
  const mappingByLocalId = new Map(
    mappings.map((mapping) => [mapping.jottathingBlockId ?? mapping.localNodeId, mapping]),
  );
  const desiredByLocalId = new Map(desiredBlocks.map((desired) => [desired.jottathingBlockId, desired]));
  const remoteByNotionId = new Map(remoteBlocks.map((block) => [block.id, block]));
  const normalizedLocalContent: DocumentContent = {
    ...localContent,
    content: (localContent.content ?? []).map((node, index) => {
      if (node.type !== 'image' && node.type !== 'audio') return node;
      const blockId = stringValue(node.attrs?.jottathingBlockId) ?? desiredBlocks[index]?.jottathingBlockId;
      const mapping = blockId ? mappingByLocalId.get(blockId) : undefined;
      const desired = blockId ? desiredByLocalId.get(blockId) : undefined;
      const remote = mapping?.notionBlockId ? remoteByNotionId.get(mapping.notionBlockId) : undefined;
      const baselineUploadId = mapping && localMediaMatchesBaseline(mapping, desired) === true &&
        (!remote || remoteMediaMatchesBaseline(mapping, desired, remote) === true)
        ? fileUploadIdFromState(mapping.newState)
        : undefined;
      const fileUploadId = stringValue(node.attrs?.notionFileUploadId) ?? baselineUploadId;
      if (!fileUploadId) return node;
      return {
        ...node,
        attrs: {
          ...node.attrs,
          notionFileUploadId: fileUploadId,
          uploadState: 'done',
          ...(mapping?.notionBlockId ? { notionBlockId: mapping.notionBlockId } : {}),
        },
      };
    }),
  };
  const mappingByRemoteId = new Map(
    mappings
      .filter((mapping) => mapping.notionBlockId)
      .map((mapping) => [mapping.notionBlockId!, mapping]),
  );
  const baseContent: DocumentContent = {
    type: 'doc',
    content: mappings
      .slice()
      .sort((first, second) => first.order - second.order)
      .flatMap((mapping) => {
        if (!mapping.newState) return [];
        const blockId = mapping.jottathingBlockId ?? mapping.localNodeId;
        const baseNode = documentNodeFromNotionState(
          mapping.newState,
          localById.get(blockId),
        );
        return baseNode
          ? [{ ...baseNode, attrs: { ...baseNode.attrs, jottathingBlockId: blockId } }]
          : [];
      }),
  };
  const localChangedBlockIds: string[] = [];
  const remoteChangedBlockIds: string[] = [];
  for (const mapping of mappings) {
    if (!mapping.newState) continue;
    const blockId = mapping.jottathingBlockId ?? mapping.localNodeId;
    const desired = desiredByLocalId.get(blockId);
    const remote = mapping.notionBlockId ? remoteByNotionId.get(mapping.notionBlockId) : undefined;
    const baseSignature = managedBlockSignature(mapping.newState);
    const localMatchesBase = localMediaMatchesBaseline(mapping, desired);
    if (!desired || localMatchesBase === false || (
      localMatchesBase === undefined && managedBlockSignature(desired.notionBlock) !== baseSignature
    )) {
      localChangedBlockIds.push(blockId);
    }
    const remoteMatchesBase = remote ? remoteMediaMatchesBaseline(mapping, desired, remote) : undefined;
    if (!remote || remoteMatchesBase === false || (
      remoteMatchesBase === undefined && managedBlockSignature(remote) !== baseSignature
    )) {
      remoteChangedBlockIds.push(blockId);
    }
  }
  if (remoteContent) {
    const mappedIdByNotionId = new Map(
      mappings
        .filter((mapping) => mapping.notionBlockId)
        .map((mapping) => [mapping.notionBlockId!, mapping.jottathingBlockId ?? mapping.localNodeId]),
    );
    remoteContent.content = remoteContent.content?.map((node, index) => {
      const notionId = remoteBlocks[index]?.id;
      const mapping = notionId ? mappingByRemoteId.get(notionId) : undefined;
      const blockId = notionId ? mappedIdByNotionId.get(notionId) : undefined;
      const fallbackState = mapping?.newState;
      // Equal content is not identity. Keeping unmatched Notion blocks
      // unpaired lets the conflict pool classify exact new duplicates as a
      // separate duplicate choice instead of hiding them as shared blocks.
      const nextId = blockId;
      const desired = nextId ? desiredByLocalId.get(nextId) : undefined;
      const remoteBlock = remoteBlocks[index];
      const baselineUploadId = mapping && remoteBlock &&
        remoteMediaMatchesBaseline(mapping, desired, remoteBlock) === true
        ? fileUploadIdFromState(fallbackState)
        : undefined;
      const fileUploadId = fileUploadIdFromBlock(remoteBlock) ?? baselineUploadId;
      const localNode = nextId ? localById.get(nextId) : undefined;
      const isMedia = node.type === 'image' || node.type === 'audio';
      return {
        ...node,
        attrs: {
          ...(isMedia ? localNode?.attrs : {}),
          ...node.attrs,
          ...(nextId ? { jottathingBlockId: nextId } : {}),
          ...(notionId ? { notionBlockId: notionId } : {}),
          ...(fileUploadId ? { notionFileUploadId: fileUploadId, uploadState: 'done' } : {}),
        },
      };
    });
  }
  return new UnmappedNotionContentError({
    baseContent,
    reason,
    localChangedBlockIds,
    remoteChangedBlockIds,
    localContent: normalizedLocalContent,
    remoteContent,
  });
}

/** Rebuilds a displayable Tiptap block from its last shared Notion payload. */
function documentNodeFromNotionState(
  state: NotionBlockPayload,
  fallback?: DocumentContent,
): DocumentContent | undefined {
  const type = state.type;
  const body = objectValue(state[type]);
  if (!type || !body) return undefined;

  const richText = Array.isArray(body.rich_text) ? body.rich_text : [];
  const inline = richText.flatMap((item) => {
    const value = objectValue(item);
    const text = objectValue(value?.text);
    const plainText = (stringValue(value?.plain_text) ?? stringValue(text?.content) ?? '')
      .replace(/\s*jottathing_capture_id:[\w-]+/g, '');
    if (!plainText) return [];
    const annotations = objectValue(value?.annotations) ?? {};
    const link = stringValue(value?.href) ?? stringValue(objectValue(text?.link)?.url);
    const marks = [
      ...(annotations.bold ? [{ type: 'bold' }] : []),
      ...(annotations.italic ? [{ type: 'italic' }] : []),
      ...(annotations.strikethrough ? [{ type: 'strike' }] : []),
      ...(annotations.underline ? [{ type: 'underline' }] : []),
      ...(annotations.code ? [{ type: 'code' }] : []),
      ...(link ? [{ type: 'link', attrs: { href: link } }] : []),
    ];
    return plainText.split('\n').flatMap((part, index) => [
      ...(index > 0 ? [{ type: 'hardBreak' }] : []),
      ...(part ? [{ type: 'text', text: part, ...(marks.length ? { marks } : {}) }] : []),
    ]);
  });

  if (type === 'paragraph') return { type, content: inline };
  if (type.startsWith('heading_')) {
    return { type: 'heading', attrs: { level: Number(type.at(-1)) }, content: inline };
  }
  if (type === 'quote') return { type: 'blockquote', content: [{ type: 'paragraph', content: inline }] };
  if (type === 'code') {
    return {
      type: 'codeBlock',
      attrs: { language: stringValue(body.language) ?? 'plaintext' },
      content: [{ type: 'text', text: richText.map((item) => {
        const value = objectValue(item);
        return stringValue(value?.plain_text) ?? stringValue(objectValue(value?.text)?.content) ?? '';
      }).join('') }],
    };
  }
  if (type === 'divider') return { type: 'horizontalRule' };
  if (type === 'image' || type === 'audio') {
    const fileUploadId = fileUploadIdFromState(state);
    const url = externalUrl(body) ?? fileUrl(body) ?? stringValue(fallback?.attrs?.src) ?? '';
    if (!url && !fileUploadId) return undefined;
    return {
      type,
      attrs: {
        ...fallback?.attrs,
        src: url,
        ...(fileUploadId ? { notionFileUploadId: fileUploadId, uploadState: 'done' } : {}),
      },
    };
  }
  if (type === 'video' || type === 'embed') {
    const url = externalUrl(body) ?? stringValue(body.url);
    return url ? { type: 'youtube', attrs: { src: url } } : undefined;
  }
  return undefined;
}

function fileUploadIdFromBlock(block: NotionBlock | undefined): string | undefined {
  return block ? fileUploadIdFromState(block as unknown as NotionBlockPayload) : undefined;
}

function fileUploadIdFromState(state: NotionBlockPayload | null | undefined): string | undefined {
  if (!state) return undefined;
  const body = objectValue(state[state.type]);
  const id = stringValue(objectValue(body?.file_upload)?.id);
  return id;
}

function externalUrl(body: Record<string, unknown>): string | undefined {
  return stringValue(objectValue(body.external)?.url);
}

function fileUrl(body: Record<string, unknown>): string | undefined {
  return stringValue(objectValue(body.file)?.url) ?? stringValue(objectValue(body.file_upload)?.url);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isPresent(value: string | undefined): value is string {
  return Boolean(value);
}

/**
 * Adopts matching blocks and preserves unmatched remote additions when no
 * last-synced baseline exists for a three-way conflict check.
 * @param options - Prepared desired state and Notion mutation dependencies.
 * @returns Newly created and outbound blocks.
 */
async function replaceAllManagedBlocks({
  appendManagedBlocks,
  desiredBlocks,
  listAllBlockChildren,
  localPageId,
  notionBlocks,
  notionPageId,
  store,
}: Pick<
  ReplaceManagedBlocksOptions,
  | 'appendManagedBlocks'
  | 'listAllBlockChildren'
  | 'localPageId'
  | 'notionPageId'
  | 'store'
> & { desiredBlocks: DesiredManagedBlock[]; notionBlocks: NotionBlockPayload[] }) {
  const existingBlocks = await listAllBlockChildren(store, notionPageId);

  if (existingBlocks.length) {
    return reconcileUnmappedChildren({
      appendManagedBlocks,
      desiredBlocks,
      existingBlocks,
      localPageId,
      notionBlocks,
      notionPageId,
      store,
    });
  }

  const createdBlocks = await appendManagedBlocks(store, notionPageId, notionBlocks);
  if (createdBlocks.length !== notionBlocks.length) {
    throw new Error('Notion did not confirm every block; the note remains available for retry.');
  }
  const createdByOrder: Array<NotionBlock | undefined> = [];

  store.blockMappings[localPageId] = desiredBlocks
    .map((entry, index) => {
      const createdBlock = createdBlocks[index];
      createdByOrder[index] = createdBlock;
      return mappingFromDesired(entry, createdBlock?.id, {}, createdBlock);
    })
    .filter((mapping) => mapping.notionBlockId);

  return {
    createdBlocks: createdByOrder,
    notionBlocks,
  };
}

/**
 * Adopts blocks with matching content while preserving unmatched remote additions.
 * With no saved baseline, those additions cannot be classified as conflicts.
 */
async function reconcileUnmappedChildren({
  appendManagedBlocks,
  desiredBlocks,
  existingBlocks,
  localPageId,
  notionBlocks,
  notionPageId,
  store,
}: {
  appendManagedBlocks: AppendManagedBlocks;
  desiredBlocks: DesiredManagedBlock[];
  existingBlocks: NotionBlock[];
  localPageId: string;
  notionBlocks: NotionBlockPayload[];
  notionPageId: string;
  store: WorkerStore;
}) {
  const matchedByOrder = new Map<number, NotionBlock>();

  for (const existingBlock of existingBlocks) {
    const signature = managedBlockSignature(existingBlock);
    const matchIndex = desiredBlocks.findIndex((desired, index) =>
      !matchedByOrder.has(index) && managedBlockSignature(desired.notionBlock) === signature,
    );

    // Without a saved block baseline, an unmatched remote child is an
    // independent addition. Keep it in Notion and sync the local blocks
    // alongside it instead of claiming both sides edited the same block.
    if (matchIndex < 0) continue;

    matchedByOrder.set(matchIndex, existingBlock);
  }

  const createdByOrder: Array<NotionBlock | undefined> = [];
  const mappings: BlockMapping[] = [];
  let previousBlockId: string | undefined;

  for (const desired of desiredBlocks) {
    let notionBlock = matchedByOrder.get(desired.order);
    if (!notionBlock) {
      [notionBlock] = await appendManagedBlocks(
        store,
        notionPageId,
        [desired.notionBlock],
        previousBlockId
          ? { type: 'after_block', after_block: { id: previousBlockId } }
          : { type: 'start' },
      );
    }

    if (!notionBlock?.id) {
      throw new Error('Notion did not confirm the new block; existing content was preserved.');
    }

    createdByOrder[desired.order] = notionBlock;
    mappings.push(mappingFromDesired(desired, notionBlock.id, {}, notionBlock));
    previousBlockId = notionBlock.id;
  }

  store.blockMappings[localPageId] = mappings;
  return { createdBlocks: createdByOrder, notionBlocks };
}
