/** @file Applies ordered managed-block reconciliation and minimal reorder rebuilds. */
import type { BlockMapping, NotionBlock, NotionBlockPayload, WorkerStore } from './types.js';
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
  localPageId,
  notionBlocks,
  notionPageId,
  store,
  updateManagedBlock,
}: ReconcileOptions) {
  const existingByInkwellId = mappingsByInkwellId(existingMappings);
  const desiredIds = new Set(desiredBlocks.map((entry) => entry.inkwellBlockId));
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

    await deleteManagedBlock(store, existing.notionBlockId);
    const createdBlock = await appendAndTrackBlock(
      appendManagedBlocks,
      store,
      notionPageId,
      entry.notionBlock,
      positionAfter(previousNotionBlockId),
      createdByOrder,
      entry.order,
    );
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

  for (const mapping of mappingsToDelete) {
    if (mapping.notionBlockId) await deleteManagedBlock(store, mapping.notionBlockId);
  }

  const createdBlocks = await appendManagedBlocks(
    store,
    notionPageId,
    affectedDesired.map((entry) => entry.notionBlock),
    positionAfter(previousMapping?.notionBlockId),
  );
  const rebuiltMappings = new Map<string, BlockMapping>();

  affectedDesired.forEach((entry, index) => {
    const createdBlock = createdBlocks[index];
    createdByOrder[entry.order] = createdBlock;
    rebuiltMappings.set(entry.inkwellBlockId, mappingFromDesired(entry, createdBlock?.id));
  });

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
