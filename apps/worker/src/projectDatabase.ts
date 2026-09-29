/**
 * @file Coordinates creation, discovery, import, and synchronization of the Notion project database.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import {
  isArchivedAncestorError,
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
  isNotionObjectNotFound: (error: unknown) => boolean;
  listAllBlockChildren: ListAllBlockChildren;
  notionBlocksToTiptapDocument: BlocksToDocument;
  notionRequest: NotionRequester;
  replaceManagedBlocks: ReplaceManagedBlocks;
  tiptapDocumentToNotionBlocks: DocumentToBlocks;
}

/** Describes the parent selection contract used by this API feature. */
interface ParentSelection {
  selectedParentPageId: string | undefined;
}

/** Describes the ensure project page options contract used by this API feature. */
interface EnsureProjectPageOptions extends ParentSelection {
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

/**
 * Creates project-database operations bound to Notion and persistence dependencies.
 * @param dependencies - Notion transport, conversion, logging, and mapping dependencies.
 * @returns Operations for project databases, rows, state blocks, and thread toggles.
 */

export function createProjectDatabaseHelpers({
  appendLog,
  createWorkspacePage,
  isNotionObjectNotFound,
  listAllBlockChildren,
  notionBlocksToTiptapDocument,
  notionRequest,
  replaceManagedBlocks,
  tiptapDocumentToNotionBlocks,
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
    listAllBlockChildren,
    notionBlocksToTiptapDocument,
    notionRequest,
    replaceManagedBlocks,
  });

  /** Ensures a row exists for a project. @param store - Worker state. @param project - Local project. @param options - Sync options. @returns Project page result. */
  async function ensureProjectPage(
    store: WorkerStore,
    project: Project,
    {
      selectedParentPageId,
      syncState = true,
    }: Partial<Pick<EnsureProjectPageOptions, 'selectedParentPageId' | 'syncState'>> = {},
  ): Promise<ProjectPageResult> {
    return ensureProjectPageAttempt(store, project, { selectedParentPageId, syncState });
  }

  /** Performs a project-row sync attempt. @param store - Worker state. @param project - Local project. @param options - Retry options. @returns Project page result. */
  async function ensureProjectPageAttempt(
    store: WorkerStore,
    project: Project,
    {
      selectedParentPageId,
      retryOnArchivedAncestor = true,
      syncState = true,
    }: Partial<EnsureProjectPageOptions> = {},
  ): Promise<ProjectPageResult> {
    const database = await ensureProjectDatabase(store, { selectedParentPageId });
    const stored = store.projectPages?.[project.id];
    const existingPageId = stored?.notionPageId;
    let page = existingPageId
      ? await notionRequest(store, `/pages/${existingPageId}`).catch(() => undefined)
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

      const stateSync = syncState ? await syncProjectState(store, page.id, project) : undefined;
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
      });
    }
  }

  /** Rebuilds local state from Notion. @param store - Worker state. @param options - Parent selection. @returns Imported state. */
  async function reloadProjectDatabaseFromNotion(
    store: WorkerStore,
    { selectedParentPageId }: ParentSelection = { selectedParentPageId: undefined },
  ) {
    clearSyncMappings(store);
    const requestedParentPageId = selectedParentPageId;
    const database = await ensureProjectDatabase(store, { selectedParentPageId });
    const clearSelectedParentPage = Boolean(
      requestedParentPageId &&
      store.inkwellRootPage?.id &&
      store.inkwellRootPage.id !== requestedParentPageId,
    );
    const rows = await queryManagedProjectRows(store, database.dataSourceId);
    const projects: Project[] = [];
    const pages: ProjectPage[] = [];
    const activePageIdsByProject: Record<string, string> = {};

    for (const row of rows) {
      const project = projectFromNotionPage(row);

      if (!project || project.status === 'archived') {
        continue;
      }

      storeProjectPage(store, database, project, row);
      const children = await listAllBlockChildren(store, row.id).catch(() => []);
      const stateBlock = children.find(
        (block) =>
          block.type === 'toggle' && !block.archived && toggleTitle(block) === 'Project State',
      );
      const threadBlocks = children.filter(
        (block) =>
          block.type === 'toggle' && !block.archived && toggleTitle(block) !== 'Project State',
      );
      const importedProject = stateBlock
        ? await importProjectState(store, row, project, stateBlock)
        : project;

      projects.push(importedProject);

      for (const threadBlock of threadBlocks) {
        const page = await pageFromThreadBlock(store, importedProject, row, threadBlock);
        pages.push(page);
        activePageIdsByProject[importedProject.id] ??= page.id;
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

  return {
    archiveThreadToggle,
    ensureProjectDatabase,
    ensureProjectPage,
    ensureProjectStateContainer,
    ensureThreadToggle,
    importThreadContent,
    reloadProjectDatabaseFromNotion,
    projectStateKey,
    threadKey,
    updateThreadToggleTitle,
  };
}
