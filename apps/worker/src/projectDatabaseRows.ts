/**
 * @file Queries managed project rows and maps Notion rows to Inkwell state.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Project } from '../../../src/types/capture.js';
import {
  dateProperty,
  emptyDocument,
  PROJECT_PROPERTIES,
  projectProperties,
  richTextProperty,
  selectProperty,
  titleFromPage,
} from './projectDatabaseValues.js';
import type {
  InkwellDatabase,
  JsonObject,
  NotionObject,
  NotionRequester,
  WorkerStore,
} from './types.js';

/** Clears mappings that point into a project database. */
export function clearSyncMappings(store: WorkerStore): void {
  store.projectPages = {};
  store.projectBlocks = {};
  store.threadBlocks = {};
  store.notePages = {};
  store.blockMappings = {};
}

/** Marks an unusable database and clears its derived local mappings. */
export function invalidateProjectDatabase(store: WorkerStore, databaseId: string): void {
  store.ignoredInkwellDatabaseIds ??= new Set();
  if (databaseId) store.ignoredInkwellDatabaseIds.add(databaseId);
  store.inkwellDatabase = undefined;
  clearSyncMappings(store);
}

/** Converts a managed Notion database row into an Inkwell project. */
export function projectFromNotionPage(page: NotionObject): Project | undefined {
  const properties = page.properties ?? {};
  const id = richTextProperty(properties[PROJECT_PROPERTIES.inkwellId]).trim();
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

/** Stores the current Notion row identity for a synchronized project. */
export function storeProjectPage(
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

/** Creates query and mutation operations for project database rows. */
export function createProjectDatabaseRows(notionRequest: NotionRequester) {
  async function queryManagedProjectRows(
    store: WorkerStore,
    dataSourceId: string,
  ): Promise<NotionObject[]> {
    const results: NotionObject[] = [];
    let cursor: string | undefined;
    do {
      const body: JsonObject = {
        page_size: 100,
        filter: {
          and: [
            { property: PROJECT_PROPERTIES.managed, checkbox: { equals: true } },
            { property: PROJECT_PROPERTIES.status, select: { does_not_equal: 'Archived' } },
          ],
        },
        sorts: [{ property: PROJECT_PROPERTIES.updated, direction: 'descending' }],
      };
      if (cursor) body.start_cursor = cursor;
      const response = await notionRequest(store, `/data_sources/${dataSourceId}/query`, {
        method: 'POST',
        body,
      });
      results.push(...(response.results ?? []));
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return results;
  }

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

  async function createProjectDatabasePage(
    store: WorkerStore,
    dataSourceId: string,
    project: Project,
  ): Promise<NotionObject> {
    return notionRequest(store, '/pages', {
      method: 'POST',
      body: {
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties: projectProperties(project),
      },
    });
  }

  async function updateProjectDatabasePage(
    store: WorkerStore,
    pageId: string,
    project: Project,
  ): Promise<NotionObject> {
    const body: JsonObject = { properties: projectProperties(project) };
    if (project.status === 'archived') body.archived = true;
    return notionRequest(store, `/pages/${pageId}`, { method: 'PATCH', body });
  }

  return {
    queryManagedProjectRows,
    findProjectPageByInkwellId,
    createProjectDatabasePage,
    updateProjectDatabasePage,
  };
}
