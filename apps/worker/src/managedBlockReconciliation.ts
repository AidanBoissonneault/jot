/** @file Applies ordered managed-block reconciliation and minimal reorder rebuilds. */
import type { BlockMapping, ListAllBlockChildren, NotionBlock, NotionBlockPayload, WorkerStore } from './types.js';
import {
  DesiredManagedBlock,
  BlockPosition,
  isUpdateCompatible,
  mappingFromDesired,
  mappingKey,
  mappingsByInkwellId,
  positionAfter,
  reorderedRange,
} from './managedBlockIdentity.js';
import { managedBlockSignature } from './managedBlockSignatures.js';

type AppendManagedBlocks = (
  store: WorkerStore,
  notionPageId: string,
  blocks: NotionBlockPayload[],
  position?: BlockPosition,
) => Promise<NotionBlock[]>;
type DeleteManagedBlock = (store: WorkerStore, blockId: string) => Promise<unknown>;
type UpdateManagedBlock = (
  store: WorkerStore,
  blockId: string,
  block: NotionBlockPayload,
) => Promise<unknown>;

interface ReconcileOptions {
  appendManagedBlocks: AppendManagedBlocks;
  deleteManagedBlock: DeleteManagedBlock;
  desiredBlocks: DesiredManagedBlock[];
  existingMappings: BlockMapping[];
  listAllBlockChildren: ListAllBlockChildren;
  localPageId: string;
  notionBlocks: NotionBlockPayload[];
  notionPageId: string;
  store: WorkerStore;
  updateManagedBlock: UpdateManagedBlock;
}

/** Appends one block and records it at the matching local document order. */
export async function appendAndTrackBlock(
  appendManagedBlocks: AppendManagedBlocks,
  store: WorkerStore,
  notionPageId: string,
  notionBlock: NotionBlockPayload,
  position: BlockPosition,
  createdByOrder: Array<NotionBlock | undefined>,
  order: number,
): Promise<NotionBlock | undefined> {
  const [createdBlock] = await appendManagedBlocks(store, notionPageId, [notionBlock], position);
  createdByOrder[order] = createdBlock;
  return createdBlock;
}

/** Reconciles mapped blocks while preserving unchanged Notion children. */
export async function reconcileManagedBlocks({
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
}: ReconcileOptions) {
  const existingByInkwellId = mappingsByInkwellId(existingMappings);
  const desiredIds = new Set(desiredBlocks.map((entry) => entry.inkwellBlockId));
  const mappedNotionIds = new Set(
    existingMappings.map((mapping) => mapping.notionBlockId).filter((id): id is string => Boolean(id)),
  );
  const nextMappings: BlockMapping[] = [];
  const createdByOrder: Array<NotionBlock | undefined> = [];
  let previousNotionBlockId: string | undefined;

  for (const entry of desiredBlocks) {
    const existing = existingByInkwellId.get(entry.inkwellBlockId);

    if (!existing?.notionBlockId) {
      const createdBlock = await appendAndTrackBlock(
        appendManagedBlocks,
        store,
        notionPageId,
        entry.notionBlock,
        positionAfter(previousNotionBlockId),
        createdByOrder,
        entry.order,
      );
      if (!createdBlock?.id) {
        throw new Error('Notion did not confirm the new block; existing content was preserved.');
      }
      nextMappings.push(mappingFromDesired(entry, createdBlock?.id));
      previousNotionBlockId = createdBlock?.id ?? previousNotionBlockId;
      continue;
    }

    if (existing.lastSyncedHash === entry.lastSyncedHash) {
      nextMappings.push(mappingFromDesired(entry, existing.notionBlockId, existing));
      previousNotionBlockId = existing.notionBlockId;
      continue;
    }

    if (isUpdateCompatible(existing, entry)) {
      await updateManagedBlock(store, existing.notionBlockId, entry.notionBlock);
      nextMappings.push(mappingFromDesired(entry, existing.notionBlockId, existing));
      previousNotionBlockId = existing.notionBlockId;
      continue;
    }

    const children = await listAllBlockChildren(store, notionPageId);
    const previousIndex = previousNotionBlockId
      ? children.findIndex((block) => block.id === previousNotionBlockId)
      : -1;
    const candidate = children[previousIndex + 1];
    let createdBlock = candidate && !mappedNotionIds.has(candidate.id) &&
      managedBlockSignature(candidate) === managedBlockSignature(entry.notionBlock)
      ? candidate
      : undefined;

    if (!createdBlock) {
      createdBlock = await appendAndTrackBlock(
        appendManagedBlocks,
        store,
        notionPageId,
        entry.notionBlock,
        positionAfter(previousNotionBlockId),
        createdByOrder,
        entry.order,
      );
    } else {
      createdByOrder[entry.order] = createdBlock;
    }

    if (!createdBlock?.id) {
      throw new Error('Notion did not confirm the replacement block; the existing block was preserved.');
    }

    // Keep the old block until its replacement is confirmed in Notion. If a
    // delete fails, a retry will recognize the staged replacement above.
    await deleteManagedBlock(store, existing.notionBlockId);
    nextMappings.push(mappingFromDesired(entry, createdBlock?.id, existing));
    previousNotionBlockId = createdBlock?.id ?? previousNotionBlockId;
  }

  for (const mapping of existingMappings) {
    if (!desiredIds.has(mappingKey(mapping)) && mapping.notionBlockId) {
      await deleteManagedBlock(store, mapping.notionBlockId);
    }
  }

  store.blockMappings[localPageId] = nextMappings.filter((mapping) => mapping.notionBlockId);
  return { createdBlocks: createdByOrder, notionBlocks };
}

