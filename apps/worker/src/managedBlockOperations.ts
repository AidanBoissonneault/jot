/** @file Applies granular create, update, delete, reset, and reorder block operations. */
import type { DocumentContent } from '../../../src/types/capture.js';
import type {
  BlockMapping,
  HashValue,
  ListAllBlockChildren,
  ManagedBlockOperation,
  ManagedBlockResult,
  NotionBlock,
  NotionBlockPayload,
  WorkerStore,
} from './types.js';
import {
  desiredManagedBlocks,
  isUpdateCompatible,
  mappingFromDesired,
  mappingKey,
  mappingsByInkwellId,
  positionAfter,
  previousMappedBlockId,
} from './managedBlockIdentity.js';
import type { BlockPosition, DesiredManagedBlock } from './managedBlockIdentity.js';
import { managedBlockSignature } from './managedBlockSignatures.js';
import { appendAndTrackBlock } from './managedBlockReconciliation.js';

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
type ConvertDocument = (content: DocumentContent) => NotionBlockPayload[];
type ClassifyBlock = (block: Pick<NotionBlockPayload, 'type'>) => string;

/** Operation state and mutation dependencies used by granular queue updates. */
interface ApplyManagedBlockOpsOptions {
  appendManagedBlocks: AppendManagedBlocks;
  content: DocumentContent;
  deleteManagedBlock: DeleteManagedBlock;
  hash: HashValue;
  kindFromNotionBlock: ClassifyBlock;
  listAllBlockChildren: ListAllBlockChildren;
  localPageId: string;
  notionPageId: string;
  ops: ManagedBlockOperation[];
  replaceManagedBlocks: (
    store: WorkerStore,
    localPageId: string,
    notionPageId: string,
    content: DocumentContent,
  ) => Promise<ManagedBlockResult>;
  store: WorkerStore;
  tiptapDocumentToNotionBlocks: ConvertDocument;
  updateManagedBlock: UpdateManagedBlock;
}

