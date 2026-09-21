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
  ManagedBlockOperation,
  NotionBlock,
  NotionBlockPayload,
  WorkerStore,
} from './types.js';

const INKWELL_BLOCK_ID_ATTR = 'inkwellBlockId';

/** Describes a Notion child insertion position. */
interface BlockPosition {
  after_block?: { id: string };
  type: 'after_block' | 'start';
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
type UpdateManagedBlock = (store: WorkerStore, blockId: string, block: NotionBlockPayload) => Promise<unknown>;
/** Describes the convert document contract used by this API feature. */
type ConvertDocument = (content: DocumentContent) => NotionBlockPayload[];
/** Describes the classify block contract used by this API feature. */
type ClassifyBlock = (block: Pick<NotionBlockPayload, 'type'>) => string;

/** Describes the desired managed block contract used by this API feature. */
interface DesiredManagedBlock {
  inkwellBlockId: string;
  kind: string;
  lastSyncedHash: string;
  localNodeId: string;
  localPageId: string;
  notionBlock: NotionBlockPayload;
  order: number;
}

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

/** Describes the apply managed block ops options contract used by this API feature. */
interface ApplyManagedBlockOpsOptions extends ManagedBlockDependencies {
  content: DocumentContent;
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
}

/** Describes the reconcile options contract used by this API feature. */
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

/** Describes the desired managed blocks options contract used by this API feature. */
interface DesiredManagedBlocksOptions {
  content: DocumentContent;
  hash: HashValue;
  kindFromNotionBlock: ClassifyBlock;
  localPageId: string;
  notionBlocks: NotionBlockPayload[];
}

/**
 * Appends one block and records it at the matching local document order.
 * @param appendManagedBlocks - Notion append operation.
 * @param store - Normalized worker state.
 * @param notionPageId - Parent Notion block identifier.
 * @param notionBlock - Outbound block payload.
 * @param position - Desired Notion insertion position.
 * @param createdByOrder - Sparse result indexed by local order.
 * @param order - Local block order.
 * @returns The created Notion block, when returned by the API.
 */
async function appendAndTrackBlock(
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
const UPDATEABLE_NOTION_TYPES = new Set([
  'paragraph',
  'quote',
  'code',
  'heading_1',
  'heading_2',
  'heading_3',
]);

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

  if (!existingMappings.length) {
    return replaceAllManagedBlocks({
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

  if (hasReorderedManagedBlocks(existingMappings, desiredBlocks)) {
    return rebuildReorderedRange({
      appendManagedBlocks,
      deleteManagedBlock,
      desiredBlocks,
      existingMappings,
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
    localPageId,
    notionBlocks,
    notionPageId,
    store,
    updateManagedBlock,
  });
}

/**
 * Replaces every remote child when no reliable local mapping exists.
 * @param options - Prepared desired state and Notion mutation dependencies.
 * @returns Newly created and outbound blocks.
 */
async function replaceAllManagedBlocks({
  appendManagedBlocks,
  deleteManagedBlock,
  desiredBlocks,
  listAllBlockChildren,
  localPageId,
  notionBlocks,
  notionPageId,
  store,
}: Pick<ReplaceManagedBlocksOptions,
  'appendManagedBlocks' | 'deleteManagedBlock' | 'listAllBlockChildren' | 'localPageId' | 'notionPageId' | 'store'
> & { desiredBlocks: DesiredManagedBlock[]; notionBlocks: NotionBlockPayload[] }) {
  const existingBlocks = await listAllBlockChildren(store, notionPageId);

  for (const block of existingBlocks) {
    await deleteManagedBlock(store, block.id);
  }

  const createdBlocks = await appendManagedBlocks(store, notionPageId, notionBlocks);
  const createdByOrder: Array<NotionBlock | undefined> = [];

  store.blockMappings[localPageId] = desiredBlocks.map((entry, index) => {
    const createdBlock = createdBlocks[index];
    createdByOrder[index] = createdBlock;
    return mappingFromDesired(entry, createdBlock?.id);
  }).filter((mapping) => mapping.notionBlockId);

  return {
    createdBlocks: createdByOrder,
    notionBlocks,
  };
}

/**
 * Applies queued granular block operations or falls back to document reconciliation.
 * @param options - Operations, fallback content, mapping state, and Notion dependencies.
 * @returns Created blocks and, when relevant, outbound payloads.
 */
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
  hash,
}: ApplyManagedBlockOpsOptions) {
  const replacementOp = ops.find((op) => op.type === 'block_reorder');
  if (replacementOp) {
    if (replacementOp.payload?.replaceAll) {
      // A full local snapshot is authoritative. Clearing the mappings makes
      // replaceManagedBlocks removes every current child first, including all
      // untracked blocks left by an interrupted or older first-sync attempt.
      store.blockMappings[localPageId] = [];
    }
    return replaceManagedBlocks(store, localPageId, notionPageId, content);
  }

  // New queue messages carry a single block rather than a copy of the entire
  // page. Apply a bounded batch directly so unrelated mappings are never
  // discarded while still minimizing Queue messages.
  const isGranularBatch = ops.every((op) => [
    'page_upsert',
    'blocks_reset',
    'block_create',
    'block_update',
    'block_delete',
  ].includes(op.type));
  if (isGranularBatch) {
    const createdBlocks: Array<NotionBlock | undefined> = [];
    if (ops.some((op) => op.type === 'blocks_reset')) {
      store.blockMappings[localPageId] = [];
      await replaceManagedBlocks(store, localPageId, notionPageId, { type: 'doc', content: [] });
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
      if (existing?.notionBlockId) {
        await deleteManagedBlock(store, existing.notionBlockId);
      }
      nextById.delete(inkwellBlockId);
      continue;
    }

    if (op.type !== 'block_create' && op.type !== 'block_update') {
      continue;
    }

    const desired = desiredById.get(inkwellBlockId);
    if (!desired) continue;

    const existing = nextById.get(inkwellBlockId) ?? existingById.get(inkwellBlockId);
    if (!existing?.notionBlockId) {
      const createdBlock = await appendAndTrackBlock(appendManagedBlocks, store, notionPageId, desired.notionBlock, positionAfter(previousMappedBlockId(desiredBlocks, nextById, desired.order)), createdByOrder, desired.order);
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
    const createdBlock = await appendAndTrackBlock(appendManagedBlocks, store, notionPageId, desired.notionBlock, positionAfter(previousMappedBlockId(desiredBlocks, nextById, desired.order)), createdByOrder, desired.order);
    nextById.set(inkwellBlockId, mappingFromDesired(desired, createdBlock?.id, existing));
  }

  store.blockMappings[localPageId] = desiredBlocks
    .map((entry) => nextById.get(entry.inkwellBlockId))
    .filter((mapping: BlockMapping | undefined): mapping is BlockMapping => Boolean(mapping?.notionBlockId));

  return {
    createdBlocks: createdByOrder,
    notionBlocks,
  };
}

/**
 * Applies one create, update, or delete operation and rewrites mapping order.
 * @param options - Single operation, mapping state, and Notion dependencies.
 * @returns Blocks created while applying the operation.
 */
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
  hash,
}: Pick<ApplyManagedBlockOpsOptions,
  | 'appendManagedBlocks'
  | 'deleteManagedBlock'
  | 'hash'
  | 'kindFromNotionBlock'
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
    if (existing?.notionBlockId) {
      await deleteManagedBlock(store, existing.notionBlockId);
    }
    if (existingIndex >= 0) mappings.splice(existingIndex, 1);
    store.blockMappings[localPageId] = normalizeMappingOrder(mappings);
    return { createdBlocks: [] };
  }

  if (!op.inkwellBlockId || !op.payload?.block) {
    return { createdBlocks: [] };
  }

  const [notionBlock] = tiptapDocumentToNotionBlocks({
    type: 'doc',
    content: [op.payload.block],
  });
  if (!notionBlock) return { createdBlocks: [] };

  const desired = {
    inkwellBlockId: op.inkwellBlockId,
    localNodeId: op.inkwellBlockId,
    localPageId,
    notionBlock,
    kind: kindFromNotionBlock(notionBlock),
    lastSyncedHash: hash(JSON.stringify(notionBlock ?? {})),
    order: typeof op.payload.index === 'number' && Number.isFinite(op.payload.index)
      ? op.payload.index
      : mappings.length,
  };
  let nextMapping: BlockMapping;
  let createdBlock: NotionBlock | undefined;

  if (!existing?.notionBlockId) {
    const previous = mappings.find((mapping) =>
      mappingKey(mapping) === op.payload.afterInkwellBlockId && mapping.notionBlockId,
    );
    createdBlock = await appendAndTrackBlock(
      appendManagedBlocks,
      store,
      notionPageId,
      notionBlock,
      positionAfter(previous?.notionBlockId),
      [],
      0,
    );
    nextMapping = mappingFromDesired(desired, createdBlock?.id);
  } else if (existing.lastSyncedHash === desired.lastSyncedHash) {
    nextMapping = mappingFromDesired(desired, existing.notionBlockId, existing);
  } else if (isUpdateCompatible(existing, desired)) {
    await updateManagedBlock(store, existing.notionBlockId, notionBlock);
    nextMapping = mappingFromDesired(desired, existing.notionBlockId, existing);
  } else {
    await deleteManagedBlock(store, existing.notionBlockId);
    const previous = mappings.find((mapping) =>
      mappingKey(mapping) === op.payload.afterInkwellBlockId && mapping.notionBlockId,
    );
    createdBlock = await appendAndTrackBlock(
      appendManagedBlocks,
      store,
      notionPageId,
      notionBlock,
      positionAfter(previous?.notionBlockId),
      [],
      0,
    );
    nextMapping = mappingFromDesired(desired, createdBlock?.id, existing);
  }

  if (existingIndex >= 0) mappings.splice(existingIndex, 1);
  const previousIndex = mappings.findIndex((mapping) =>
    mappingKey(mapping) === op.payload.afterInkwellBlockId,
  );
  const insertionIndex = existingIndex >= 0
    ? Math.min(existingIndex, mappings.length)
    : previousIndex >= 0
      ? previousIndex + 1
      : Math.min(Math.max(op.payload.index ?? mappings.length, 0), mappings.length);
  mappings.splice(insertionIndex, 0, nextMapping);
  store.blockMappings[localPageId] = normalizeMappingOrder(mappings);
  return { createdBlocks: createdBlock ? [createdBlock] : [], notionBlocks: [notionBlock] };
}

/**
 * Removes invalid mappings and rewrites their contiguous order values.
 * @param mappings - Candidate block mappings.
 * @returns Valid mappings in normalized order.
 */
function normalizeMappingOrder(mappings: BlockMapping[]): BlockMapping[] {
  return mappings
    .filter((mapping) => mapping?.notionBlockId)
    .map((mapping, order) => ({ ...mapping, order }));
}

/**
 * Reconciles mapped blocks without disturbing blocks whose order is unchanged.
 * @param options - Desired/current mappings and Notion mutation operations.
 * @returns Created blocks and outbound payloads.
 */
async function reconcileManagedBlocks({
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
      const createdBlock = await appendAndTrackBlock(appendManagedBlocks, store, notionPageId, entry.notionBlock, positionAfter(previousNotionBlockId), createdByOrder, entry.order);
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
    const createdBlock = await appendAndTrackBlock(appendManagedBlocks, store, notionPageId, entry.notionBlock, positionAfter(previousNotionBlockId), createdByOrder, entry.order);
    nextMappings.push(mappingFromDesired(entry, createdBlock?.id, existing));
    previousNotionBlockId = createdBlock?.id ?? previousNotionBlockId;
  }

  for (const mapping of existingMappings) {
    if (!desiredIds.has(mappingKey(mapping)) && mapping.notionBlockId) {
      await deleteManagedBlock(store, mapping.notionBlockId);
    }
  }

  store.blockMappings[localPageId] = nextMappings.filter((mapping) => mapping.notionBlockId);

  return {
    createdBlocks: createdByOrder,
    notionBlocks,
  };
}

/**
 * Rebuilds the smallest contiguous range affected by a local reorder.
 * @param options - Desired/current mappings and Notion mutation operations.
 * @returns Created blocks aligned to local order and outbound payloads.
 */
async function rebuildReorderedRange({
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
    if (mapping.notionBlockId) {
      await deleteManagedBlock(store, mapping.notionBlockId);
    }
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
      return mappingFromDesired(entry, existingByInkwellId.get(entry.inkwellBlockId)?.notionBlockId, existingByInkwellId.get(entry.inkwellBlockId));
    })
    .filter((mapping) => mapping.notionBlockId);

