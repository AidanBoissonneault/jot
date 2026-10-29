/**
 * @file Queries managed project rows and maps Notion rows to Jottathing state.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Project } from '../../../src/types/capture.js';
import {
  dateProperty,
  emptyDocument,
  isArchivedObject,
  PROJECT_PROPERTIES,
  projectProperties,
  richTextProperty,
  selectProperty,
  titleFromPage,
} from './projectDatabaseValues.js';
import type {
  JottathingDatabase,
  JsonObject,
  NotionObject,
  NotionRequester,
  WorkerStore,
} from './types.js';
import { notionQueryPages } from './workerUtils.js';

/** Clears derived database mappings, optionally retaining stable note block identities. */
export function clearSyncMappings(
  store: WorkerStore,
  { preserveBlockMappings = false }: { preserveBlockMappings?: boolean } = {},
): void {
  store.projectPages = {};
  store.projectBlocks = {};
  store.threadBlocks = {};
  store.notePages = {};
  if (!preserveBlockMappings) store.blockMappings = {};
}

/** Marks an unusable database and clears its derived local mappings. */
export function invalidateProjectDatabase(store: WorkerStore, databaseId: string): void {
  store.ignoredJottathingDatabaseIds ??= new Set();
  if (databaseId) store.ignoredJottathingDatabaseIds.add(databaseId);
  store.jottathingDatabase = undefined;
  clearSyncMappings(store);
}

/** Converts a managed Notion database row into an Jottathing project. */
export function projectFromNotionPage(page: NotionObject): Project | undefined {
  const properties = page.properties ?? {};
  const id = richTextProperty(properties[PROJECT_PROPERTIES.jottathingId]).trim();
  if (!id) return undefined;

  const createdAt =
    dateProperty(properties[PROJECT_PROPERTIES.created]) ??
    page.created_time ??
    page.last_edited_time ??
    new Date().toISOString();
  const updatedAt =
    dateProperty(properties[PROJECT_PROPERTIES.updated]) ?? page.last_edited_time ?? createdAt;
  const category = selectProperty(properties[PROJECT_PROPERTIES.category]);
  const status =
    selectProperty(properties[PROJECT_PROPERTIES.status]) === 'Archived' ? 'archived' : 'active';

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

/** Reads the managed marker from the current project schema. */
function isManagedProjectRow(page: NotionObject): boolean {
  return page.properties?.[PROJECT_PROPERTIES.managed]?.checkbox === true;
}

/** Stores the current Notion row identity for a synchronized project. */
export function storeProjectPage(
  store: WorkerStore,
  database: JottathingDatabase,
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

/** Creates query and mutation operations for project database rows. */
export function createProjectDatabaseRows(notionRequest: NotionRequester) {
  async function projectPropertyValues(
    store: WorkerStore,
    dataSourceId: string,
    project: Project,
  ): Promise<JsonObject> {
    const dataSource = await notionRequest(store, `/data_sources/${dataSourceId}`);
    const statusProperty = dataSource.properties?.[PROJECT_PROPERTIES.status];
    const statusType = typeof statusProperty?.type === 'string'
      ? statusProperty.type
      : undefined;
    return projectProperties(project, statusType);
  }

  async function queryManagedProjectRows(
    store: WorkerStore,
    dataSourceId: string,
  ): Promise<NotionObject[]> {
    const results: NotionObject[] = [];
    // Adopted databases can have different property types; filter locally.
    for await (const rows of notionQueryPages<NotionObject>(
      notionRequest,
      store,
      `/data_sources/${dataSourceId}/query`,
      { page_size: 100 },
      {
        invalidResults: 'Notion returned an invalid managed-project page.',
        incompleteResults: 'Notion returned an incomplete managed-project list.',
      },
    )) {
      results.push(...rows.filter((row) =>
        isManagedProjectRow(row) && !isArchivedObject(row),
      ));
    }
    return results;
  }

  async function findProjectPageByJottathingId(
    store: WorkerStore,
    dataSourceId: string,
    projectId: string,
  ): Promise<NotionObject | undefined> {
    const dataSource = await notionRequest(store, `/data_sources/${dataSourceId}`);
    const properties = dataSource.properties ?? {};
    const idProperty = PROJECT_PROPERTIES.jottathingId;

    if (properties[idProperty]?.type === 'rich_text') {
      // Several archived rows can share an ID after recreation. Page until an
      // active row is found or the filtered result is exhausted.
      for await (const rows of notionQueryPages<NotionObject>(
        notionRequest,
        store,
        `/data_sources/${dataSourceId}/query`,
        {
          page_size: 100,
          filter: { property: idProperty, rich_text: { equals: projectId } },
        },
        {
          invalidResults: 'Notion returned an invalid project lookup result.',
          incompleteResults: 'Notion returned an incomplete project lookup result.',
        },
      )) {
        const activeRow = rows.find((row) => !isArchivedObject(row));
        if (activeRow) return activeRow;
      }
      return undefined;
    }

    // Adopted legacy databases may have had their ID field removed or changed
    // to a different type. In that case, scan safely rather than sending a
    // rich_text filter that Notion rejects with HTTP 400.
    for await (const rows of notionQueryPages<NotionObject>(
      notionRequest,
      store,
      `/data_sources/${dataSourceId}/query`,
      { page_size: 100 },
      {
        invalidResults: 'Notion returned an invalid project lookup result.',
        incompleteResults: 'Notion returned an incomplete project lookup result.',
      },
    )) {
      const match = rows.find((row) => {
        if (isArchivedObject(row)) return false;
        const rowProperties = row.properties ?? {};
        return richTextProperty(rowProperties[PROJECT_PROPERTIES.jottathingId]).trim() === projectId;
      });
      if (match) return match;
    }
    return undefined;
  }

  async function createProjectDatabasePage(
    store: WorkerStore,
    dataSourceId: string,
    project: Project,
  ): Promise<NotionObject> {
    const properties = await projectPropertyValues(store, dataSourceId, project);
    return notionRequest(store, '/pages', {
      method: 'POST',
      body: {
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties,
      },
    });
  }

  async function updateProjectDatabasePage(
    store: WorkerStore,
    pageId: string,
    dataSourceId: string,
    project: Project,
  ): Promise<NotionObject> {
    const properties = await projectPropertyValues(store, dataSourceId, project);
    const body: JsonObject = { properties };
    if (project.status === 'archived') body.in_trash = true;
    return notionRequest(store, `/pages/${pageId}`, { method: 'PATCH', body });
  }

  return {
    queryManagedProjectRows,
    findProjectPageByJottathingId,
    createProjectDatabasePage,
    updateProjectDatabasePage,
  };
}