/** Rebuilds only the smallest contiguous Notion range affected by a reorder. */
export async function rebuildReorderedRange({
  appendManagedBlocks,
  deleteManagedBlock,
  desiredBlocks,
  existingMappings,
  listAllBlockChildren,
  localPageId,
  notionBlocks,
  notionPageId,
  store,
}: Omit<ReconcileOptions, 'updateManagedBlock'>) {
  const range = reorderedRange(existingMappings, desiredBlocks);
  const existingByInkwellId = mappingsByInkwellId(existingMappings);
  const affectedDesired = desiredBlocks.slice(range.start, range.end + 1);
  const affectedIds = new Set(affectedDesired.map((entry) => entry.inkwellBlockId));
  const oldAffectedOrders = existingMappings
    .filter((mapping) => affectedIds.has(mappingKey(mapping)))
    .map((mapping) => mapping.order ?? Number.MAX_SAFE_INTEGER);
  const minOldOrder = Math.min(...oldAffectedOrders);
  const maxOldOrder = Math.max(...oldAffectedOrders);
  const mappingsToDelete = existingMappings.filter((mapping) => {
    const key = mappingKey(mapping);
    const order = mapping.order ?? Number.MAX_SAFE_INTEGER;
    return affectedIds.has(key) || (order >= minOldOrder && order <= maxOldOrder);
  });
  const previousMapping = desiredBlocks
    .slice(0, range.start)
    .reverse()
    .map((entry) => existingByInkwellId.get(entry.inkwellBlockId))
    .find((mapping) => mapping?.notionBlockId);
  const createdByOrder: Array<NotionBlock | undefined> = [];
  const children = await listAllBlockChildren(store, notionPageId);
  const mappedNotionIds = new Set(
    existingMappings.map((mapping) => mapping.notionBlockId).filter((id): id is string => Boolean(id)),
  );
  let previousBlockId = previousMapping?.notionBlockId;
  const rebuiltMappings = new Map<string, BlockMapping>();

  for (const entry of affectedDesired) {
    const previousIndex = previousBlockId
      ? children.findIndex((block) => block.id === previousBlockId)
      : -1;
    const nextChild = children[previousIndex + 1];
    let createdBlock = nextChild && !mappedNotionIds.has(nextChild.id) &&
      managedBlockSignature(nextChild) === managedBlockSignature(entry.notionBlock)
      ? nextChild
      : undefined;

    if (!createdBlock) {
      [createdBlock] = await appendManagedBlocks(
        store,
        notionPageId,
        [entry.notionBlock],
        positionAfter(previousBlockId),
      );
      if (createdBlock) children.splice(previousIndex + 1, 0, createdBlock);
    }

    createdByOrder[entry.order] = createdBlock;
    rebuiltMappings.set(entry.inkwellBlockId, mappingFromDesired(entry, createdBlock?.id));
    previousBlockId = createdBlock?.id ?? previousBlockId;
  }

  if (affectedDesired.some((entry) => !rebuiltMappings.get(entry.inkwellBlockId)?.notionBlockId)) {
    throw new Error('Notion did not confirm every reordered block; the original range was preserved.');
  }

  // Stage all replacement blocks before deleting the old range.
  // A failed append leaves the original note intact; a retry recognizes staged
  // blocks by their position and content instead of creating another copy.
  for (const mapping of mappingsToDelete) {
    if (mapping.notionBlockId) await deleteManagedBlock(store, mapping.notionBlockId);
  }

  store.blockMappings[localPageId] = desiredBlocks
    .map((entry) => {
      const rebuilt = rebuiltMappings.get(entry.inkwellBlockId);
      if (rebuilt) return rebuilt;
      const previous = existingByInkwellId.get(entry.inkwellBlockId);
      return mappingFromDesired(entry, previous?.notionBlockId, previous);
    })
    .filter((mapping) => mapping.notionBlockId);

  return { createdBlocks: createdByOrder, notionBlocks };
}
