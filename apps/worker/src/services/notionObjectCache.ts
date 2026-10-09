/**
 * @file Validates cached Notion identities and clears stale project and page mappings.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */
import { projectStateKey, threadKey } from '../projectDatabaseValues.js';
import type { Project, ProjectPage } from '../../../../src/types/capture.js';
import type { AppendLog, NotionRequester, NotionObject, WorkerStore } from '../types.js';

/** Notion request and error helpers used to validate cached identities. */
interface NotionObjectCacheDependencies {
  appendLog: AppendLog;
  isBlockNotPageError: (error: unknown) => boolean;
  isNotionObjectNotFound: (error: unknown) => boolean;
  notionRequest: NotionRequester;
}

/** Stable identifiers read from the managed Notion database. */
interface NotionWorkspaceStructure {
  pageIds: string[];
  projectIds: string[];
  projectPageIds: string[];
}

/** Runs independent remote existence checks concurrently without flooding Notion. */
async function mapWithConcurrency<Value>(
  values: Value[],
  limit: number,
  check: (value: Value) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      await check(values[index]);
    }
  }));
}

/** Creates cache validation and lookup operations for Notion-backed pages. */
export function createNotionObjectCache({
  appendLog,
  isBlockNotPageError,
  isNotionObjectNotFound,
  notionRequest,
}: NotionObjectCacheDependencies) {
  /** Removes every cached record associated with a local page. */
  function uncachePage(store: WorkerStore, pageId: string): void {
    delete store.threadBlocks?.[threadKey(pageId)];
    delete store.notePages?.[pageId];
    delete store.blockMappings?.[pageId];
  }

  /** Checks whether a cached Notion object remains retrievable. */
  async function notionObjectExists(
    store: WorkerStore,
    kind: 'block' | 'database' | 'page',
    id: string,
  ): Promise<boolean> {
    try {
      const endpoint =
        kind === 'database'
          ? `/databases/${id}`
          : kind === 'block'
            ? `/blocks/${id}`
            : `/pages/${id}`;
      await notionRequest(store, endpoint);
      return true;
    } catch (error) {
      if (isNotionObjectNotFound(error)) return false;
      throw error;
    }
  }

  /** Determines whether a local page is represented by a toggle block. */
  function isThreadBackedPage(store: WorkerStore, page: ProjectPage): boolean {
    const cachedThread = store.threadBlocks?.[threadKey(page.id)];
    const cachedNote = store.notePages?.[page.id];
    return Boolean(cachedThread?.blockId === page.notionPageId || cachedNote?.kind === 'thread');
  }

  /** Retrieves a linked page, falling back to the block endpoint for threads. */
  async function retrieveNotionPageOrBlock(
    store: WorkerStore,
    page: ProjectPage,
  ): Promise<NotionObject> {
    if (isThreadBackedPage(store, page)) {
      return notionRequest(store, `/blocks/${page.notionPageId}`);
    }

    try {
      return await notionRequest(store, `/pages/${page.notionPageId}`);
    } catch (error) {
      if (!isBlockNotPageError(error)) throw error;
      appendLog(store, 'sync_pull_block_fallback', page.title ?? page.id);
      return notionRequest(store, `/blocks/${page.notionPageId}`);
    }
  }

  /** Removes cached mappings for Notion objects that can no longer be retrieved. */
  async function validateNotionCache(
    store: WorkerStore,
    {
      pages,
      projects,
      remoteStructure,
      databaseVerified = false,
    }: {
      pages: ProjectPage[];
      projects: Project[];
      remoteStructure?: NotionWorkspaceStructure;
      databaseVerified?: boolean;
    },
  ) {
    const uncachedProjectIds = new Set<string>();
    const uncachedPageIds = new Set<string>();
    let clearSelectedParentPage = false;
    let changed = false;

    if (
      store.inkwellRootPage?.id &&
      !(await notionObjectExists(store, 'page', store.inkwellRootPage.id))
    ) {
      store.inkwellRootPage = undefined;
      store.inkwellDatabase = undefined;
      store.projectPages = {};
      store.projectBlocks = {};
      store.threadBlocks = {};
      store.notePages = {};
      store.blockMappings = {};
      clearSelectedParentPage = true;
      for (const project of projects) uncachedProjectIds.add(project.id);
      for (const page of pages) uncachedPageIds.add(page.id);
      return {
        changed: true,
        clearSelectedParentPage,
        uncachedProjectIds: [...uncachedProjectIds],
        uncachedPageIds: [...uncachedPageIds],
      };
    }

    if (
      !databaseVerified &&
      store.inkwellDatabase?.databaseId &&
      !(await notionObjectExists(store, 'database', store.inkwellDatabase.databaseId))
    ) {
      store.inkwellDatabase = undefined;
      store.projectPages = {};
      store.projectBlocks = {};
      store.threadBlocks = {};
      store.notePages = {};
      store.blockMappings = {};
      for (const project of projects) uncachedProjectIds.add(project.id);
      for (const page of pages) uncachedPageIds.add(page.id);
      changed = true;
    }

    const remoteProjectPageIds = remoteStructure && new Set(remoteStructure.projectPageIds);
    const locallyThreadBackedPageIds = remoteStructure && new Set(
      pages.filter((page) => isThreadBackedPage(store, page)).map((page) => page.id),
    );
    await mapWithConcurrency(projects, 5, async (project) => {
      const cached = store.projectPages?.[project.id];
      const isMissing = remoteStructure
        ? project.status !== 'archived' && Boolean(
            cached?.notionPageId && !remoteProjectPageIds?.has(cached.notionPageId),
          )
        : Boolean(
            cached?.notionPageId && !(await notionObjectExists(store, 'page', cached.notionPageId)),
          );

      if (!isMissing) return;

      delete store.projectPages[project.id];
      delete store.projectBlocks?.[projectStateKey(project.id)];
      uncachedProjectIds.add(project.id);
      for (const page of pages.filter((item) => item.projectId === project.id)) {
        uncachePage(store, page.id);
        uncachedPageIds.add(page.id);
      }
      changed = true;
    });

    const remoteThreadBlockIds = remoteStructure && new Set(remoteStructure.pageIds);
    await mapWithConcurrency(pages, 5, async (page) => {
      const cachedThread = store.threadBlocks?.[threadKey(page.id)];
      const cachedNote = store.notePages?.[page.id];
      const notionPageId = page.notionPageId ?? cachedNote?.notionPageId;

      if (
        remoteStructure &&
        page.status !== 'archived' &&
        locallyThreadBackedPageIds?.has(page.id)
      ) {
        const remoteId = cachedThread?.blockId ?? notionPageId;
        if (remoteId && !remoteThreadBlockIds?.has(remoteId)) {
          uncachePage(store, page.id);
          uncachedPageIds.add(page.id);
          changed = true;
        }
        return;
      }

      // Archived pages and structural threads were already resolved by the
      // inventory. Avoid one Notion GET for every historical page on each sync.
      if (remoteStructure && page.status === 'archived') return;

      if (
        cachedThread?.blockId &&
        !(await notionObjectExists(store, 'block', cachedThread.blockId))
      ) {
        uncachePage(store, page.id);
        uncachedPageIds.add(page.id);
        changed = true;
        return;
      }

      if (
        notionPageId &&
        !cachedThread?.blockId &&
        !(await notionObjectExists(
          store,
          cachedNote?.kind === 'thread' ? 'block' : 'page',
          notionPageId,
        ))
      ) {
        uncachePage(store, page.id);
        uncachedPageIds.add(page.id);
        changed = true;
      }
    });

    return {
      changed,
      clearSelectedParentPage,
      uncachedProjectIds: [...uncachedProjectIds],
      uncachedPageIds: [...uncachedPageIds],
    };
  }

  return {
    notionObjectExists,
    retrieveNotionPageOrBlock,
    uncachePage,
    validateNotionCache,
  };
}
