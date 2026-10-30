/** @file Applies reset snapshots and granular managed-block operations. */
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
  isUpdateCompatible,
  mappingFromDesired,
  mappingKey,
  positionAfter,
} from './managedBlockIdentity.js';
import type { BlockPosition, DesiredManagedBlock } from './managedBlockIdentity.js';
import { managedBlockSignature } from './managedBlockSignatures.js';
import { appendAndTrackBlock } from './managedBlockReconciliation.js';
import { notionBlocksToTiptapDocumentStrict } from './blockConversion/notionToTiptap.js';
import { restoreLocalBlockBaseline, UnmappedNotionContentError } from './managedBlocks.js';

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
const CURRENT_OPERATION_TYPES = new Set<ManagedBlockOperation['type']>([
  'page_upsert',
  'blocks_reset',
  'block_create',
  'block_update',
  'block_delete',
]);

type CreateManagedBlockOptions = Pick<ApplyManagedBlockOpsOptions,
  'appendManagedBlocks' | 'listAllBlockChildren' | 'localPageId' | 'notionPageId' | 'store'
> & {
  afterJottathingBlockId: string | undefined;
  failureMessage: string;
  mappings: BlockMapping[];
  notionBlock: NotionBlockPayload;
};

/** Operation state and mutation dependencies used by granular queue updates. */
interface ApplyManagedBlockOpsOptions {
  appendManagedBlocks: AppendManagedBlocks;
  baselineContent?: DocumentContent;
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
    baselineContent?: DocumentContent,
  ) => Promise<ManagedBlockResult>;
  store: WorkerStore;
  tiptapDocumentToNotionBlocks: ConvertDocument;
  updateManagedBlock: UpdateManagedBlock;
}

