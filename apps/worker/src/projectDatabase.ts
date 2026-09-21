/**
 * @file Coordinates creation, discovery, import, and synchronization of the Notion project database.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import {
  INKWELL_DATABASE_TITLE,
  PROJECT_PROPERTIES,
  activeProjectsView,
  allProjectsView,
  byCategoryView,
  databaseParent,
  databaseSummary,
  dateProperty,
  emptyDocument,
  firstDataSourceId,
  isArchivedAncestorError,
  isArchivedObject,
  isBlockNotPageError,
  pageSummaryFromNotionPage,
  parentPageIdFromObject,
  projectProperties,
  projectSchema,
  projectStateKey,
  propertyIdMap,
  richText,
  richTextProperty,
  selectProperty,
  threadKey,
  titleFromDatabase,
  titleFromPage,
  toggleBlock,
  toggleTitle,
} from './projectDatabaseValues.js';

export { projectStateKey, threadKey } from './projectDatabaseValues.js';

import type { DocumentContent, Project, ProjectPage } from '../../../src/types/capture.js';
import type {
  AppendLog,
  HashValue,
  InkwellDatabase,
  JsonObject,
  ListAllBlockChildren,
  NotionBlock,
  NotionBlockPayload,
  NotionObject,
  NotionRequester,
  ReplaceManagedBlocks,
  StoredBlock,
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
  hash: HashValue;
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

/** Describes the database search options contract used by this API feature. */
interface DatabaseSearchOptions {
  ignoredDatabaseIds: Set<string>;
  parentPageId: string | undefined;
}

/** Describes the ensure project page options contract used by this API feature. */
interface EnsureProjectPageOptions extends ParentSelection {
  retryOnArchivedAncestor: boolean;
  syncState: boolean;
}

/** Describes the database candidate contract used by this API feature. */
interface DatabaseCandidate {
  dataSourceId: string;
  database: NotionObject;
  managedProjects: number;
  mappedProjects: number;
}

/** Describes the project page result contract used by this API feature. */
interface ProjectPageResult {
  id: string;
  parentPageId?: string;
  project: Project;
  title: string;
  url?: string;
}

/** Describes the toggle options contract used by this API feature. */
interface ToggleOptions {
  key: string;
  mappings: Record<string, StoredBlock>;
}

/**
 * Creates project-database operations bound to Notion and persistence dependencies.
 * @param dependencies - Notion transport, conversion, logging, and mapping dependencies.
 * @returns Operations for project databases, rows, state blocks, and thread toggles.
 */

