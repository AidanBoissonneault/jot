/** @file Composes focused Notion transport, cache, page, block, and managed-block operations. */
import {
  isNotionFileUploadBlock,
  kindFromNotionBlock,
  notionBlocksToTiptapDocument,
  tiptapDocumentToNotionBlocks,
} from '../blockConversion.js';
import { importManagedBlocks as importManagedBlocksWithDependencies } from '../importManagedBlocks.js';
import { replaceManagedBlocks as replaceManagedBlocksWithDependencies } from '../managedBlocks.js';
import { applyManagedBlockOps as applyManagedBlockOpsWithDependencies } from '../managedBlockOperations.js';
import type { DocumentContent, Project, ProjectPage } from '../../../../src/types/capture.js';
import type {
  ManagedBlockOperation,
  NotionBlock,
  NotionBlockPayload,
  NotionObject,
  NotionRequester,
  WorkerStore,
} from '../types.js';
import {
  chunks,
  hash,
  isBlockNotPageError,
  isNotionObjectNotFound,
  mediaFallbackBlock,
  positionAfterCreatedBlocks,
  updateBodyFromNotionBlock,
} from '../workerUtils.js';
import type { BlockPosition } from '../workerUtils.js';
import { createNotionBlockOperations } from './notionBlockOperations.js';
import { createNotionObjectCache } from './notionObjectCache.js';

/** API transport and logging used by the Notion operation graph. */
interface WorkerNotionOperationsDependencies {
  appendLog: (store: WorkerStore, event: string, message: string) => void;
  notionRequest: NotionRequester;
}

/** Creates cache, block, page, and managed-block services around one Notion requester. */
export function createWorkerNotionOperations({
  appendLog,
  notionRequest,
}: WorkerNotionOperationsDependencies) {
  const notionBlockOperations = createNotionBlockOperations({
    chunks,
    isNotionFileUploadBlock,
    mediaFallbackBlock,
    notionRequest,
    positionAfterCreatedBlocks,
    updateBodyFromNotionBlock,
  });
  const notionObjectCache = createNotionObjectCache({
    appendLog,
    isBlockNotPageError,
    isNotionObjectNotFound,
    notionRequest,
  });

  /** Checks and clears stale Notion object mappings in the local store. */
  function validateNotionCache(
    store: WorkerStore,
    entities: { pages: ProjectPage[]; projects: Project[] },
  ) {
    return notionObjectCache.validateNotionCache(store, entities);
  }

  /** Removes all cached Notion records associated with a local page. */
  function uncachePage(store: WorkerStore, pageId: string): void {
    notionObjectCache.uncachePage(store, pageId);
  }

  /** Checks whether a cached Notion page, block, or database can still be retrieved. */
  function notionObjectExists(
    store: WorkerStore,
    kind: 'block' | 'database' | 'page',
    id: string,
  ): Promise<boolean> {
    return notionObjectCache.notionObjectExists(store, kind, id);
  }

  /** Retrieves a linked page, falling back to the block endpoint for thread toggles. */
  function retrieveNotionPageOrBlock(store: WorkerStore, page: ProjectPage): Promise<NotionObject> {
    return notionObjectCache.retrieveNotionPageOrBlock(store, page);
  }

  /** Replaces managed children and updates local block mappings. */
  async function replaceManagedBlocks(
    store: WorkerStore,
    localPageId: string,
    notionPageId: string,
    content: DocumentContent,
  ) {
    return replaceManagedBlocksWithDependencies({
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
    });
  }

  /** Applies incremental managed-block changes and falls back to document reconciliation. */
  async function applyManagedBlockOps(
    store: WorkerStore,
    localPageId: string,
    notionPageId: string,
    ops: ManagedBlockOperation[],
    content: DocumentContent,
  ) {
    return applyManagedBlockOpsWithDependencies({
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
    });
  }

  /** Imports supported remote child blocks for a linked page. */
  async function importManagedBlocks(
    store: WorkerStore,
    page: ProjectPage,
  ): Promise<DocumentContent | null> {
    if (!page.notionPageId) return null;
    return importManagedBlocksWithDependencies({
      hash,
      listAllBlockChildren,
      page: { id: page.id, notionPageId: page.notionPageId },
      store,
    });
  }

  /** Lists every paginated child block beneath a Notion object. */
  function listAllBlockChildren(store: WorkerStore, blockId: string): Promise<NotionBlock[]> {
    return notionBlockOperations.listAllBlockChildren(store, blockId);
  }

  /** Creates a child page beneath a Notion page. */
  function createChildPage(
    store: WorkerStore,
    parentPageId: string,
    title: string,
  ): Promise<NotionObject> {
    return notionBlockOperations.createChildPage(store, parentPageId, title);
  }

  /** Creates a top-level workspace page. */
  function createWorkspacePage(store: WorkerStore, title: string): Promise<NotionObject> {
    return notionBlockOperations.createWorkspacePage(store, title);
  }

  /** Updates a Notion page title. */
  function updatePageTitle(
    store: WorkerStore,
    pageId: string,
    title: string,
  ): Promise<NotionObject> {
    return notionBlockOperations.updatePageTitle(store, pageId, title);
  }

  /** Updates a linked note page title and archive state. */
  function updateChildNotePage(
    store: WorkerStore,
    pageId: string,
    page: ProjectPage,
  ): Promise<NotionObject> {
    return notionBlockOperations.updateChildNotePage(store, pageId, page);
  }

  /** Archives a legacy project root page. */
  function archiveProjectRootPage(store: WorkerStore, pageId: string): Promise<NotionObject> {
    return notionBlockOperations.archiveProjectRootPage(store, pageId);
  }

  /** Deletes one locally managed Notion block. */
  function deleteManagedBlock(store: WorkerStore, blockId: string): Promise<NotionObject> {
    return notionBlockOperations.deleteManagedBlock(store, blockId);
  }

  /** Updates one locally managed Notion block. */
  function updateManagedBlock(
    store: WorkerStore,
    blockId: string,
    notionBlock: NotionBlockPayload,
  ): Promise<NotionObject> {
    return notionBlockOperations.updateManagedBlock(store, blockId, notionBlock);
  }

  /** Appends managed blocks in API-sized batches at an optional position. */
  function appendManagedBlocks(
    store: WorkerStore,
    notionPageId: string,
    notionBlocks: NotionBlockPayload[],
    position?: BlockPosition,
  ): Promise<NotionBlock[]> {
    return notionBlockOperations.appendManagedBlocks(store, notionPageId, notionBlocks, position);
  }

  /** Appends blocks individually and substitutes unsupported media when necessary. */
  function appendBlocksWithFallback(
    store: WorkerStore,
    notionPageId: string,
    blocks: NotionBlockPayload[],
    position?: BlockPosition,
  ): Promise<NotionBlock[]> {
    return notionBlockOperations.appendBlocksWithFallback(store, notionPageId, blocks, position);
  }

  return {
    appendBlocksWithFallback,
    appendManagedBlocks,
    applyManagedBlockOps,
    archiveProjectRootPage,
    createChildPage,
    createWorkspacePage,
    deleteManagedBlock,
    importManagedBlocks,
    listAllBlockChildren,
    notionObjectExists,
    replaceManagedBlocks,
    retrieveNotionPageOrBlock,
    uncachePage,
    updateChildNotePage,
    updateManagedBlock,
    updatePageTitle,
    validateNotionCache,
  };
}