/** Applies current reset and granular block operations. */
export async function applyManagedBlockOps({
  store,
  localPageId,
  notionPageId,
  ops,
  content,
  baselineContent,
  appendManagedBlocks,
  deleteManagedBlock,
  updateManagedBlock,
  replaceManagedBlocks,
  tiptapDocumentToNotionBlocks,
  kindFromNotionBlock,
  listAllBlockChildren,
  hash,
}: ApplyManagedBlockOpsOptions) {
  if (ops.some((op) => !op || !CURRENT_OPERATION_TYPES.has(op.type))) {
    throw new Error('Sync queue contains an unsupported block operation.');
  }

  restoreLocalBlockBaseline(
    store.blockMappings[localPageId] ?? [],
    baselineContent,
    hash,
    kindFromNotionBlock,
    localPageId,
    tiptapDocumentToNotionBlocks,
  );
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
        .map((node) => node.attrs?.jottathingBlockId)
        .filter((id): id is string => typeof id === 'string' && Boolean(id)),
    );

    // Queue payloads can split a full snapshot across messages. Only treat
    // this chunk as complete when it covers every known block; partial chunks
    // apply their creates individually so later blocks remain intact.
    if (
      snapshot.content?.length &&
      knownMappings.every((mapping) => snapshotIds.has(mappingKey(mapping)))
    ) {
      return replaceManagedBlocks(store, localPageId, notionPageId, snapshot, baselineContent);
    }
  }
  for (const op of ops) {
    if (!['block_create', 'block_update', 'block_delete'].includes(op.type)) continue;
    const result = await applySingleManagedBlockOp({
      store,
      localPageId,
      notionPageId,
      op,
      content,
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
  return {
    createdBlocks,
    baselineContent: advanceLocalBaseline(baselineContent, content, ops),
  };
}

/** Applies only acknowledged granular operations to the local three-way baseline. */
function advanceLocalBaseline(
  baselineContent: DocumentContent | undefined,
  currentContent: DocumentContent,
  ops: ManagedBlockOperation[],
): DocumentContent {
  const content = [...(baselineContent?.content ?? [])];
  for (const op of ops) {
    if (!['block_create', 'block_update', 'block_delete'].includes(op.type)) continue;
    const id = op.jottathingBlockId;
    if (!id) continue;
    const index = content.findIndex((node) =>
      node.attrs?.jottathingBlockId === id,
    );
    if (op.type === 'block_delete') {
      if (index >= 0) content.splice(index, 1);
      continue;
    }
    const current = (currentContent.content ?? []).find((node) =>
      node.attrs?.jottathingBlockId === id,
    ) ?? op.payload.block;
    if (!current) continue;
    const next = {
      ...current,
      attrs: { ...current.attrs, jottathingBlockId: id },
    };
    if (index >= 0) content[index] = next;
    else content.push(next);
  }
  return {
    ...baselineContent,
    type: baselineContent?.type ?? currentContent.type ?? 'doc',
    content,
  };
}

/** Applies one create, update, or delete operation and rewrites mapping order. */
async function applySingleManagedBlockOp({
  store,
  localPageId,
  notionPageId,
  op,
  content,
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
> & { op: ManagedBlockOperation; content: DocumentContent }) {
  const mappings = [...(store.blockMappings[localPageId] ?? [])];
  const existingIndex = mappings.findIndex((mapping) => mappingKey(mapping) === op.jottathingBlockId);
  const existing = existingIndex >= 0 ? mappings[existingIndex] : undefined;

  if (op.type === 'block_delete') {
    if (existing?.notionBlockId) await deleteManagedBlock(store, existing.notionBlockId);
    if (existingIndex >= 0) mappings.splice(existingIndex, 1);
    store.blockMappings[localPageId] = normalizeMappingOrder(mappings);
    return { createdBlocks: [] };
  }

  if (!op.jottathingBlockId || !op.payload?.block) return { createdBlocks: [] };
  const localBlock = op.payload.block;
  const [notionBlock] = tiptapDocumentToNotionBlocks({
    type: 'doc',
    content: [localBlock],
  });
  if (!notionBlock) return { createdBlocks: [] };

  const desired: DesiredManagedBlock = {
    jottathingBlockId: op.jottathingBlockId,
    localPageId,
    notionBlock,
    kind: kindFromNotionBlock(notionBlock),
    lastSyncedHash: hash(JSON.stringify(notionBlock ?? {})),
    order:
      typeof op.payload.index === 'number' && Number.isFinite(op.payload.index)
        ? op.payload.index
        : mappings.length,
  };
  const createBlock = (kind: 'new' | 'replacement') => createOrRecoverManagedBlock({
    appendManagedBlocks,
    failureMessage: `Notion did not confirm the ${kind} block; existing content was preserved.`,
    listAllBlockChildren,
    localPageId,
    notionBlock,
    notionPageId,
    afterJottathingBlockId: op.payload.afterJottathingBlockId,
    mappings,
    store,
  });
  let nextMapping: BlockMapping;
  let createdBlock: NotionBlock | undefined;

  if (existing?.notionBlockId) {
    await checkConflictResolutionRace({
      content,
      desired,
      existing,
      listAllBlockChildren,
      localBlock,
      mappings,
      notionBlockId: existing.notionBlockId,
      notionPageId,
      store,
    });
  }

  if (!existing?.notionBlockId) {
    createdBlock = await createBlock('new');
    nextMapping = mappingFromDesired(desired, createdBlock.id, {}, createdBlock);
  } else if (existing.lastSyncedHash === desired.lastSyncedHash) {
    nextMapping = mappingFromDesired(desired, existing.notionBlockId, existing);
  } else if (isUpdateCompatible(existing, desired)) {
    await updateManagedBlock(store, existing.notionBlockId, notionBlock);
    nextMapping = mappingFromDesired(desired, existing.notionBlockId, existing);
  } else {
    createdBlock = await createBlock('replacement');
    if (createdBlock.id !== existing.notionBlockId) {
      await deleteManagedBlock(store, existing.notionBlockId);
    }
    nextMapping = mappingFromDesired(desired, createdBlock.id, existing, createdBlock);
  }

  if (existingIndex >= 0) mappings.splice(existingIndex, 1);
  const previousIndex = mappings.findIndex(
    (mapping) => mappingKey(mapping) === op.payload.afterJottathingBlockId,
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

/** Rejects a reviewed edit if either side changed again while it was queued. */
async function checkConflictResolutionRace({
  content,
  desired,
  existing,
  listAllBlockChildren,
  localBlock,
  mappings,
  notionBlockId,
  notionPageId,
  store,
}: {
  content: DocumentContent;
  desired: DesiredManagedBlock;
  existing: BlockMapping;
  listAllBlockChildren: ListAllBlockChildren;
  localBlock: DocumentContent;
  mappings: BlockMapping[];
  notionBlockId: string;
  notionPageId: string;
  store: WorkerStore;
}): Promise<void> {
  const remoteBlocks = await listAllBlockChildren(store, notionPageId);
  const current = remoteBlocks.find((block) => block.id === notionBlockId);
  if (current && localBlock.attrs?.jottathingConflictResolution === true) {
    existing.newState = current as unknown as NotionBlockPayload;
  }

  const baseState = existing.newState;
  if (!baseState || existing.lastSyncedHash === desired.lastSyncedHash) return;

  const baseSignature = managedBlockSignature(baseState);
  const currentSignature = current ? managedBlockSignature(current) : undefined;
  const desiredSignature = managedBlockSignature(desired.notionBlock);
  const remoteChanged = !current || (
    baseSignature !== undefined && currentSignature !== baseSignature
  );
  if (!remoteChanged || currentSignature === desiredSignature) return;

  const replacement = !current && remoteBlocks.find((block) =>
    managedBlockSignature(block) === (baseSignature ?? desiredSignature),
  );
  if (replacement) {
    existing.notionBlockId = replacement.id;
    return;
  }

  throw createBlockOperationConflict({
    blockId: desired.jottathingBlockId,
    baseState,
    current,
    localContent: content,
    mappings,
    localBlock,
    remoteBlocks,
  });
}

/** Recovers an earlier queue write or appends the block after its mapped anchor. */
async function createOrRecoverManagedBlock(options: CreateManagedBlockOptions): Promise<NotionBlock> {
  const {
    appendManagedBlocks,
    failureMessage,
    listAllBlockChildren,
    localPageId,
    notionBlock,
    notionPageId,
    afterJottathingBlockId,
    mappings,
    store,
  } = options;
  const previousBlockId = mappings.find((mapping) =>
    mappingKey(mapping) === afterJottathingBlockId && mapping.notionBlockId,
  )?.notionBlockId;
  const created = await findRetryCreatedBlock({
    listAllBlockChildren,
    localPageId,
    notionBlock,
    notionPageId,
    previousBlockId,
    store,
  }) ?? await appendAndTrackBlock(
    appendManagedBlocks,
    store,
    notionPageId,
    notionBlock,
    positionAfter(previousBlockId),
    [],
    0,
  );
  if (!created?.id) throw new Error(failureMessage);
  return created;
}

function createBlockOperationConflict({
  blockId,
  baseState,
  current,
  localContent,
  mappings,
  localBlock,
  remoteBlocks,
}: {
  blockId: string;
  baseState: NotionBlockPayload | undefined;
  current: NotionBlock | undefined;
  localContent: DocumentContent;
  mappings: BlockMapping[];
  localBlock: DocumentContent;
  remoteBlocks: NotionBlock[];
}): UnmappedNotionContentError {
  const baseDocument = baseState
    ? notionBlocksToTiptapDocumentStrict([baseState as unknown as NotionBlock])
    : null;
  const remoteContent = notionBlocksToTiptapDocumentStrict(remoteBlocks);
  const localNodes = localContent.content ?? [];
  const hasLocalBlock = localNodes.some((node) =>
    String(node.attrs?.jottathingBlockId ?? '') === blockId,
  );
  const completeLocalContent: DocumentContent = {
    ...localContent,
    type: localContent.type ?? 'doc',
    content: hasLocalBlock
      ? localNodes
      : [...localNodes, { ...localBlock, attrs: { ...localBlock.attrs, jottathingBlockId: blockId } }],
  };
  if (remoteContent) {
    const idByNotionId = new Map(mappings
      .filter((mapping) => mapping.notionBlockId)
      .map((mapping) => [mapping.notionBlockId!, mapping.jottathingBlockId]));
    remoteContent.content = remoteContent.content?.map((node, index) => {
      const notionId = remoteBlocks[index]?.id;
      const mappedId = notionId
        ? idByNotionId.get(notionId) ?? (notionId === current?.id ? blockId : undefined)
        : undefined;
      return {
        ...node,
        attrs: {
          ...node.attrs,
          ...(mappedId ? { jottathingBlockId: mappedId } : {}),
          ...(notionId ? { notionBlockId: notionId } : {}),
        },
      };
    });
  }

  return new UnmappedNotionContentError({
    baseContent: baseDocument?.content?.[0]
      ? {
          type: 'doc',
          content: [{
            ...baseDocument.content[0],
            attrs: { ...baseDocument.content[0].attrs, jottathingBlockId: blockId },
          }],
        }
      : null,
    localChangedBlockIds: [blockId],
    remoteChangedBlockIds: [blockId],
    localContent: completeLocalContent,
    remoteContent,
  });
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