  return {
    createdBlocks: createdByOrder,
    notionBlocks,
  };
}

/**
 * Pairs outbound Notion payloads with stable local identities and hashes.
 * @param options - Local document, outbound blocks, identity, and mapping helpers.
 * @returns Desired mapping entries in document order.
 */
function desiredManagedBlocks({
  content,
  hash,
  kindFromNotionBlock,
  localPageId,
  notionBlocks,
}: DesiredManagedBlocksOptions): DesiredManagedBlock[] {
  const nodes = content?.content ?? [];

  return notionBlocks.map((notionBlock, index) => {
    const inkwellBlockId = inkwellBlockIdFromNode(nodes[index], index);
    return {
      inkwellBlockId,
      localNodeId: inkwellBlockId,
      localPageId,
      notionBlock,
      kind: kindFromNotionBlock(notionBlock),
      lastSyncedHash: hash(JSON.stringify(notionBlock ?? {})),
      order: index,
    };
  });
}

/**
 * Reads a node's stable Inkwell identifier or derives a positional fallback.
 * @param node - Tiptap node.
 * @param index - Top-level document index.
 * @returns Stable mapping identifier.
 */
function inkwellBlockIdFromNode(node: DocumentContent | undefined, index: number): string {
  const value = node?.attrs?.[INKWELL_BLOCK_ID_ATTR];
  return typeof value === 'string' && value ? value : `block-${index}`;
}

