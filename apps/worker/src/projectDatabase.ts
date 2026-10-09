/**
 * @file Coordinates creation, discovery, import, and synchronization of the Notion project database.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import {
  isArchivedAncestorError,
  isArchivedObject,
  pageSummaryFromNotionPage,
  projectStateKey,
  threadKey,
  toggleTitle,
} from './projectDatabaseValues.js';

export { projectStateKey, threadKey } from './projectDatabaseValues.js';
import {
  clearSyncMappings,
  createProjectDatabaseRows,
  invalidateProjectDatabase,
  projectFromNotionPage,
  storeProjectPage,
} from './projectDatabaseRows.js';
import { createProjectDatabaseStateHelpers } from './projectDatabaseState.js';
import { createProjectDatabaseDiscoveryHelpers } from './projectDatabaseDiscovery.js';
import { isNotionObjectForbidden } from './workerUtils.js';

import type { DocumentContent, Project, ProjectPage } from '../../../src/types/capture.js';
import type {
  AppendLog,
  InkwellDatabase,
  ListAllBlockChildren,
  NotionBlock,
  NotionBlockPayload,
  NotionObject,
  NotionRequester,
  ReplaceManagedBlocks,
  StoredPage,
  WorkerStore,
} from './types.js';

/** Describes the document to blocks contract used by this API feature. */
type DocumentToBlocks = (document: DocumentContent) => NotionBlockPayload[];
/** Describes the blocks to document contract used by this API feature. */
type BlocksToDocument = (blocks: NotionBlock[]) => DocumentContent;

/** Describes the project database dependencies contract used by this API feature. */
interface ProjectDatabaseDependencies {
  appendLog: AppendLog;
  createWorkspacePage: (store: WorkerStore, title: string) => Promise<NotionObject>;
  importManagedBlocks: (
    store: WorkerStore,
    page: { id: string; notionPageId: string },
    notionBlocks: NotionBlock[],
  ) => Promise<DocumentContent | null>;
  isNotionObjectNotFound: (error: unknown) => boolean;
  listAllBlockChildren: ListAllBlockChildren;
  notionBlocksToTiptapDocument: BlocksToDocument;
  notionRequest: NotionRequester;
  replaceManagedBlocks: ReplaceManagedBlocks;
  tiptapDocumentToNotionBlocks: DocumentToBlocks;
  deleteManagedBlock?: (store: WorkerStore, blockId: string) => Promise<unknown>;
  updateManagedBlock?: (
    store: WorkerStore,
    blockId: string,
    block: NotionBlockPayload,
  ) => Promise<unknown>;
}

/** Describes the parent selection contract used by this API feature. */
interface ParentSelection {
  selectedParentPageId: string | undefined;
}

/** Describes the ensure project page options contract used by this API feature. */
interface EnsureProjectPageOptions extends ParentSelection {
  isForcedMerge: boolean;
  retryOnArchivedAncestor: boolean;
  syncState: boolean;
}

/** Describes the project page result contract used by this API feature. */
interface ProjectPageResult {
  id: string;
  parentPageId?: string;
  project: Project;
  title: string;
  url?: string;
}

/** Runs API-bound reads with a small concurrency limit while preserving result order. */
async function mapWithConcurrency<Input, Output>(
  values: Input[],
  limit: number,
  map: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await map(values[index], index);
    }
  }));
  return results;
}

/**
 * Creates project-database operations bound to Notion and persistence dependencies.
 * @param dependencies - Notion transport, conversion, logging, and mapping dependencies.
 * @returns Operations for project databases, rows, state blocks, and thread toggles.
 */