/** Applies queued operations directly when possible, with full-document fallback. */
export async function applyManagedBlockOps({
  store,
  localPageId,
  notionPageId,
  ops,
  content,
  appendManagedBlocks,
  deleteManagedBlock,
  updateManagedBlock,
  replaceManagedBlocks,
  tiptapDocumentToNotionBlocks,
  kindFromNotionBlock,
  listAllBlockChildren,
  hash,
}: ApplyManagedBlockOpsOptions) {
  const replacementOp = ops.find((op) => op.type === 'block_reorder');
  if (replacementOp) {
    // Keep known remote identities. replaceManagedBlocks can reconcile a
    // non-empty snapshot; an empty queue envelope must never clear the note.
    if (!content.content?.length) return { createdBlocks: [] };
    return replaceManagedBlocks(store, localPageId, notionPageId, content);
  }

  const isGranularBatch = ops.every((op) =>
    ['page_upsert', 'blocks_reset', 'block_create', 'block_update', 'block_delete'].includes(
      op.type,
    ),
  );
  if (isGranularBatch) {
    const createdBlocks: Array<NotionBlock | undefined> = [];
    if (ops.some((op) => op.type === 'blocks_reset')) {
      const snapshotBlocks = ops
        .filter((op) => op.type === 'block_create' && op.payload?.block)
        .sort((first, second) => (first.payload.index ?? 0) - (second.payload.index ?? 0));
      const snapshot = content.content?.length
        ? content
        : { type: 'doc', content: snapshotBlocks.map((op) => op.payload.block!) };
      const knownMappings = store.blockMappings[localPageId] ?? [];
      const snapshotIds = new Set(
        (snapshot.content ?? [])
          .map((node) => node.attrs?.inkwellBlockId)
          .filter((id): id is string => typeof id === 'string' && Boolean(id)),
      );

      // Queue payloads can split a full snapshot across messages. Only treat
      // this chunk as a complete replacement when it covers every known block.
      // Otherwise the per-block path below applies its creates without erasing
      // blocks carried by a later message.
      if (
        snapshot.content?.length &&
        knownMappings.every((mapping) => snapshotIds.has(mappingKey(mapping)))
      ) {
        return replaceManagedBlocks(store, localPageId, notionPageId, snapshot);
      }
    }
    for (const op of ops) {
      if (!['block_create', 'block_update', 'block_delete'].includes(op.type)) continue;
      const result = await applySingleManagedBlockOp({
        store,
        localPageId,
        notionPageId,
        op,
        appendManagedBlocks,
        deleteManagedBlock,
        updateManagedBlock,
        tiptapDocumentToNotionBlocks,
        kindFromNotionBlock,
        listAllBlockChildren,
        hash,
      });
      createdBlocks.push(...(result?.createdBlocks ?? []));
    }
    return { createdBlocks };
  }

  const notionBlocks = tiptapDocumentToNotionBlocks(content);
  const desiredBlocks = desiredManagedBlocks({
    content,
    hash,
    kindFromNotionBlock,
    localPageId,
    notionBlocks,
  });
  const desiredById = new Map(desiredBlocks.map((entry) => [entry.inkwellBlockId, entry]));
  const existingMappings = store.blockMappings[localPageId] ?? [];
  const existingById = mappingsByInkwellId(existingMappings);
  const nextById = new Map(existingMappings.map((mapping) => [mappingKey(mapping), mapping]));
  const createdByOrder: Array<NotionBlock | undefined> = [];

  for (const op of ops) {
    const inkwellBlockId = op.inkwellBlockId;
    if (!inkwellBlockId) continue;

    if (op.type === 'block_delete') {
      const existing = nextById.get(inkwellBlockId);
      if (existing?.notionBlockId) await deleteManagedBlock(store, existing.notionBlockId);
      nextById.delete(inkwellBlockId);
      continue;
    }

    if (op.type !== 'block_create' && op.type !== 'block_update') continue;
    const desired = desiredById.get(inkwellBlockId);
    if (!desired) continue;

    const existing = nextById.get(inkwellBlockId) ?? existingById.get(inkwellBlockId);
    if (!existing?.notionBlockId) {
      const createdBlock = await appendAndTrackBlock(
        appendManagedBlocks,
        store,
        notionPageId,
        desired.notionBlock,
        positionAfter(previousMappedBlockId(desiredBlocks, nextById, desired.order)),
        createdByOrder,
        desired.order,
      );
      nextById.set(inkwellBlockId, mappingFromDesired(desired, createdBlock?.id));
      continue;
    }

    if (existing.lastSyncedHash === desired.lastSyncedHash) {
      nextById.set(inkwellBlockId, mappingFromDesired(desired, existing.notionBlockId, existing));
      continue;
    }

    if (isUpdateCompatible(existing, desired)) {
      await updateManagedBlock(store, existing.notionBlockId, desired.notionBlock);
      nextById.set(inkwellBlockId, mappingFromDesired(desired, existing.notionBlockId, existing));
      continue;
    }

    await deleteManagedBlock(store, existing.notionBlockId);
    const createdBlock = await appendAndTrackBlock(
      appendManagedBlocks,
      store,
      notionPageId,
      desired.notionBlock,
      positionAfter(previousMappedBlockId(desiredBlocks, nextById, desired.order)),
      createdByOrder,
      desired.order,
    );
    nextById.set(inkwellBlockId, mappingFromDesired(desired, createdBlock?.id, existing));
  }

  store.blockMappings[localPageId] = desiredBlocks
    .map((entry) => nextById.get(entry.inkwellBlockId))
    .filter((mapping: BlockMapping | undefined): mapping is BlockMapping =>
      Boolean(mapping?.notionBlockId),
    );

  return { createdBlocks: createdByOrder, notionBlocks };
}