/**
 * Converts desired state into a persisted block mapping.
 * @param entry - Desired mapped block.
 * @param notionBlockId - Remote block identifier, when creation succeeded.
 * @param previous - Prior mapping used to retain historical state.
 * @returns Persistable mapping state.
 */
function mappingFromDesired(
  entry: DesiredManagedBlock,
  notionBlockId: string | undefined,
  previous: Partial<BlockMapping> = {},
): BlockMapping {
  return {
    localPageId: entry.localPageId,
    inkwellBlockId: entry.inkwellBlockId,
    localNodeId: entry.localNodeId,
    notionBlockId,
    kind: entry.kind,
    order: entry.order,
    lastSyncedHash: entry.lastSyncedHash,
    oldState: previous.newState ?? previous.oldState ?? null,
    newState: entry.notionBlock,
  };
}

/**
 * Indexes mappings by their stable local identity.
 * @param mappings - Persisted block mappings.
 * @returns Mapping lookup keyed by Inkwell block identifier.
 */
function mappingsByInkwellId(mappings: BlockMapping[]): Map<string, BlockMapping> {
  const result = new Map<string, BlockMapping>();

  for (const mapping of mappings) {
    result.set(mappingKey(mapping), mapping);
  }

  return result;
}

/**
 * Returns the stable local key for a mapping.
 * @param mapping - Persisted block mapping.
 * @returns Inkwell or legacy local node identifier.
 */