export function createProjectDatabaseHelpers({
  appendLog,
  createWorkspacePage,
  deleteManagedBlock,
  importManagedBlocks,
  isNotionObjectNotFound,
  listAllBlockChildren,
  notionBlocksToTiptapDocument,
  notionRequest,
  replaceManagedBlocks,
  tiptapDocumentToNotionBlocks,
  updateManagedBlock,
}: ProjectDatabaseDependencies) {
  const { ensureProjectDatabase } = createProjectDatabaseDiscoveryHelpers({
    appendLog,
    createWorkspacePage,
    isNotionObjectNotFound,
    notionRequest,
  });
  const {
    queryManagedProjectRows,
    findProjectPageByInkwellId,
    createProjectDatabasePage,
    updateProjectDatabasePage,
  } = createProjectDatabaseRows(notionRequest);
  const {
    archiveThreadToggle,
    ensureProjectStateContainer,
    ensureThreadToggle,
    importProjectState,
    importThreadContent,
    pageFromThreadBlock,
    syncProjectState,
    updateThreadToggleTitle,
  } = createProjectDatabaseStateHelpers({
    importManagedBlocks,
    listAllBlockChildren,
    notionBlocksToTiptapDocument,
    notionRequest,
    replaceManagedBlocks,
    deleteManagedBlock,
    updateManagedBlock,
    tiptapDocumentToNotionBlocks,
  });

  /** Ensures a row exists for a project. @param store - Worker state. @param project - Local project. @param options - Sync options. @returns Project page result. */
  async function ensureProjectPage(
    store: WorkerStore,
    project: Project,
    {
      selectedParentPageId,
      syncState = true,
      isForcedMerge = project.stateContent?.attrs?.inkwellConflictResolution === true,
    }: Partial<Pick<EnsureProjectPageOptions, 'selectedParentPageId' | 'syncState' | 'isForcedMerge'>> = {},
  ): Promise<ProjectPageResult> {
    return ensureProjectPageAttempt(store, project, { selectedParentPageId, syncState, isForcedMerge });
  }

  /** Performs a project-row sync attempt. @param store - Worker state. @param project - Local project. @param options - Retry options. @returns Project page result. */
  async function ensureProjectPageAttempt(
    store: WorkerStore,
    project: Project,
    {
      selectedParentPageId,
      retryOnArchivedAncestor = true,
      syncState = true,
      isForcedMerge = project.stateContent?.attrs?.inkwellConflictResolution === true,
    }: Partial<EnsureProjectPageOptions> = {},
  ): Promise<ProjectPageResult> {
    const database = await ensureProjectDatabase(store, { selectedParentPageId });
    const stored = store.projectPages?.[project.id];
    const existingPageId = stored?.notionPageId;
    let page = existingPageId
      ? await notionRequest(store, `/pages/${existingPageId}`).catch((error) => {
          if (isNotionObjectNotFound(error) || (!isForcedMerge && isNotionObjectForbidden(error))) {
            return undefined;
          }
          throw error;
        })
      : undefined;

    if (!page) {
      page = await findProjectPageByInkwellId(store, database.dataSourceId, project.id);
    }

    try {
      if (!page) {
        page = await createProjectDatabasePage(store, database.dataSourceId, project);
        appendLog(store, 'project_database_page_created', project.name || 'Untitled Project');
      } else {
        page = await updateProjectDatabasePage(store, page.id, project);
      }

      const stateSync = syncState
        ? await syncProjectState(store, page.id, project, isForcedMerge)
        : undefined;
      storeProjectPage(store, database, project, page);
      return {
        ...pageSummaryFromNotionPage(page, database),
        project: stateSync?.content
          ? {
              ...project,
              stateContent: stateSync.content,
              stateRemoteRevision: stateSync.lastEditedTime,
            }
          : {
              ...project,
              stateRemoteRevision: stateSync?.lastEditedTime ?? project.stateRemoteRevision,
            },
      };
    } catch (error) {
      if (!retryOnArchivedAncestor || !isArchivedAncestorError(error)) {
        throw error;
      }

      invalidateProjectDatabase(store, database.databaseId);
      appendLog(store, 'project_database_archived_ancestor', database.title);
      return ensureProjectPageAttempt(store, project, {
        selectedParentPageId,
        retryOnArchivedAncestor: false,
        syncState,
        isForcedMerge,
      });
    }
  }

  /** Rebuilds local state from Notion. @param store - Worker state. @param options - Parent selection. @returns Imported state. */
  async function reloadProjectDatabaseFromNotion(
    store: WorkerStore,
    { selectedParentPageId }: ParentSelection = { selectedParentPageId: undefined },
  ) {
    clearSyncMappings(store, { preserveBlockMappings: true });
    const requestedParentPageId = selectedParentPageId;
    const database = await ensureProjectDatabase(store, { selectedParentPageId, readOnly: true });
    const clearSelectedParentPage = Boolean(
      requestedParentPageId &&
      store.inkwellRootPage?.id &&
      store.inkwellRootPage.id !== requestedParentPageId,
    );
    const rows = await queryManagedProjectRows(store, database.dataSourceId);
    const projects: Project[] = [];
    const pages: ProjectPage[] = [];
    const activePageIdsByProject: Record<string, string> = {};

    const projectRows = rows.flatMap((row) => {
      const project = projectFromNotionPage(row);
      return project && project.status !== 'archived' ? [{ row, project }] : [];
    });

    // Read independent project rows concurrently. Notion's shared requester
    // still enforces its global rate limit, while concurrent reads avoid adding
    // network latency on top of the required request spacing.
    const rowsWithChildren = await mapWithConcurrency(projectRows, 3, async ({ row, project }) => ({
      row,
      project,
      // Abort the reload if any project row cannot be read. Returning a partial
      // snapshot would make the client replace a complete workspace with an
      // incomplete one after a transient Notion failure.
      children: await listAllBlockChildren(store, row.id),
    }));

    const importedRows = await mapWithConcurrency(rowsWithChildren, 3, async ({ row, project, children }) => {
      storeProjectPage(store, database, project, row);
      const stateBlock = children.find(
        (block) =>
          block.type === 'toggle' && !isArchivedObject(block) && toggleTitle(block) === 'Project State',
      );
      const threadBlocks = children.filter(
        (block) =>
          block.type === 'toggle' && !isArchivedObject(block) && toggleTitle(block) !== 'Project State',
      );
      const [importedProject, importedPages] = await Promise.all([
        stateBlock ? importProjectState(store, row, project, stateBlock) : Promise.resolve(project),
        mapWithConcurrency(threadBlocks, 3, (threadBlock) =>
          pageFromThreadBlock(store, project, row, threadBlock)),
      ]);
      return { project: importedProject, pages: importedPages };
    });

    for (const imported of importedRows) {
      projects.push(imported.project);
      for (const page of imported.pages) {
        pages.push(page);
        activePageIdsByProject[imported.project.id] ??= page.id;
      }
    }

    projects.sort(
      (first, second) => new Date(second.updatedAt).getTime() - new Date(first.updatedAt).getTime(),
    );

    for (const project of projects) {
      activePageIdsByProject[project.id] ??= '';
    }

    return {
      activePageIdsByProject,
      clearSelectedParentPage,
      currentProjectId: projects[0]?.id ?? '',
      pages,
      projects,
    };
  }

  /** Reads only active project and thread identities to detect cross-instance structure changes. */
  async function readProjectDatabaseStructure(
    store: WorkerStore,
    { selectedParentPageId }: ParentSelection = { selectedParentPageId: undefined },
  ) {
    const database = await ensureProjectDatabase(store, { selectedParentPageId, readOnly: true });
    const rows = await queryManagedProjectRows(store, database.dataSourceId);
    const projectRows = rows.flatMap((row) => {
      const project = projectFromNotionPage(row);
      return project && project.status !== 'archived' && !isArchivedObject(row)
        ? [{ row, project }]
        : [];
    });
    const projectIds = projectRows.map(({ project }) => project.id);
    const projectPageIds = projectRows.map(({ row }) => row.id);
    const pageIdGroups = await mapWithConcurrency(projectRows, 3, async ({ row }) => {
      const children = await listAllBlockChildren(store, row.id);
      return children.flatMap((block) =>
        block.type === 'toggle' &&
        !isArchivedObject(block) &&
        toggleTitle(block) !== 'Project State'
          ? [block.id]
          : [],
      );
    });
    // These are Notion block IDs, not generated local page IDs. Comparing the
    // server IDs to ProjectPage.id caused unchanged pages to look new on every
    // device because locally-created page IDs are random UUIDs.
    const pageIds = pageIdGroups.flat();

    return { pageIds, projectIds, projectPageIds };
  }

  return {
    archiveThreadToggle,
    ensureProjectDatabase,
    ensureProjectPage,
    ensureProjectStateContainer,
    ensureThreadToggle,
    importThreadContent,
    readProjectDatabaseStructure,
    reloadProjectDatabaseFromNotion,
    projectStateKey,
    threadKey,
    updateThreadToggleTitle,
  };
}