export function createProjectDatabaseHelpers({
  appendLog,
  createWorkspacePage,
  hash,
  isNotionObjectNotFound,
  listAllBlockChildren,
  notionBlocksToTiptapDocument,
  notionRequest,
  replaceManagedBlocks,
  tiptapDocumentToNotionBlocks,
}: ProjectDatabaseDependencies) {
  /** Ensures the managed project database exists. @param store - Worker state. @param options - Parent selection. @returns Active database. */
  async function ensureProjectDatabase(
    store: WorkerStore,
    { selectedParentPageId }: ParentSelection = { selectedParentPageId: undefined },
  ): Promise<InkwellDatabase> {
    store.projectPages ??= {};
    store.projectBlocks ??= {};
    store.threadBlocks ??= {};
    store.blockMappings ??= {};
    const ignoredDatabaseIds = store.ignoredInkwellDatabaseIds ?? new Set();
    const stored = store.inkwellDatabase;

    if (stored?.databaseId && stored?.dataSourceId && !ignoredDatabaseIds.has(stored.databaseId)) {
      const existing = await refreshDatabase(store, stored);

      if (existing) {
        return existing;
      }
    }

    if (!selectedParentPageId) {
      const foundAccessible = await findExistingDatabase(store, { ignoredDatabaseIds });

      if (foundAccessible) {
        store.inkwellDatabase = foundAccessible;
        await ensureProjectSchema(store, foundAccessible.dataSourceId);
        await ensureProjectViews(store, foundAccessible);
        appendLog(store, 'project_database_adopted', foundAccessible.title);
        return foundAccessible;
      }
    }

    const parentPage = selectedParentPageId
      ? await ensureDatabaseParentPage(store, selectedParentPageId)
      : undefined;
    const found = parentPage
      ? await findExistingDatabase(store, { parentPageId: parentPage.id, ignoredDatabaseIds })
      : undefined;

    if (found) {
      store.inkwellDatabase = found;
      await ensureProjectSchema(store, found.dataSourceId);
      await ensureProjectViews(store, found);
      appendLog(store, 'project_database_adopted', found.title);
      return found;
    }

    const created = await createProjectDatabaseWithFallback(store, parentPage?.id, {
      ignoredDatabaseIds,
    });
    store.inkwellDatabase = created;
    await ensureProjectViews(store, created);
    appendLog(store, 'project_database_created', created.title);
    return created;
  }

  /** Resolves or creates the database parent. @param store - Worker state. @param selectedParentPageId - Selected parent. @returns Parent summary. */
  async function ensureDatabaseParentPage(
    store: WorkerStore,
    selectedParentPageId: string | undefined = undefined,
  ) {
    if (selectedParentPageId) {
      try {
        const page = await notionRequest(store, `/pages/${selectedParentPageId}`);
        store.inkwellRootPage = {
          id: page.id,
          parentPageId: undefined,
          title: titleFromPage(page) || INKWELL_DATABASE_TITLE,
          url: page.url,
        };
        return store.inkwellRootPage;
      } catch (error) {
        if (!isNotionObjectNotFound(error) && !isBlockNotPageError(error)) {
          throw error;
        }
        appendLog(store, 'database_parent_inaccessible', `${selectedParentPageId}: ${errorMessage(error)}`);
      }

      return undefined;
    }

    if (store.inkwellRootPage?.id) {
      try {
        const page = await notionRequest(store, `/pages/${store.inkwellRootPage.id}`);
        store.inkwellRootPage = {
          id: page.id,
          parentPageId: undefined,
          title: titleFromPage(page) || store.inkwellRootPage.title || INKWELL_DATABASE_TITLE,
          url: page.url,
        };
        return store.inkwellRootPage;
      } catch {
        // Recreate below.
      }
    }

    const page = await createWorkspacePage(store, INKWELL_DATABASE_TITLE);
    store.inkwellRootPage = {
      id: page.id,
      parentPageId: undefined,
      title: titleFromPage(page) || INKWELL_DATABASE_TITLE,
      url: page.url,
    };
    appendLog(store, 'database_parent_created', store.inkwellRootPage.title);
    return store.inkwellRootPage;
  }

  /** Refreshes a stored database. @param store - Worker state. @param stored - Stored summary. @returns Refreshed summary. */
  async function refreshDatabase(
    store: WorkerStore,
    stored: InkwellDatabase,
  ): Promise<InkwellDatabase | undefined> {
    try {
      const database = await notionRequest(store, `/databases/${stored.databaseId}`);

      if (isArchivedObject(database)) {
        return undefined;
      }

      const dataSourceId = stored.dataSourceId ?? firstDataSourceId(database);

      if (!dataSourceId) {
        return undefined;
      }

      const refreshed = databaseSummary(database, dataSourceId, stored.parentPageId);
      store.inkwellDatabase = refreshed;
      await ensureProjectSchema(store, dataSourceId);
      await ensureProjectViews(store, refreshed);
      return refreshed;
    } catch (error) {
      appendLog(store, 'project_database_lookup_error', errorMessage(error));

      // A missing/removed database is recoverable by discovery. Rate limits,
      // network errors, and other transient failures are not evidence that the
      // saved database is wrong; abandoning it can silently select or create a
      // different Inkwell database.
      if (isNotionObjectNotFound(error)) {
        return undefined;
      }

      throw error;
    }
  }

  /** Discovers the best accessible database. @param store - Worker state. @param options - Search filters. @returns Matching database. */
  async function findExistingDatabase(
    store: WorkerStore,
    { parentPageId, ignoredDatabaseIds = new Set<string>() }: Partial<DatabaseSearchOptions> = {},
  ): Promise<InkwellDatabase | undefined> {
    const databases = [];
    let cursor;

    do {
      const body: JsonObject = {
        query: INKWELL_DATABASE_TITLE,
        page_size: 100,
        filter: {
          property: 'object',
          value: 'database',
        },
      };

      if (cursor) {
        body.start_cursor = cursor;
      }

      // Discovery failures must stop the operation. Treating an API failure as
      // an empty result would create a duplicate database and split user data.
      const response = await notionRequest(store, '/search', {
        method: 'POST',
        body,
      });

      databases.push(...(response.results ?? []));
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    const candidates = [];

    for (const database of databases) {
      const dataSourceId = firstDataSourceId(database);

      if (
        !ignoredDatabaseIds.has(database.id) &&
        !isArchivedObject(database) &&
        titleFromDatabase(database) === INKWELL_DATABASE_TITLE &&
        (parentPageId === undefined || parentPageIdFromObject(database) === parentPageId) &&
        dataSourceId
      ) {
        candidates.push({
          database,
          dataSourceId,
          mappedProjects: mappedProjectCount(store, database.id),
          managedProjects: await managedProjectCount(store, dataSourceId),
        });
      }
    }

    candidates.sort(compareDatabaseCandidates);
    const selected = candidates[0];

    return selected
      ? databaseSummary(
          selected.database,
          selected.dataSourceId,
          parentPageId ?? parentPageIdFromObject(selected.database),
        )
      : undefined;
  }

  /** Counts mapped projects. @param store - Worker state. @param databaseId - Database ID. @returns Mapping count. */
  function mappedProjectCount(store: WorkerStore, databaseId: string): number {
    return Object.values(store.projectPages ?? {}).filter(
      (page) => page?.parentPageId === databaseId,
    ).length;
  }

  /** Counts managed project rows. @param store - Worker state. @param dataSourceId - Data source ID. @returns Managed count. */
  async function managedProjectCount(store: WorkerStore, dataSourceId: string): Promise<number> {
    let count = 0;
    let cursor;

    try {
      do {
        const body: JsonObject = {
          page_size: 100,
          filter: {
            property: PROJECT_PROPERTIES.managed,
            checkbox: { equals: true },
          },
        };

        if (cursor) {
          body.start_cursor = cursor;
        }

        const response = await notionRequest(store, `/data_sources/${dataSourceId}/query`, {
          method: 'POST',
          body,
        });
        count += response.results?.length ?? 0;
        cursor = response.has_more ? response.next_cursor : undefined;
      } while (cursor);

      return count;
    } catch (error) {
      // A same-named, non-Inkwell database will not have the managed property.
      // Other failures may be transient, so abort discovery instead of making a
      // guess that could split data across databases.
      if (
        errorCode(error) === 'validation_error' &&
        /managed by inkwell|property/i.test(errorMessage(error))
      ) {
        return -1;
      }

      throw error;
    }
  }

  /** Ranks database candidates. @param first - First candidate. @param second - Second candidate. @returns Sort value. */
  function compareDatabaseCandidates(first: DatabaseCandidate, second: DatabaseCandidate): number {
    if (first.mappedProjects !== second.mappedProjects) {
      return second.mappedProjects - first.mappedProjects;
    }

    if (first.managedProjects !== second.managedProjects) {
      return second.managedProjects - first.managedProjects;
    }

    const editedDifference = Date.parse(second.database.last_edited_time ?? '') -
      Date.parse(first.database.last_edited_time ?? '');

    if (Number.isFinite(editedDifference) && editedDifference !== 0) {
      return editedDifference;
    }

    return String(first.database.id).localeCompare(String(second.database.id));
  }

  /** Creates a database with safe discovery fallback. @param store - Worker state. @param parentPageId - Preferred parent. @param options - Ignored IDs. @returns Database summary. */
  async function createProjectDatabaseWithFallback(
    store: WorkerStore,
    parentPageId: string | undefined,
    { ignoredDatabaseIds = new Set<string>() }: Partial<Pick<DatabaseSearchOptions, 'ignoredDatabaseIds'>> = {},
  ): Promise<InkwellDatabase> {
    if (parentPageId) {
      return createProjectDatabase(store, parentPageId);
    }

    try {
      return await createProjectDatabase(store);
    } catch (error) {
      appendLog(store, 'project_database_workspace_create_error', errorMessage(error));
      const found = await findExistingDatabase(store, { ignoredDatabaseIds });

      if (found) {
        return found;
      }

      const parentPage = await ensureDatabaseParentPage(store);
      if (!parentPage) {
        throw new Error('Unable to create a parent page for the Inkwell database.');
      }
      return createProjectDatabase(store, parentPage.id);
    }
  }

  /** Creates the managed project database. @param store - Worker state. @param parentPageId - Parent page. @returns Database summary. */
  async function createProjectDatabase(
    store: WorkerStore,
    parentPageId: string | undefined = undefined,
  ): Promise<InkwellDatabase> {
    const database = await notionRequest(store, '/databases', {
      method: 'POST',
      body: {
        parent: databaseParent(parentPageId),
        title: richText(INKWELL_DATABASE_TITLE),
        is_inline: false,
        initial_data_source: {
          title: richText('Projects'),
          properties: projectSchema(),
        },
      },
    });
    const fullDatabase = await notionRequest(store, `/databases/${database.id}`).catch(() => database);
    const dataSourceId = firstDataSourceId(fullDatabase) ?? firstDataSourceId(database);

    if (!dataSourceId) {
      throw new Error('Notion did not return a data source for the Inkwell database.');
    }

    return databaseSummary(fullDatabase, dataSourceId, parentPageId);
  }

  /** Adds missing schema fields. @param store - Worker state. @param dataSourceId - Data source ID. @returns Completion promise. */
  async function ensureProjectSchema(store: WorkerStore, dataSourceId: string): Promise<void> {
    const dataSource = await notionRequest(store, `/data_sources/${dataSourceId}`);
    const properties = dataSource.properties ?? {};
    const missing: JsonObject = {};

    for (const [name, schema] of Object.entries(projectSchema())) {
      if (!properties[name]) {
        missing[name] = schema;
      }
    }

    if (Object.keys(missing).length) {
      await notionRequest(store, `/data_sources/${dataSourceId}`, {
        method: 'PATCH',
        body: { properties: missing },
      });
    }
  }

  /** Adds missing managed views. @param store - Worker state. @param database - Database summary. @returns Completion promise. */
  async function ensureProjectViews(store: WorkerStore, database: InkwellDatabase): Promise<void> {
    const existing = await listViews(store, database.databaseId);
    const existingNames = new Set(existing.map((view) => stringProperty(view, 'name')).filter(isString));
    const dataSource = await notionRequest(store, `/data_sources/${database.dataSourceId}`).catch(() => undefined);
    const propertyIds = propertyIdMap(dataSource?.properties ?? {});
    const views = [
      activeProjectsView(propertyIds),
      byCategoryView(propertyIds),
      allProjectsView(propertyIds),
    ];

    for (const view of views) {
      const viewName = stringProperty(view, 'name') ?? 'Unnamed view';
      if (existingNames.has(viewName)) {
        continue;
      }

      const created = await notionRequest(store, '/views', {
        method: 'POST',
        body: {
          database_id: database.databaseId,
          data_source_id: database.dataSourceId,
          ...view,
        },
      }).catch((error) => {
        appendLog(store, 'project_view_create_error', `${viewName}: ${errorMessage(error)}`);
        return undefined;
      });

      if (created?.id) {
        database.views[viewName] = created.id;
        store.inkwellDatabase = database;
      }
    }
  }

  /** Lists database views. @param store - Worker state. @param databaseId - Database ID. @returns Hydrated views. */
  async function listViews(store: WorkerStore, databaseId: string): Promise<NotionObject[]> {
    const results = [];
    let cursor;

    do {
      const search = new URLSearchParams();
      search.set('database_id', databaseId);
      if (cursor) search.set('start_cursor', cursor);

      const response = await notionRequest(store, `/views?${search}`).catch(() => undefined);
      for (const viewRef of response?.results ?? []) {
        if (stringProperty(viewRef, 'name')) {
          results.push(viewRef);
        } else if (viewRef.id) {
          const view = await notionRequest(store, `/views/${viewRef.id}`).catch(() => viewRef);
          results.push(view);
        }
      }
      cursor = response?.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);

    return results;
  }

  /** Ensures a row exists for a project. @param store - Worker state. @param project - Local project. @param options - Sync options. @returns Project page result. */
  async function ensureProjectPage(
    store: WorkerStore,
    project: Project,
    { selectedParentPageId, syncState = true }: Partial<Pick<EnsureProjectPageOptions, 'selectedParentPageId' | 'syncState'>> = {},
  ): Promise<ProjectPageResult> {
    return ensureProjectPageAttempt(store, project, { selectedParentPageId, syncState });
  }

  /** Performs a project-row sync attempt. @param store - Worker state. @param project - Local project. @param options - Retry options. @returns Project page result. */
  async function ensureProjectPageAttempt(
    store: WorkerStore,
    project: Project,
    { selectedParentPageId, retryOnArchivedAncestor = true, syncState = true }: Partial<EnsureProjectPageOptions> = {},
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
      const stateBlock = children.find((block) =>
        block.type === 'toggle' &&
        !block.archived &&
        toggleTitle(block) === 'Project State',
      );
      const threadBlocks = children.filter((block) =>
        block.type === 'toggle' &&
        !block.archived &&
        toggleTitle(block) !== 'Project State',
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

    projects.sort((first, second) =>
      new Date(second.updatedAt).getTime() - new Date(first.updatedAt).getTime(),
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

  /** Clears database-derived mappings. @param store - Worker state. @returns Nothing. */
  function clearSyncMappings(store: WorkerStore): void {
    store.projectPages = {};
    store.projectBlocks = {};
    store.threadBlocks = {};
    store.notePages = {};
    store.blockMappings = {};
  }

  /** Invalidates a failed database. @param store - Worker state. @param databaseId - Database ID. @returns Nothing. */
  function invalidateProjectDatabase(store: WorkerStore, databaseId: string): void {
    store.ignoredInkwellDatabaseIds ??= new Set();
    if (databaseId) {
      store.ignoredInkwellDatabaseIds.add(databaseId);
    }
    store.inkwellDatabase = undefined;
    clearSyncMappings(store);
  }

  /** Queries managed rows. @param store - Worker state. @param dataSourceId - Data source ID. @returns Project pages. */
  async function queryManagedProjectRows(store: WorkerStore, dataSourceId: string): Promise<NotionObject[]> {
    const results = [];
    let cursor;

    do {
      const body: JsonObject = {
        page_size: 100,
        filter: {
          and: [
            {
              property: PROJECT_PROPERTIES.managed,
              checkbox: { equals: true },
            },
            {
              property: PROJECT_PROPERTIES.status,
              select: { does_not_equal: 'Archived' },
            },
          ],
        },
        sorts: [
          {
            property: PROJECT_PROPERTIES.updated,
            direction: 'descending',
          },
        ],
      };

      if (cursor) {
        body.start_cursor = cursor;
      }

      const response = await notionRequest(store, `/data_sources/${dataSourceId}/query`, {
        method: 'POST',
        body,
      });
      results.push(...(response.results ?? []));
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    return results;
  }

  /** Converts a Notion row to a project. @param page - Notion page. @returns Local project. */
  function projectFromNotionPage(page: NotionObject): Project | undefined {
    const properties = page.properties ?? {};
    const id = richTextProperty(properties[PROJECT_PROPERTIES.inkwellId]).trim();

    if (!id) {
      return undefined;
    }

    const createdAt =
      dateProperty(properties[PROJECT_PROPERTIES.created]) ??
      page.created_time ??
      page.last_edited_time ??
      new Date().toISOString();
    const updatedAt =
      dateProperty(properties[PROJECT_PROPERTIES.updated]) ??
      page.last_edited_time ??
      createdAt;
    const category = selectProperty(properties[PROJECT_PROPERTIES.category]);
    const status = selectProperty(properties[PROJECT_PROPERTIES.status]) === 'Archived'
      ? 'archived'
      : 'active';

    return {
      id,
      name: titleFromPage(page),
      status,
      category,
      createdAt,
      updatedAt,
      stateContent: emptyDocument(),
      stateRemoteRevision: undefined,
      tags: category ? [category] : [],
      syncState: 'saved',
    };
  }

  /** Imports project-state content. @param store - Worker state. @param projectPage - Project page. @param project - Local project. @param stateBlock - State toggle. @returns Imported project. */
  async function importProjectState(
    store: WorkerStore,
    projectPage: NotionObject,
    project: Project,
    stateBlock: NotionBlock,
  ): Promise<Project> {
    const blocks = await listAllBlockChildren(store, stateBlock.id).catch(() => []);
    const content = blocks.length ? notionBlocksToTiptapDocument(blocks) : emptyDocument();
    store.projectBlocks[projectStateKey(project.id)] = {
      blockId: stateBlock.id,
      lastEditedTime: stateBlock.last_edited_time,
      parentPageId: projectPage.id,
      title: 'Project State',
    };

    return {
      ...project,
      stateContent: content,
      stateRemoteRevision: stateBlock.last_edited_time,
    };
  }

  /** Imports a thread toggle. @param store - Worker state. @param project - Local project. @param projectPage - Project page. @param threadBlock - Thread toggle. @returns Local page. */
  async function pageFromThreadBlock(
    store: WorkerStore,
    project: Project,
    projectPage: NotionObject,
    threadBlock: NotionBlock,
  ): Promise<ProjectPage> {
    const id = `page-${project.id}-${threadBlock.id}`;
    const title = toggleTitle(threadBlock) || 'Untitled Page';
    const contentBlocks = await listAllBlockChildren(store, threadBlock.id).catch(() => []);
    const content = contentBlocks.length ? notionBlocksToTiptapDocument(contentBlocks) : emptyDocument();
    const timestamp = threadBlock.last_edited_time ?? project.updatedAt;

    store.threadBlocks[threadKey(id)] = {
      blockId: threadBlock.id,
      lastEditedTime: threadBlock.last_edited_time,
      parentPageId: projectPage.id,
      title,
    };
    store.notePages[id] = {
      archived: false,
      dataSourceId: undefined,
      notionPageId: threadBlock.id,
      parentPageId: projectPage.id,
      title,
      lastEditedTime: threadBlock.last_edited_time,
      kind: 'thread',
    };

    return {
      id,
      projectId: project.id,
      kind: 'page',
      title,
      status: 'active',
      content,
      createdAt: timestamp,
      updatedAt: timestamp,
      notionPageId: threadBlock.id,
      notionDatabaseId: undefined,
      notionDataSourceId: undefined,
      notionParentPageId: projectPage.id,
      notionLastEditedTime: threadBlock.last_edited_time,
      remoteRevision: threadBlock.last_edited_time,
      syncState: 'saved',
    };
  }

  /** Finds a row by Inkwell ID. @param store - Worker state. @param dataSourceId - Data source. @param projectId - Project ID. @returns Matching page. */
  async function findProjectPageByInkwellId(
    store: WorkerStore,
    dataSourceId: string,
    projectId: string,
  ): Promise<NotionObject | undefined> {
    const response = await notionRequest(store, `/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body: {
        page_size: 1,
        filter: {
          property: PROJECT_PROPERTIES.inkwellId,
          rich_text: { equals: projectId },
        },
      },
    }).catch(() => ({ results: [] }));

    return response.results?.[0];
  }

  /** Creates a project row. @param store - Worker state. @param dataSourceId - Data source. @param project - Local project. @returns Created page. */
  async function createProjectDatabasePage(
    store: WorkerStore,
    dataSourceId: string,
    project: Project,
  ): Promise<NotionObject> {
    return notionRequest(store, '/pages', {
      method: 'POST',
      body: {
        parent: {
          type: 'data_source_id',
          data_source_id: dataSourceId,
        },
        properties: projectProperties(project),
      },
    });
  }

  /** Updates a project row. @param store - Worker state. @param pageId - Notion page. @param project - Local project. @returns Updated page. */
  async function updateProjectDatabasePage(
    store: WorkerStore,
    pageId: string,
    project: Project,
  ): Promise<NotionObject> {
    const body: JsonObject = {
      properties: projectProperties(project),
    };

    if (project.status === 'archived') {
      body.archived = true;
    }

    return notionRequest(store, `/pages/${pageId}`, {
      method: 'PATCH',
      body,
    });
  }

  /** Reconciles project state. @param store - Worker state. @param notionPageId - Notion page. @param project - Local project. @returns Revision and optional content. */
  async function syncProjectState(store: WorkerStore, notionPageId: string, project: Project) {
    const key = projectStateKey(project.id);
    const previous = store.projectBlocks?.[key];
    const container = await ensureToggleBlock(store, notionPageId, 'Project State', {
      key,
      mappings: store.projectBlocks,
    });
    const hasRemoteEdit =
      previous?.lastEditedTime &&
      container.last_edited_time &&
      container.last_edited_time !== previous.lastEditedTime;

    if (hasRemoteEdit) {
      const blocks = await listAllBlockChildren(store, container.id);
      const content = blocks.length ? notionBlocksToTiptapDocument(blocks) : emptyDocument();
      store.projectBlocks[key] = {
        ...store.projectBlocks[key],
        blockId: container.id,
        lastEditedTime: container.last_edited_time,
        parentPageId: notionPageId,
        title: 'Project State',
      };
      return {
        content,
        lastEditedTime: container.last_edited_time,
      };
    }

    const stateContent = project.stateContent ?? emptyDocument();

    await replaceManagedBlocks(store, key, container.id, stateContent);
    const refreshed = await notionRequest(store, `/blocks/${container.id}`).catch(() => container);
    store.projectBlocks[key] = {
      ...store.projectBlocks[key],
      blockId: container.id,
      lastEditedTime: refreshed.last_edited_time,
      parentPageId: notionPageId,
      title: 'Project State',
    };
    return {
      lastEditedTime: refreshed.last_edited_time,
    };
  }

  /** Ensures the project-state toggle. @param store - Worker state. @param notionPageId - Notion page. @param projectId - Project ID. @returns Toggle block. */
  async function ensureProjectStateContainer(
    store: WorkerStore,
    notionPageId: string,
    projectId: string,
  ): Promise<NotionObject> {
    return ensureToggleBlock(store, notionPageId, 'Project State', {
      key: projectStateKey(projectId),
      mappings: store.projectBlocks,
    });
  }

  /** Ensures a page thread toggle. @param store - Worker state. @param projectPageId - Project page. @param page - Local page. @returns Toggle block. */
  async function ensureThreadToggle(
    store: WorkerStore,
    projectPageId: string,
    page: ProjectPage,
  ): Promise<NotionObject> {
    return ensureToggleBlock(store, projectPageId, page.title || 'Untitled Page', {
      key: threadKey(page.id),
      mappings: store.threadBlocks,
    });
  }

  /** Resolves or creates a toggle. @param store - Worker state. @param parentBlockId - Parent block. @param title - Toggle title. @param options - Mapping options. @returns Toggle block. */
  async function ensureToggleBlock(
    store: WorkerStore,
    parentBlockId: string,
    title: string,
    { key, mappings }: ToggleOptions,
  ): Promise<NotionObject> {
    const stored = mappings?.[key];
    if (stored?.blockId) {
      const block = await notionRequest(store, `/blocks/${stored.blockId}`).catch(() => undefined);

      if (block?.id && !block.archived) {
        if (toggleTitle(block) !== title) {
          await updateToggleTitle(store, block.id, title);
        }
        return { ...block, id: block.id };
      }
    }

    const children = await listAllBlockChildren(store, parentBlockId).catch(() => []);
    const matching = children.find((block) =>
      block.type === 'toggle' &&
      !block.archived &&
      toggleTitle(block) === title,
    );

    if (matching) {
      mappings[key] = {
        blockId: matching.id,
        lastEditedTime: matching.last_edited_time,
        parentPageId: parentBlockId,
        title,
      };
      return matching;
    }

    const response = await notionRequest(store, `/blocks/${parentBlockId}/children`, {
      method: 'PATCH',
      body: {
        children: [toggleBlock(title)],
      },
    });
    const created = response.results?.[0];

    if (!created?.id) {
      throw new Error(`Unable to create Notion toggle for ${title}.`);
    }

    mappings[key] = {
      blockId: created.id,
      lastEditedTime: created.last_edited_time,
      parentPageId: parentBlockId,
      title,
    };
    return created;
  }

  /** Renames a toggle. @param store - Worker state. @param blockId - Toggle ID. @param title - New title. @returns Updated block. */
  async function updateToggleTitle(store: WorkerStore, blockId: string, title: string): Promise<NotionObject> {
    return notionRequest(store, `/blocks/${blockId}`, {
      method: 'PATCH',
      body: {
        toggle: {
          rich_text: richText(title || 'Untitled Page'),
        },
      },
    });
  }

  /** Renames a mapped thread. @param store - Worker state. @param page - Local page. @returns Completion promise. */
  async function updateThreadToggleTitle(store: WorkerStore, page: ProjectPage): Promise<void> {
    const stored = store.threadBlocks?.[threadKey(page.id)];

    if (!stored?.blockId || stored.title === page.title) {
      return;
    }

    await updateToggleTitle(store, stored.blockId, page.title || 'Untitled Page');
    stored.title = page.title || 'Untitled Page';
  }

  /** Archives a mapped thread. @param store - Worker state. @param page - Local page. @returns Completion promise. */
  async function archiveThreadToggle(store: WorkerStore, page: ProjectPage): Promise<void> {
    const stored = store.threadBlocks?.[threadKey(page.id)];

    if (!stored?.blockId) {
      return;
    }

    await notionRequest(store, `/blocks/${stored.blockId}`, {
      method: 'DELETE',
    });
    delete store.threadBlocks[threadKey(page.id)];
    delete store.blockMappings[page.id];
  }

  /** Imports mapped thread content. @param store - Worker state. @param page - Local page. @returns Imported document. */
  async function importThreadContent(
    store: WorkerStore,
    page: ProjectPage,
  ): Promise<DocumentContent | null> {
    const stored = store.threadBlocks?.[threadKey(page.id)];

    if (!stored?.blockId) {
      return null;
    }

    const blocks = await listAllBlockChildren(store, stored.blockId);
    return blocks.length ? notionBlocksToTiptapDocument(blocks) : emptyDocument();
  }

  /** Stores a project-page mapping. @param store - Worker state. @param database - Database summary. @param project - Local project. @param page - Notion page. @returns Nothing. */
  function storeProjectPage(
    store: WorkerStore,
    database: InkwellDatabase,
    project: Project,
    page: NotionObject,
  ): void {
    store.projectPages[project.id] = {
      archived: false,
      kind: undefined,
      notionPageId: page.id,
      parentPageId: database.databaseId,
      dataSourceId: database.dataSourceId,
      title: project.name || titleFromPage(page) || 'Untitled Project',
      lastEditedTime: page.last_edited_time,
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

/**
 * Converts an unknown thrown value to readable text.
 * @param error - Unknown thrown value.
 * @returns Human-readable error text.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a string error code from an unknown thrown value.
 * @param error - Unknown error-like value.
 * @returns String error code or undefined.
 */
function errorCode(error: unknown): string | undefined {
  return stringProperty(error, 'code');
}

/**
 * Reads a string property from an unknown object.
 * @param value - Unknown object-like value.
 * @param key - Property name.
 * @returns String property or undefined.
 */
function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property: unknown = (value as JsonObject)[key];
  return typeof property === 'string' ? property : undefined;
}

/**
 * Narrows a possibly absent value to a string.
 * @param value - Candidate string.
 * @returns Whether the value is a string.
 */
function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}
