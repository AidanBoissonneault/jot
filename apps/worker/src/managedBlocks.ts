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
import type { BlockPosition, DesiredManagedBlock } from './managedBlockIdentity.js';
import { rebuildReorderedRange, reconcileManagedBlocks } from './managedBlockReconciliation.js';

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
}: Pick<
  ReplaceManagedBlocksOptions,
  | 'appendManagedBlocks'
  | 'deleteManagedBlock'
  | 'listAllBlockChildren'
  | 'localPageId'
  | 'notionPageId'
  | 'store'
> & { desiredBlocks: DesiredManagedBlock[]; notionBlocks: NotionBlockPayload[] }) {
  const existingBlocks = await listAllBlockChildren(store, notionPageId);

  for (const block of existingBlocks) {
    await deleteManagedBlock(store, block.id);
  }

  const createdBlocks = await appendManagedBlocks(store, notionPageId, notionBlocks);
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
