/**
 * @file Discovers, creates, and upgrades the managed Notion project database.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */
import {
  JOTTATHING_DATABASE_TITLE,
  JOTTATHING_PROJECTS_DATA_SOURCE_TITLE,
  PROJECT_PROPERTIES,
  activeProjectsView,
  allProjectsView,
  byCategoryView,
  databaseParent,
  databaseSummary,
  firstDataSourceId,
  isArchivedObject,
  isBlockNotPageError,
  parentPageIdFromObject,
  projectSchema,
  propertyIdMap,
  richText,
  richTextProperty,
  titleFromDatabase,
  titleFromPage,
} from './projectDatabaseValues.js';
import type {
  JottathingDatabase,
  JsonObject,
  NotionObject,
  NotionRequester,
  WorkerStore,
} from './types.js';
import { isNotionPageIdValidationError, notionQueryPages } from './workerUtils.js';

/** Parent selection passed to database discovery. */
interface ParentSelection {
  selectedParentPageId: string | undefined;
  /** Avoid schema and view checks for read paths that only need the stored database. */
  readOnly?: boolean;
}

/** Filters used to find a database under an optional parent. */
interface DatabaseSearchOptions {
  ignoredDatabaseIds: Set<string>;
  parentPageId: string | undefined;
}

/** Discovery candidate metrics used to choose the canonical database. */
interface DatabaseCandidate {
  dataSourceId: string;
  database: NotionObject;
  managedProjects: number;
  mappedProjects: number;
}

/** Dependencies for database discovery and schema maintenance. */
interface ProjectDatabaseDiscoveryDependencies {
  appendLog: (store: WorkerStore, event: string, message: string) => void;
  createWorkspacePage: (store: WorkerStore, title: string) => Promise<NotionObject>;
  isNotionObjectNotFound: (error: unknown) => boolean;
  notionRequest: NotionRequester;
}

