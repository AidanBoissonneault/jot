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
  mappingFromDesired,
} from './managedBlockIdentity.js';
import { managedBlockSignature } from './managedBlockSignatures.js';
import type { BlockPosition, DesiredManagedBlock } from './managedBlockIdentity.js';
import { rebuildReorderedRange, reconcileManagedBlocks } from './managedBlockReconciliation.js';
import { notionBlocksToTiptapDocumentStrict } from './blockConversion/notionToTiptap.js';

export const UNMAPPED_NOTION_CONTENT_CODE = 'unmapped_notion_content';
export const UNMAPPED_NOTION_CONTENT_MESSAGE =
  'Notion and local content differ in blocks that could not be matched automatically. Review the sync diff and merge the blocks.';

export type UnmappedNotionContentDiff = {
  localContent: DocumentContent;
  remoteContent: DocumentContent | null;
};

/** A safe-to-stop sync conflict caused by remote blocks absent from local mappings. */
export class UnmappedNotionContentError extends Error {
  readonly code = UNMAPPED_NOTION_CONTENT_CODE;
  readonly diff: UnmappedNotionContentDiff;

  constructor(diff: UnmappedNotionContentDiff) {
    super(UNMAPPED_NOTION_CONTENT_MESSAGE);
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
  listAllBlockChildren,
  deleteManagedBlock,
  appendManagedBlocks,
  updateManagedBlock,
  tiptapDocumentToNotionBlocks,
  kindFromNotionBlock,
  hash,
}: ReplaceManagedBlocksOptions) {
  const notionBlocks = tiptapDocumentToNotionBlocks(content);
  const desiredBlocks = desiredManagedBlocks({
    content,
    hash,
    kindFromNotionBlock,
    localPageId,
    notionBlocks,
  });
  const existingMappings = store.blockMappings[localPageId] ?? [];
  const isUserReviewedReplacement = content.attrs?.inkwellConflictResolution === true;

  // An empty document may be a partial queue envelope. Never interpret it as
  // permission to erase the remote note.
  if (!desiredBlocks.length && !isUserReviewedReplacement) {
    return { createdBlocks: [], notionBlocks };
  }

  if (isUserReviewedReplacement) {
    return replaceAfterUserConflictResolution({
      appendManagedBlocks,
      deleteManagedBlock,
      desiredBlocks,
      listAllBlockChildren,
      localPageId,
      notionBlocks,
      notionPageId,
      store,
    });
  }

  if (!existingMappings.length) {
    return replaceAllManagedBlocks({
      appendManagedBlocks,
      desiredBlocks,
      listAllBlockChildren,
      localPageId,
      notionBlocks,
      notionPageId,
      store,
      content,
    });
  }

  const remoteBlocks = await listAllBlockChildren(store, notionPageId);
  repairMappingsByContent(existingMappings, desiredBlocks, remoteBlocks, content);
  if (hasUnresolvedRemoteChanges(existingMappings, desiredBlocks, remoteBlocks)) {
    throw createContentConflict(content, remoteBlocks, existingMappings, desiredBlocks);
  }

  if (hasReorderedManagedBlocks(existingMappings, desiredBlocks)) {
    return rebuildReorderedRange({
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
  }

  return reconcileManagedBlocks({
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

/** Replaces all managed children after the user reviews and confirms the merged document. */
async function replaceAfterUserConflictResolution({
  appendManagedBlocks,
  deleteManagedBlock,
  desiredBlocks,
  listAllBlockChildren,
  localPageId,
  notionBlocks,
  notionPageId,
  store,
}: {
  appendManagedBlocks: AppendManagedBlocks;
  deleteManagedBlock: DeleteManagedBlock;
  desiredBlocks: DesiredManagedBlock[];
  listAllBlockChildren: ListAllBlockChildren;
  localPageId: string;
  notionBlocks: NotionBlockPayload[];
  notionPageId: string;
  store: WorkerStore;
}) {
  const remoteBlocks = await listAllBlockChildren(store, notionPageId);
  for (const block of remoteBlocks) await deleteManagedBlock(store, block.id);
  store.blockMappings[localPageId] = [];

  if (!notionBlocks.length) return { createdBlocks: [], notionBlocks };
  const createdBlocks = await appendManagedBlocks(store, notionPageId, notionBlocks);
  if (createdBlocks.length !== notionBlocks.length) {
    throw new Error('Notion did not confirm every merged block; the original sync remains available for retry.');
  }

  store.blockMappings[localPageId] = desiredBlocks
    .map((entry, index) => mappingFromDesired(entry, createdBlocks[index]?.id))
    .filter((mapping) => mapping.notionBlockId);
  return { createdBlocks, notionBlocks };
}

/** Repairs stale Notion IDs by matching saved mapping content to current remote blocks. */
function repairMappingsByContent(
  existingMappings: BlockMapping[],
  desiredBlocks: DesiredManagedBlock[],
  remoteBlocks: NotionBlock[],
  content: DocumentContent,
): void {
  const remoteById = new Map(remoteBlocks.map((block) => [block.id, block]));
  const desiredById = new Map(desiredBlocks.map((entry) => [entry.inkwellBlockId, entry]));
  const usedRemoteIds = new Set<string>();
  const orderedMappings = existingMappings.slice().sort((first, second) => first.order - second.order);
  const explicitLocalChoices = new Set(
    (content.content ?? [])
      .filter((node) => node.attrs?.inkwellConflictResolution === true)
      .map((node) => node.attrs?.inkwellBlockId)
      .filter((id): id is string => typeof id === 'string'),
  );

  for (const mapping of orderedMappings) {
    const desired = desiredById.get(mapping.inkwellBlockId ?? mapping.localNodeId);
    const current = mapping.notionBlockId ? remoteById.get(mapping.notionBlockId) : undefined;
    const expectedSignature = mapping.newState ? managedBlockSignature(mapping.newState) : undefined;
    const desiredSignature = desired ? managedBlockSignature(desired.notionBlock) : undefined;

    if (current && explicitLocalChoices.has(mapping.inkwellBlockId ?? mapping.localNodeId)) {
      mapping.newState = current as unknown as NotionBlockPayload;
      usedRemoteIds.add(current.id);
      continue;
    }

    if (current && (
      managedBlockSignature(current) === expectedSignature ||
      managedBlockSignature(current) === desiredSignature
    )) {
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

  for (const desired of desiredBlocks) {
    if (existingMappings.some((entry) =>
      (entry.inkwellBlockId ?? entry.localNodeId) === desired.inkwellBlockId,
    )) continue;

    const match = findUnclaimedRemoteBlock(
      remoteBlocks,
      usedRemoteIds,
      [managedBlockSignature(desired.notionBlock)],
      desired.order,
    );
    if (!match) continue;
    existingMappings.push({
      localPageId: desired.localPageId,
      inkwellBlockId: desired.inkwellBlockId,
      localNodeId: desired.localNodeId,
      notionBlockId: match.id,
      kind: desired.kind,
      order: desired.order,
      lastSyncedHash: desired.lastSyncedHash,
      oldState: null,
      newState: desired.notionBlock,
    });
    usedRemoteIds.add(match.id);
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
  const desiredById = new Map(desiredBlocks.map((entry) => [entry.inkwellBlockId, entry]));
  const remoteById = new Map(remoteBlocks.map((block) => [block.id, block]));
  const mappedIds = new Set<string>();
  const desiredCapacity = new Map<string, number>();
  for (const desired of desiredBlocks) {
    const signature = managedBlockSignature(desired.notionBlock);
    desiredCapacity.set(signature, (desiredCapacity.get(signature) ?? 0) + 1);
  }
  const alreadyMatchedDesired = new Map<string, number>();

  for (const mapping of mappings) {
    if (!mapping.notionBlockId) continue;
    const remote = remoteById.get(mapping.notionBlockId);
    if (!remote) continue;
    mappedIds.add(remote.id);
    const desired = desiredById.get(mapping.inkwellBlockId ?? mapping.localNodeId);
    const baseSignature = mapping.newState ? managedBlockSignature(mapping.newState) : undefined;
    const remoteSignature = managedBlockSignature(remote);
    const desiredSignature = desired ? managedBlockSignature(desired.notionBlock) : undefined;
    if (remoteSignature !== baseSignature && remoteSignature !== desiredSignature) return true;
    if (desiredSignature && remoteSignature === desiredSignature) {
      alreadyMatchedDesired.set(desiredSignature, (alreadyMatchedDesired.get(desiredSignature) ?? 0) + 1);
    }
  }

  const availableDesired = new Map(
    [...desiredCapacity].map(([signature, count]) => [
      signature,
      Math.max(0, count - (alreadyMatchedDesired.get(signature) ?? 0)),
    ]),
  );
  for (const block of remoteBlocks) {
    if (mappedIds.has(block.id)) continue;
    const signature = managedBlockSignature(block);
    const available = availableDesired.get(signature) ?? 0;
    if (!available) return true;
    availableDesired.set(signature, available - 1);
  }
  return false;
}

function createContentConflict(
  localContent: DocumentContent,
  remoteBlocks: NotionBlock[],
  mappings: BlockMapping[] = [],
  desiredBlocks: DesiredManagedBlock[] = [],
): UnmappedNotionContentError {
  const remoteContent = notionBlocksToTiptapDocumentStrict(remoteBlocks);
  if (remoteContent) {
    const mappedIdByNotionId = new Map(
      mappings
        .filter((mapping) => mapping.notionBlockId)
        .map((mapping) => [mapping.notionBlockId!, mapping.inkwellBlockId ?? mapping.localNodeId]),
    );
    const desiredBySignature = new Map<string, string[]>();
    for (const desired of desiredBlocks) {
      const signature = managedBlockSignature(desired.notionBlock);
      desiredBySignature.set(signature, [
        ...(desiredBySignature.get(signature) ?? []),
        desired.inkwellBlockId,
      ]);
    }
    remoteContent.content = remoteContent.content?.map((node, index) => {
      const notionId = remoteBlocks[index]?.id;
      const signature = remoteBlocks[index] ? managedBlockSignature(remoteBlocks[index]) : '';
      const blockId = notionId ? mappedIdByNotionId.get(notionId) : undefined;
      const contentMatchedId = desiredBySignature.get(signature)?.shift();
      return blockId
        ? { ...node, attrs: { ...node.attrs, inkwellBlockId: blockId } }
        : contentMatchedId
          ? { ...node, attrs: { ...node.attrs, inkwellBlockId: contentMatchedId } }
          : node;
    });
  }
  return new UnmappedNotionContentError({
    localContent,
    remoteContent,
  });
}

/**
 * Reconciles an unmapped page without deleting untracked remote children.
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
  content,
}: Pick<
  ReplaceManagedBlocksOptions,
  | 'appendManagedBlocks'
  | 'listAllBlockChildren'
  | 'localPageId'
  | 'notionPageId'
  | 'store'
> & { content: DocumentContent; desiredBlocks: DesiredManagedBlock[]; notionBlocks: NotionBlockPayload[] }) {
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
      content,
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
      return mappingFromDesired(entry, createdBlock?.id);
    })
    .filter((mapping) => mapping.notionBlockId);

  return {
    createdBlocks: createdByOrder,
    notionBlocks,
  };
}

/**
 * Adopts a matching remote snapshot without deleting untracked children.
 * If a remote child cannot be paired with the requested snapshot in order,
 * synchronization stops so the note can be reloaded or reviewed safely.
 */
async function reconcileUnmappedChildren({
  appendManagedBlocks,
  desiredBlocks,
  existingBlocks,
  localPageId,
  notionBlocks,
  notionPageId,
  store,
  content,
}: {
  appendManagedBlocks: AppendManagedBlocks;
  desiredBlocks: DesiredManagedBlock[];
  existingBlocks: NotionBlock[];
  localPageId: string;
  notionBlocks: NotionBlockPayload[];
  notionPageId: string;
  store: WorkerStore;
  content: DocumentContent;
}) {
  const matchedByOrder = new Map<number, NotionBlock>();
  let nextDesiredIndex = 0;

  for (const existingBlock of existingBlocks) {
    const signature = managedBlockSignature(existingBlock);
    const matchIndex = desiredBlocks.findIndex((desired, index) =>
      index >= nextDesiredIndex && managedBlockSignature(desired.notionBlock) === signature,
    );

    if (matchIndex < 0) {
      throw createContentConflict(content, existingBlocks, [], desiredBlocks);
    }

    matchedByOrder.set(matchIndex, existingBlock);
    nextDesiredIndex = matchIndex + 1;
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
    mappings.push(mappingFromDesired(desired, notionBlock.id));
    previousBlockId = notionBlock.id;
  }

  store.blockMappings[localPageId] = mappings;
  return { createdBlocks: createdByOrder, notionBlocks };
}