function mappingKey(mapping: BlockMapping): string {
  return mapping.inkwellBlockId ?? mapping.localNodeId;
}

/**
 * Computes the shared mapping identifiers in old and desired order.
 * @param existingMappings - Current persisted mappings.
 * @param desiredBlocks - Desired mapping entries.
 * @returns Parallel old/new identifier sequences.
 */
function commonOrderedIds(
  existingMappings: BlockMapping[],
  desiredBlocks: DesiredManagedBlock[],
): { newCommon: string[]; oldCommon: string[] } {
  const desiredIds = new Set(desiredBlocks.map((entry) => entry.inkwellBlockId));
  const existingIds = new Set(existingMappings.map(mappingKey));
  const oldCommon = existingMappings.map(mappingKey).filter((id) => desiredIds.has(id));
  const newCommon = desiredBlocks.map((entry) => entry.inkwellBlockId).filter((id) => existingIds.has(id));
  return { oldCommon, newCommon };
}

/**
 * Detects whether shared managed blocks changed relative order.
 * @param existingMappings - Current persisted mappings.
 * @param desiredBlocks - Desired mapping entries.
 * @returns Whether a remote range must be rebuilt.
 */
function hasReorderedManagedBlocks(
  existingMappings: BlockMapping[],
  desiredBlocks: DesiredManagedBlock[],
): boolean {
  const { oldCommon, newCommon } = commonOrderedIds(existingMappings, desiredBlocks);
  return oldCommon.length > 1 && oldCommon.join('\n') !== newCommon.join('\n');
}