/** Creates database discovery, creation, parent, schema, and view operations. */
export function createProjectDatabaseDiscoveryHelpers({
  appendLog,
  createWorkspacePage,
  isNotionObjectNotFound,
  notionRequest,
}: ProjectDatabaseDiscoveryDependencies) {
  /** Ensures the managed project database exists. @param store - Worker state. @param options - Parent selection. @returns Active database. */
  async function ensureProjectDatabase(
    store: WorkerStore,
    { selectedParentPageId, readOnly = false }: ParentSelection = { selectedParentPageId: undefined },
  ): Promise<JottathingDatabase> {
    store.projectPages ??= {};
    store.projectBlocks ??= {};
    store.threadBlocks ??= {};
    store.blockMappings ??= {};
    const ignoredDatabaseIds = store.ignoredJottathingDatabaseIds ?? new Set();
    const cached = await refreshStoredDatabase(store, selectedParentPageId, readOnly, ignoredDatabaseIds);
    if (cached) return cached;

    // An explicit parent selection is authoritative while it resolves. Do not
    // query a cached database under a different valid parent, because that can
    // make the app read a different project inventory indefinitely.
    if (selectedParentPageId) {
      store.jottathingDatabase = undefined;
    }

    const parentPage = selectedParentPageId
      ? await ensureDatabaseParentPage(store, selectedParentPageId)
      : undefined;

    const found = await findDatabaseForParentSelection(
      store,
      selectedParentPageId,
      parentPage,
      ignoredDatabaseIds,
    );
    if (found) return adoptDatabase(store, found);

    const created = await createProjectDatabaseWithFallback(store, parentPage?.id, {
      ignoredDatabaseIds,
    });
    store.jottathingDatabase = created;
    await ensureProjectViews(store, created);
    appendLog(store, 'project_database_created', created.title);
    return created;
  }

  /** Refreshes a stored database when it still matches the selected parent. */
  async function refreshStoredDatabase(
    store: WorkerStore,
    selectedParentPageId: string | undefined,
    readOnly: boolean,
    ignoredDatabaseIds: Set<string>,
  ): Promise<JottathingDatabase | undefined> {
    const stored = store.jottathingDatabase;
    if (
      !stored?.databaseId ||
      !stored.dataSourceId ||
      ignoredDatabaseIds.has(stored.databaseId) ||
      (selectedParentPageId && stored.parentPageId !== selectedParentPageId)
    ) return undefined;

    const refreshed = await refreshDatabase(store, stored, readOnly);
    return refreshed && (!selectedParentPageId || refreshed.parentPageId === selectedParentPageId)
      ? refreshed
      : undefined;
  }

  /** Finds an existing database without letting a valid parent selection drift. */
  async function findDatabaseForParentSelection(
    store: WorkerStore,
    selectedParentPageId: string | undefined,
    parentPage: { id: string } | undefined,
    ignoredDatabaseIds: Set<string>,
  ): Promise<JottathingDatabase | undefined> {
    // A stale selection must not hide an accessible database and create a duplicate.
    if (!selectedParentPageId || !parentPage) {
      const accessible = await findExistingDatabase(store, { ignoredDatabaseIds });
      if (accessible) return accessible;
    }

    return parentPage
      ? findExistingDatabase(store, { parentPageId: parentPage.id, ignoredDatabaseIds })
      : undefined;
  }

  /** Stores an adopted database and ensures its current schema and views. */
  async function adoptDatabase(
    store: WorkerStore,
    database: JottathingDatabase,
  ): Promise<JottathingDatabase> {
    store.jottathingDatabase = database;
    await ensureProjectSchema(store, database.dataSourceId);
    await ensureProjectViews(store, database);
    appendLog(store, 'project_database_adopted', database.title);
    return database;
  }

  /** Resolves or creates the database parent. @param store - Worker state. @param selectedParentPageId - Selected parent. @returns Parent summary. */
  async function ensureDatabaseParentPage(
    store: WorkerStore,
    selectedParentPageId: string | undefined = undefined,
  ) {
    if (selectedParentPageId) {
      try {
        const page = await notionRequest(store, `/pages/${selectedParentPageId}`);
        store.jottathingRootPage = {
          id: page.id,
          parentPageId: undefined,
          title: titleFromPage(page) || JOTTATHING_DATABASE_TITLE,
          url: page.url,
        };
        return store.jottathingRootPage;
      } catch (error) {
        if (
          !isNotionObjectNotFound(error) &&
          !isBlockNotPageError(error) &&
          !isNotionPageIdValidationError(error)
        ) {
          throw error;
        }
        appendLog(
          store,
          'database_parent_inaccessible',
          `${selectedParentPageId}: ${errorMessage(error)}`,
        );
      }

      return undefined;
    }

    if (store.jottathingRootPage?.id) {
      try {
        const page = await notionRequest(store, `/pages/${store.jottathingRootPage.id}`);
        store.jottathingRootPage = {
          id: page.id,
          parentPageId: undefined,
          title: titleFromPage(page) || store.jottathingRootPage.title || JOTTATHING_DATABASE_TITLE,
          url: page.url,
        };
        return store.jottathingRootPage;
      } catch {
        // Recreate below.
      }
    }

    const page = await createWorkspacePage(store, JOTTATHING_DATABASE_TITLE);
    store.jottathingRootPage = {
      id: page.id,
      parentPageId: undefined,
      title: titleFromPage(page) || JOTTATHING_DATABASE_TITLE,
      url: page.url,
    };
    appendLog(store, 'database_parent_created', store.jottathingRootPage.title);
    return store.jottathingRootPage;
  }

  /** Refreshes a stored database. @param store - Worker state. @param stored - Stored summary. @returns Refreshed summary. */
  async function refreshDatabase(
    store: WorkerStore,
    stored: JottathingDatabase,
    readOnly = false,
  ): Promise<JottathingDatabase | undefined> {
    try {
      const database = await notionRequest(store, `/databases/${stored.databaseId}`);

      if (isArchivedObject(database)) {
        return undefined;
      }

      const dataSourceId = stored.dataSourceId ?? firstDataSourceId(database);

      if (!dataSourceId) {
        return undefined;
      }

      const refreshed = databaseSummary(
        database,
        dataSourceId,
        parentPageIdFromObject(database) ?? stored.parentPageId,
      );
      store.jottathingDatabase = refreshed;
      if (!readOnly) {
        await ensureProjectSchema(store, dataSourceId);
        await ensureProjectViews(store, refreshed);
      }
      return refreshed;
    } catch (error) {
      appendLog(store, 'project_database_lookup_error', errorMessage(error));

      // A missing/removed database is recoverable by discovery. Rate limits,
      // network errors, and other transient failures are not evidence that the
      // saved database is wrong; abandoning it can silently select or create a
      // different Jottathing database.
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
  ): Promise<JottathingDatabase | undefined> {
    const dataSources = await searchProjectDataSources(store);
    const candidates: DatabaseCandidate[] = [];
    const databaseIds = new Set<string>();
    for (const dataSource of dataSources) {
      const candidate = await databaseCandidateForDataSource(
        store,
        dataSource,
        parentPageId,
        ignoredDatabaseIds,
        databaseIds,
      );
      if (candidate) candidates.push(candidate);
    }

    candidates.sort(compareDatabaseCandidates);
    const selected = candidates[0];

    if (!selected) return undefined;

    const database = selected.database;
    return databaseSummary(
      database,
      selected.dataSourceId,
      parentPageId ?? parentPageIdFromObject(database),
    );
  }

  /** Searches current data source and database titles, following every result page. */
  async function searchProjectDataSources(store: WorkerStore): Promise<NotionObject[]> {
    const dataSources: NotionObject[] = [];
    const seenDataSourceIds = new Set<string>();
    // Current Notion search results are data sources; title both current names.
    for (const query of [JOTTATHING_PROJECTS_DATA_SOURCE_TITLE, JOTTATHING_DATABASE_TITLE]) {
      for await (const page of notionQueryPages<NotionObject>(
        notionRequest,
        store,
        '/search',
        { query, page_size: 100, filter: { property: 'object', value: 'data_source' } },
        {
          invalidResults: 'Notion returned an invalid data source search result.',
          incompleteResults: 'Notion returned an incomplete database search result.',
        },
      )) {
        for (const dataSource of page) {
          if (seenDataSourceIds.has(dataSource.id)) continue;
          seenDataSourceIds.add(dataSource.id);
          dataSources.push(dataSource);
        }
      }
    }
    return dataSources;
  }

  /** Loads a parent database and counts it only when its current Jottathing identity matches. */
  async function databaseCandidateForDataSource(
    store: WorkerStore,
    dataSource: NotionObject,
    parentPageId: string | undefined,
    ignoredDatabaseIds: Set<string>,
    seenDatabaseIds: Set<string>,
  ): Promise<DatabaseCandidate | undefined> {
    const databaseId = dataSource.parent?.database_id;
    if (!databaseId || ignoredDatabaseIds.has(databaseId) || seenDatabaseIds.has(databaseId)) {
      return undefined;
    }
    seenDatabaseIds.add(databaseId);

    // A search hit is only a data source. Resolve its parent to verify title and scope.
    const database = await notionRequest(store, `/databases/${databaseId}`);
    const dataSourceId = dataSource.id ?? firstDataSourceId(database);
    if (
      isArchivedObject(database) ||
      titleFromDatabase(database) !== JOTTATHING_DATABASE_TITLE ||
      (parentPageId !== undefined && parentPageIdFromObject(database) !== parentPageId) ||
      !dataSourceId
    ) {
      return undefined;
    }

    return {
      database,
      dataSourceId,
      mappedProjects: mappedProjectCount(store, databaseId),
      managedProjects: await managedProjectCount(store, dataSourceId),
    };
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
    try {
      const schema = await notionRequest(store, `/data_sources/${dataSourceId}`);
      const properties = schema.properties ?? {};
      const managedProperty = PROJECT_PROPERTIES.managed;
      const managedPropertySchema = properties[managedProperty];
      if (!managedPropertySchema) return -1;
      const managedPropertyType = typeof managedPropertySchema.type === 'string'
        ? managedPropertySchema.type
        : undefined;
      const query: JsonObject = { page_size: 100 };
      // Only filter by checkbox when the adopted schema supports it.
      if (managedPropertyType === 'checkbox') {
        query.filter = {
          property: managedProperty,
          checkbox: { equals: true },
        };
      }
      for await (const rows of notionQueryPages<NotionObject>(
        notionRequest,
        store,
        `/data_sources/${dataSourceId}/query`,
        query,
        {
          invalidResults: 'Notion returned an invalid managed-project count result.',
          incompleteResults: 'Notion returned an incomplete managed-project count.',
        },
      )) {
        count += managedPropertyType === 'checkbox'
          ? rows.length
          : rows.filter((page) => checkboxValue(page.properties?.[managedProperty])).length;
      }

      return count;
    } catch (error) {
      // A same-named, non-Jottathing database will not have the managed property.
      // Other failures may be transient, so abort discovery instead of making a
      // guess that could split data across databases.
      if (
        errorCode(error) === 'validation_error' &&
        /managed by jottathing|property/i.test(errorMessage(error))
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

    const editedDifference =
      Date.parse(second.database.last_edited_time ?? '') -
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
    {
      ignoredDatabaseIds = new Set<string>(),
    }: Partial<Pick<DatabaseSearchOptions, 'ignoredDatabaseIds'>> = {},
  ): Promise<JottathingDatabase> {
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
        throw new Error('Unable to create a parent page for the Jottathing database.');
      }
      return createProjectDatabase(store, parentPage.id);
    }
  }

  /** Creates the managed project database. @param store - Worker state. @param parentPageId - Parent page. @returns Database summary. */
  async function createProjectDatabase(
    store: WorkerStore,
    parentPageId: string | undefined = undefined,
  ): Promise<JottathingDatabase> {
    const database = await notionRequest(store, '/databases', {
      method: 'POST',
      body: {
        parent: databaseParent(parentPageId),
        title: richText(JOTTATHING_DATABASE_TITLE),
        is_inline: false,
        initial_data_source: {
          title: richText(JOTTATHING_PROJECTS_DATA_SOURCE_TITLE),
          properties: projectSchema(),
        },
      },
    });
    const fullDatabase = await notionRequest(store, `/databases/${database.id}`).catch(
      () => database,
    );
    const dataSourceId = firstDataSourceId(fullDatabase) ?? firstDataSourceId(database);

    if (!dataSourceId) {
      throw new Error('Notion did not return a data source for the Jottathing database.');
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

  /** Creates and updates managed views. @param store - Worker state. @param database - Database summary. @returns Completion promise. */
  async function ensureProjectViews(store: WorkerStore, database: JottathingDatabase): Promise<void> {
    const existing = await listViews(store, database.databaseId);
    const dataSource = await notionRequest(store, `/data_sources/${database.dataSourceId}`).catch(
      () => undefined,
    );
    const propertyIds = propertyIdMap(dataSource?.properties ?? {});
    const views = [
      activeProjectsView(propertyIds),
      byCategoryView(propertyIds),
      allProjectsView(propertyIds),
    ];

    for (const view of views) {
      const viewName = stringProperty(view, 'name') ?? 'Unnamed view';
      const existingView = existing.find((candidate) => stringProperty(candidate, 'name') === viewName);
      if (existingView) {
        const viewId = stringProperty(existingView, 'id');
        if (viewId && needsPageFirstViewUpdate(existingView, view, propertyIds[PROJECT_PROPERTIES.title])) {
          await notionRequest(store, `/views/${viewId}`, {
            method: 'PATCH',
            body: { configuration: view.configuration },
          }).catch((error) => {
            appendLog(store, 'project_view_update_error', `${viewName}: ${errorMessage(error)}`);
            return undefined;
          });
        }
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
        store.jottathingDatabase = database;
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
      cursor = response?.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return results;
  }

  return { ensureProjectDatabase };
}

/** Checks whether a managed view keeps the project page visible in the first column. */
function needsPageFirstViewUpdate(
  existingView: NotionObject,
  desiredView: JsonObject,
  titlePropertyId: string | undefined,
): boolean {
  if (!titlePropertyId) return false;
  const currentConfiguration = objectProperty(existingView, 'configuration');
  const desiredConfiguration = objectProperty(desiredView, 'configuration');
  const currentProperties = Array.isArray(currentConfiguration?.properties)
    ? currentConfiguration.properties.filter(isJsonObject)
    : [];
  const firstVisibleProperty = currentProperties.find((property) => property.visible !== false);
  const pageIsFirst = firstVisibleProperty?.property_id === titlePropertyId;
  const needsFrozenTitle =
    desiredConfiguration?.type === 'table' && currentConfiguration?.frozen_column_index !== 1;

  return !pageIsFirst || needsFrozenTitle;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return stringProperty(error, 'code');
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property: unknown = (value as JsonObject)[key];
  return typeof property === 'string' ? property : undefined;
}

function checkboxValue(property: JsonObject | undefined): boolean {
  return property?.checkbox === true;
}

function objectProperty(value: unknown, key: string): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property: unknown = (value as JsonObject)[key];
  return isJsonObject(property) ? property : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
