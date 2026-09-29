/**
 * @file Discovers, creates, and upgrades the managed Notion project database.
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
  firstDataSourceId,
  isArchivedObject,
  isBlockNotPageError,
  parentPageIdFromObject,
  projectSchema,
  propertyIdMap,
  richText,
  titleFromDatabase,
  titleFromPage,
} from './projectDatabaseValues.js';
import type {
  InkwellDatabase,
  JsonObject,
  NotionObject,
  NotionRequester,
  WorkerStore,
} from './types.js';

/** Parent selection passed to database discovery. */
interface ParentSelection {
  selectedParentPageId: string | undefined;
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
        appendLog(
          store,
          'database_parent_inaccessible',
          `${selectedParentPageId}: ${errorMessage(error)}`,
        );
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
    const fullDatabase = await notionRequest(store, `/databases/${database.id}`).catch(
      () => database,
    );
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
    const existingNames = new Set(
      existing.map((view) => stringProperty(view, 'name')).filter(isString),
    );
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
      cursor = response?.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return results;
  }

  return { ensureProjectDatabase };
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

function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}