/**
 * Finds the desired index range affected by a reorder.
 * @param existingMappings - Current persisted mappings.
 * @param desiredBlocks - Desired mapping entries.
 * @returns Inclusive start and end indexes.
 */
function reorderedRange(
  existingMappings: BlockMapping[],
  desiredBlocks: DesiredManagedBlock[],
): { end: number; start: number } {
  const { oldCommon, newCommon } = commonOrderedIds(existingMappings, desiredBlocks);
  let first = 0;
  let last = newCommon.length - 1;

  while (first <= last && oldCommon[first] === newCommon[first]) {
    first += 1;
  }

  while (last >= first && oldCommon[last] === newCommon[last]) {
    last -= 1;
  }

  const affectedIds = new Set(newCommon.slice(first, last + 1));
  const indexes = desiredBlocks
    .map((entry, index) => affectedIds.has(entry.inkwellBlockId) ? index : -1)
    .filter((index) => index >= 0);

  return {
    start: Math.min(...indexes),
    end: Math.max(...indexes),
  };
}

/**
 * Checks whether Notion can update a mapped block in place.
 * @param existing - Current mapping.
 * @param entry - Desired mapped block.
 * @returns Whether an in-place update preserves block semantics.
 */
function isUpdateCompatible(existing: BlockMapping, entry: DesiredManagedBlock): boolean {
  return existing.kind === entry.kind && UPDATEABLE_NOTION_TYPES.has(entry.notionBlock.type);
}

/**
 * Builds a Notion insertion position after a block or at the start.
 * @param blockId - Previous remote block identifier.
 * @returns Notion insertion position.
 */
function positionAfter(blockId: string | undefined): BlockPosition {
  return blockId
    ? {
        type: 'after_block',
        after_block: { id: blockId },
      }
    : { type: 'start' };
}

/**
 * Finds the nearest preceding desired block with a remote mapping.
 * @param desiredBlocks - Desired mapping entries.
 * @param mappingsById - Current mappings keyed by local identity.
 * @param order - Desired insertion order.
 * @returns Previous Notion block identifier or undefined.
 */
function previousMappedBlockId(
  desiredBlocks: DesiredManagedBlock[],
  mappingsById: Map<string, BlockMapping>,
  order: number,
): string | undefined {
  for (let index = order - 1; index >= 0; index -= 1) {
    const mapping = mappingsById.get(desiredBlocks[index]?.inkwellBlockId);
    if (mapping?.notionBlockId) {
      return mapping.notionBlockId;
    }
  }

  return undefined;
}
