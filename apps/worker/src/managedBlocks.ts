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

  // An empty document may be a partial queue envelope. Never interpret it as
  // permission to erase the remote note.
  if (!desiredBlocks.length) {
    return { createdBlocks: [], notionBlocks };
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
    });
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
  let nextDesiredIndex = 0;

  for (const existingBlock of existingBlocks) {
    const signature = managedBlockSignature(existingBlock);
    const matchIndex = desiredBlocks.findIndex((desired, index) =>
      index >= nextDesiredIndex && managedBlockSignature(desired.notionBlock) === signature,
    );

    if (matchIndex < 0) {
      throw new Error(
        'Notion has content without matching Inkwell block mappings. Existing content was preserved; reload the note before syncing again.',
      );
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