/** Applies one create, update, or delete operation and rewrites mapping order. */
async function applySingleManagedBlockOp({
  store,
  localPageId,
  notionPageId,
  op,
  appendManagedBlocks,
  deleteManagedBlock,
  updateManagedBlock,
  tiptapDocumentToNotionBlocks,
  kindFromNotionBlock,
  listAllBlockChildren,
  hash,
}: Pick<
  ApplyManagedBlockOpsOptions,
  | 'appendManagedBlocks'
  | 'deleteManagedBlock'
  | 'hash'
  | 'kindFromNotionBlock'
  | 'listAllBlockChildren'
  | 'localPageId'
  | 'notionPageId'
  | 'store'
  | 'tiptapDocumentToNotionBlocks'
  | 'updateManagedBlock'
> & { op: ManagedBlockOperation }) {
  const mappings = [...(store.blockMappings[localPageId] ?? [])];
  const existingIndex = mappings.findIndex((mapping) => mappingKey(mapping) === op.inkwellBlockId);
  const existing = existingIndex >= 0 ? mappings[existingIndex] : undefined;

  if (op.type === 'block_delete') {
    if (existing?.notionBlockId) await deleteManagedBlock(store, existing.notionBlockId);
    if (existingIndex >= 0) mappings.splice(existingIndex, 1);
    store.blockMappings[localPageId] = normalizeMappingOrder(mappings);
    return { createdBlocks: [] };
  }

  if (!op.inkwellBlockId || !op.payload?.block) return { createdBlocks: [] };
  const [notionBlock] = tiptapDocumentToNotionBlocks({
    type: 'doc',
    content: [op.payload.block],
  });
  if (!notionBlock) return { createdBlocks: [] };

  const desired: DesiredManagedBlock = {
    inkwellBlockId: op.inkwellBlockId,
    localNodeId: op.inkwellBlockId,
    localPageId,
    notionBlock,
    kind: kindFromNotionBlock(notionBlock),
    lastSyncedHash: hash(JSON.stringify(notionBlock ?? {})),
    order:
      typeof op.payload.index === 'number' && Number.isFinite(op.payload.index)
        ? op.payload.index
        : mappings.length,
  };
  let nextMapping: BlockMapping;
  let createdBlock: NotionBlock | undefined;

  if (!existing?.notionBlockId) {
    const previous = mappings.find(
      (mapping) => mappingKey(mapping) === op.payload.afterInkwellBlockId && mapping.notionBlockId,
    );
    createdBlock = await findRetryCreatedBlock({
      listAllBlockChildren,
      localPageId,
      notionBlock,
      notionPageId,
      previousBlockId: previous?.notionBlockId,
      store,
    });
    if (!createdBlock) {
      createdBlock = await appendAndTrackBlock(
        appendManagedBlocks,
        store,
        notionPageId,
        notionBlock,
        positionAfter(previous?.notionBlockId),
        [],
        0,
      );
    }
    if (!createdBlock?.id) {
      throw new Error('Notion did not confirm the new block; existing content was preserved.');
    }
    nextMapping = mappingFromDesired(desired, createdBlock?.id);
  } else if (existing.lastSyncedHash === desired.lastSyncedHash) {
    nextMapping = mappingFromDesired(desired, existing.notionBlockId, existing);
  } else if (isUpdateCompatible(existing, desired)) {
    await updateManagedBlock(store, existing.notionBlockId, notionBlock);
    nextMapping = mappingFromDesired(desired, existing.notionBlockId, existing);
  } else {
    const previous = mappings.find(
      (mapping) => mappingKey(mapping) === op.payload.afterInkwellBlockId && mapping.notionBlockId,
    );
    createdBlock = await findRetryCreatedBlock({
      listAllBlockChildren,
      localPageId,
      notionBlock,
      notionPageId,
      previousBlockId: previous?.notionBlockId,
      store,
    });
    if (!createdBlock) {
      createdBlock = await appendAndTrackBlock(
        appendManagedBlocks,
        store,
        notionPageId,
        notionBlock,
        positionAfter(previous?.notionBlockId),
        [],
        0,
      );
    }
    if (createdBlock?.id && createdBlock.id !== existing.notionBlockId) {
      await deleteManagedBlock(store, existing.notionBlockId);
    }
    if (!createdBlock?.id) {
      throw new Error('Notion did not confirm the replacement block; existing content was preserved.');
    }
    nextMapping = mappingFromDesired(desired, createdBlock?.id, existing);
  }

  if (existingIndex >= 0) mappings.splice(existingIndex, 1);
  const previousIndex = mappings.findIndex(
    (mapping) => mappingKey(mapping) === op.payload.afterInkwellBlockId,
  );
  const insertionIndex =
    existingIndex >= 0
      ? Math.min(existingIndex, mappings.length)
      : previousIndex >= 0
        ? previousIndex + 1
        : Math.min(Math.max(op.payload.index ?? mappings.length, 0), mappings.length);
  mappings.splice(insertionIndex, 0, nextMapping);
  store.blockMappings[localPageId] = normalizeMappingOrder(mappings);
  return { createdBlocks: createdBlock ? [createdBlock] : [], notionBlocks: [notionBlock] };
}

/** Removes invalid mappings and rewrites their contiguous order values. */
function normalizeMappingOrder(mappings: BlockMapping[]): BlockMapping[] {
  return mappings
    .filter((mapping) => mapping?.notionBlockId)
    .map((mapping, order) => ({ ...mapping, order }));
}

/** Recovers a block written before a queue retry without appending a duplicate. */
async function findRetryCreatedBlock({
  listAllBlockChildren,
  localPageId,
  notionBlock,
  notionPageId,
  previousBlockId,
  store,
}: {
  listAllBlockChildren: ListAllBlockChildren;
  localPageId: string;
  notionBlock: NotionBlockPayload;
  notionPageId: string;
  previousBlockId: string | undefined;
  store: WorkerStore;
}): Promise<NotionBlock | undefined> {
  const children = await listAllBlockChildren(store, notionPageId);
  const previousIndex = previousBlockId
    ? children.findIndex((block) => block.id === previousBlockId)
    : -1;
  const candidate = children[previousIndex + 1];
  const mappedIds = new Set(
    (store.blockMappings[localPageId] ?? [])
      .map((mapping) => mapping.notionBlockId)
      .filter((id): id is string => Boolean(id)),
  );

  return candidate && !mappedIds.has(candidate.id) &&
    managedBlockSignature(candidate) === managedBlockSignature(notionBlock)
    ? candidate
    : undefined;
}
