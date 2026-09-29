/**
 * @file Performs paginated reads and block/page mutations against the Notion API.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */
import type { BlockPosition } from '../workerUtils.js';
import type {
  JsonObject,
  ListAllBlockChildren,
  NotionBlock,
  NotionBlockPayload,
  NotionObject,
  NotionRequester,
  WorkerStore,
} from '../types.js';

/** API and stateless utility dependencies used by Notion block operations. */
interface NotionBlockOperationDependencies {
  chunks: <Value>(values: Value[], size: number) => Value[][];
  isNotionFileUploadBlock: (block: NotionBlockPayload) => boolean;
  mediaFallbackBlock: (block: NotionBlockPayload) => NotionBlockPayload;
  notionRequest: NotionRequester;
  positionAfterCreatedBlocks: (
    position: BlockPosition | undefined,
    createdBlocks: NotionBlock[],
  ) => BlockPosition | undefined;
  updateBodyFromNotionBlock: (block: NotionBlockPayload) => JsonObject;
}

/** Creates focused Notion page and block API operations. */
export function createNotionBlockOperations({
  chunks,
  isNotionFileUploadBlock,
  mediaFallbackBlock,
  notionRequest,
  positionAfterCreatedBlocks,
  updateBodyFromNotionBlock,
}: NotionBlockOperationDependencies) {
  /** Loads every paginated child of a Notion block. */
  async function listAllBlockChildren(
    store: WorkerStore,
    blockId: string,
  ): ReturnType<ListAllBlockChildren> {
    const results: NotionBlock[] = [];
    let cursor: string | undefined;

    do {
      const search = new URLSearchParams();
      search.set('page_size', '100');
      if (cursor) search.set('start_cursor', cursor);

      const response = await notionRequest(store, `/blocks/${blockId}/children?${search}`);
      results.push(...(response.results as NotionBlock[]));
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return results;
  }

  /** Creates a child page beneath a Notion page. */
  async function createChildPage(
    store: WorkerStore,
    parentPageId: string,
    title: string,
  ): Promise<NotionObject> {
    return notionRequest(store, '/pages', {
      method: 'POST',
      body: {
        parent: { type: 'page_id', page_id: parentPageId },
        properties: { title: [{ text: { content: title || 'Untitled Page' } }] },
      },
    });
  }

  /** Creates a top-level workspace page. */
  async function createWorkspacePage(store: WorkerStore, title: string): Promise<NotionObject> {
    return notionRequest(store, '/pages', {
      method: 'POST',
      body: {
        parent: { type: 'workspace', workspace: true },
        properties: { title: [{ text: { content: title || 'Inkwell' } }] },
      },
    });
  }

  /** Updates a Notion page title. */
  async function updatePageTitle(
    store: WorkerStore,
    pageId: string,
    title: string,
  ): Promise<NotionObject> {
    return notionRequest(store, `/pages/${pageId}`, {
      method: 'PATCH',
      body: { properties: { title: [{ text: { content: title || 'Untitled Page' } }] } },
    });
  }

  /** Updates a linked note page title and archive state. */
  async function updateChildNotePage(
    store: WorkerStore,
    pageId: string,
    page: { status?: string; title: string },
  ): Promise<NotionObject> {
    const body: JsonObject = {
      properties: { title: [{ text: { content: page.title || 'Untitled Page' } }] },
    };
    if (page.status === 'archived') body.archived = true;
    return notionRequest(store, `/pages/${pageId}`, { method: 'PATCH', body });
  }

  /** Archives a legacy project root page. */
  async function archiveProjectRootPage(store: WorkerStore, pageId: string): Promise<NotionObject> {
    return notionRequest(store, `/pages/${pageId}`, { method: 'PATCH', body: { archived: true } });
  }

  /** Deletes a managed Notion block. */
  async function deleteManagedBlock(store: WorkerStore, blockId: string): Promise<NotionObject> {
    return notionRequest(store, `/blocks/${blockId}`, { method: 'DELETE' });
  }

  /** Updates a managed Notion block in place. */
  async function updateManagedBlock(
    store: WorkerStore,
    blockId: string,
    notionBlock: NotionBlockPayload,
  ): Promise<NotionObject> {
    return notionRequest(store, `/blocks/${blockId}`, {
      method: 'PATCH',
      body: updateBodyFromNotionBlock(notionBlock),
    });
  }

  /** Appends managed blocks in API-sized batches. */
  async function appendManagedBlocks(
    store: WorkerStore,
    notionPageId: string,
    notionBlocks: NotionBlockPayload[],
    position?: BlockPosition,
  ): Promise<NotionBlock[]> {
    const createdBlocks: NotionBlock[] = [];

    for (const batch of chunks(notionBlocks, 100)) {
      let results: NotionBlock[];
      try {
        const response = await notionRequest(store, `/blocks/${notionPageId}/children`, {
          method: 'PATCH',
          body: { children: batch, ...(position ? { position } : {}) },
        });
        results = response.results as NotionBlock[];
      } catch {
        results = await appendBlocksWithFallback(store, notionPageId, batch, position);
      }

      createdBlocks.push(...results);
      position = positionAfterCreatedBlocks(position, results);
    }

    return createdBlocks;
  }

  /** Appends blocks individually and substitutes unsupported media with links. */
  async function appendBlocksWithFallback(
    store: WorkerStore,
    notionPageId: string,
    blocks: NotionBlockPayload[],
    position?: BlockPosition,
  ): Promise<NotionBlock[]> {
    const results: NotionBlock[] = [];

    for (const block of blocks) {
      try {
        const response = await notionRequest(store, `/blocks/${notionPageId}/children`, {
          method: 'PATCH',
          body: { children: [block], ...(position ? { position } : {}) },
        });
        const created = response.results as NotionBlock[];
        results.push(...created);
        position = positionAfterCreatedBlocks(position, created);
      } catch (error) {
        // A Notion file upload is the only durable copy of a dropped local file.
        // Never turn a transient attach failure into a permanent placeholder;
        // fail the sync job so the queue retries the original upload instead.
        if (isNotionFileUploadBlock(block)) {
          throw error;
        }

        const fallback = mediaFallbackBlock(block);
        try {
          const response = await notionRequest(store, `/blocks/${notionPageId}/children`, {
            method: 'PATCH',
            body: { children: [fallback], ...(position ? { position } : {}) },
          });
          const created = response.results as NotionBlock[];
          results.push(...created);
          position = positionAfterCreatedBlocks(position, created);
        } catch {
          // Skip a non-durable block rather than aborting the whole page.
        }
      }
    }

    return results;
  }

  return {
    appendBlocksWithFallback,
    appendManagedBlocks,
    archiveProjectRootPage,
    createChildPage,
    createWorkspacePage,
    deleteManagedBlock,
    listAllBlockChildren,
    updateChildNotePage,
    updateManagedBlock,
    updatePageTitle,
  };
}
