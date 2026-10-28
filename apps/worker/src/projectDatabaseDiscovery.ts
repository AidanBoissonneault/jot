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
  const legacyDatabaseTitles = ['Inkwell', 'Jot'];
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
    const stored = store.jottathingDatabase;

    if (
      stored?.databaseId &&
      stored?.dataSourceId &&
      !ignoredDatabaseIds.has(stored.databaseId) &&
      (!selectedParentPageId || stored.parentPageId === selectedParentPageId)
    ) {
      const existing = await refreshDatabase(store, stored, readOnly);

      if (existing && (!selectedParentPageId || existing.parentPageId === selectedParentPageId)) {
        return existing;
      }
    }

    // An explicit parent selection is authoritative. Do not keep querying a
    // previously cached database under another parent; each installation can
    // otherwise keep reading a different project/page inventory indefinitely.
    if (selectedParentPageId) {
      store.jottathingDatabase = undefined;
    }

    if (!selectedParentPageId) {
      const foundAccessible = await findExistingDatabase(store, { ignoredDatabaseIds });

      if (foundAccessible) {
        store.jottathingDatabase = foundAccessible;
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
      store.jottathingDatabase = found;
      await ensureProjectSchema(store, found.dataSourceId);
      await ensureProjectViews(store, found);
      appendLog(store, 'project_database_adopted', found.title);
      return found;
    }

    const created = await createProjectDatabaseWithFallback(store, parentPage?.id, {
      ignoredDatabaseIds,
    });
    store.jottathingDatabase = created;
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
        store.jottathingRootPage = {
          id: page.id,
          parentPageId: undefined,
          title: titleFromPage(page) || JOTTATHING_DATABASE_TITLE,
          url: page.url,
        };
        return store.jottathingRootPage;
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
    const dataSources: NotionObject[] = [];
    const seenDataSourceIds = new Set<string>();
    // Since Notion API version 2025-09-03, database search results are data
    // sources. The current Jottathing database uses "Projects" as its data
    // source title; the database titles cover installations created by older
    // versions of the API.
    const searchTitles = [
      JOTTATHING_PROJECTS_DATA_SOURCE_TITLE,
      JOTTATHING_DATABASE_TITLE,
      ...legacyDatabaseTitles,
    ];
    for (const query of searchTitles) {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const body: JsonObject = {
          query,
          page_size: 100,
          filter: { property: 'object', value: 'data_source' },
        };
        if (cursor) body.start_cursor = cursor;

        // Discovery failures must stop the operation. Treating an API failure
        // as empty would create a duplicate database and split user data.
        const response = await notionRequest(store, '/search', { method: 'POST', body });
        if (!Array.isArray(response.results)) {
          throw new Error('Notion returned an invalid data source search result.');
        }
        for (const dataSource of response.results) {
          if (!seenDataSourceIds.has(dataSource.id)) {
            seenDataSourceIds.add(dataSource.id);
            dataSources.push(dataSource);
          }
        }
        if (response.has_more) {
          const nextCursor = response.next_cursor;
          if (!nextCursor || seenCursors.has(nextCursor)) {
            throw new Error('Notion returned an incomplete database search result.');
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        } else {
          cursor = undefined;
        }
      } while (cursor);
    }

    const candidates = [];
    const databaseIds = new Set<string>();

    for (const dataSource of dataSources) {
      const databaseId = dataSource.parent?.database_id;
      if (!databaseId || ignoredDatabaseIds.has(databaseId) || databaseIds.has(databaseId)) continue;

      // Search returns a data_source object. Resolve its parent database so
      // we can verify the managed database title and its page/workspace parent.
      const database = await notionRequest(store, `/databases/${databaseId}`);
      databaseIds.add(databaseId);
      const dataSourceId = dataSource.id ?? firstDataSourceId(database);

      if (
        !isArchivedObject(database) &&
        [JOTTATHING_DATABASE_TITLE, ...legacyDatabaseTitles].includes(titleFromDatabase(database)) &&
        (parentPageId === undefined || parentPageIdFromObject(database) === parentPageId) &&
        dataSourceId
      ) {
        candidates.push({
          database,
          dataSourceId,
          mappedProjects: mappedProjectCount(store, databaseId),
          managedProjects: await managedProjectCount(store, dataSourceId),
        });
      }
    }

    candidates.sort(compareDatabaseCandidates);
    const selected = candidates[0];

    if (!selected) return undefined;

    let database = selected.database;
    if (titleFromDatabase(database) !== JOTTATHING_DATABASE_TITLE) {
      database = await notionRequest(store, `/databases/${database.id}`, {
        method: 'PATCH',
        body: { title: richText(JOTTATHING_DATABASE_TITLE) },
      });
    }
    return databaseSummary(
      database,
      selected.dataSourceId,
      parentPageId ?? parentPageIdFromObject(database),
    );
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
    const seenCursors = new Set<string>();

    try {
      const schema = await notionRequest(store, `/data_sources/${dataSourceId}`);
      const properties = schema.properties ?? {};
      const managedProperty = properties[PROJECT_PROPERTIES.managed]
        ? PROJECT_PROPERTIES.managed
        : properties['Managed by Inkwell']
          ? 'Managed by Inkwell'
          : properties['Managed by Jot']
            ? 'Managed by Jot'
            : PROJECT_PROPERTIES.managed;
      const managedPropertySchema = properties[managedProperty];
      if (!managedPropertySchema) return -1;
      const managedPropertyType = typeof managedPropertySchema.type === 'string'
        ? managedPropertySchema.type
        : undefined;
      do {
        const body: JsonObject = { page_size: 100 };
        // Only send a typed filter when the adopted schema confirms it is valid.
        // Older workspaces may have customized or migrated this property to a
        // different type, where a checkbox filter makes Notion reject discovery.
        if (managedPropertyType === 'checkbox') {
          body.filter = {
            property: managedProperty,
            checkbox: { equals: true },
          };
        }

        if (cursor) {
          body.start_cursor = cursor;
        }

        const response = await notionRequest(store, `/data_sources/${dataSourceId}/query`, {
          method: 'POST',
          body,
        });
        if (!Array.isArray(response.results)) {
          throw new Error('Notion returned an invalid managed-project count result.');
        }
        count += managedPropertyType === 'checkbox'
          ? response.results.length
          : response.results.filter((page) => checkboxValue(page.properties?.[managedProperty])).length;
        if (response.has_more) {
          const nextCursor = response.next_cursor;
          if (!nextCursor || seenCursors.has(nextCursor)) {
            throw new Error('Notion returned an incomplete managed-project count.');
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        } else {
          cursor = undefined;
        }
      } while (cursor);

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

    if (
      properties['Inkwell ID'] || properties['Jot ID'] ||
      properties['Managed by Inkwell'] || properties['Managed by Jot']
    ) {
      await migrateLegacyProjectProperties(store, dataSourceId, properties);
    }
  }

  /** Copies legacy managed fields forward before the renamed fields are used for queries. */
  async function migrateLegacyProjectProperties(
    store: WorkerStore,
    dataSourceId: string,
    properties: Record<string, JsonObject>,
  ): Promise<void> {
    const legacyIdName = properties['Inkwell ID']
      ? 'Inkwell ID'
      : properties['Jot ID']
        ? 'Jot ID'
        : undefined;
    const legacyId = legacyIdName ? properties[legacyIdName] : undefined;
    const legacyManagedName = properties['Managed by Inkwell']
      ? 'Managed by Inkwell'
      : properties['Managed by Jot']
        ? 'Managed by Jot'
        : undefined;
    if (!legacyId && !legacyManagedName) return;

    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const body: JsonObject = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const response = await notionRequest(store, `/data_sources/${dataSourceId}/query`, {
        method: 'POST',
        body,
      });
      if (!Array.isArray(response.results)) {
        throw new Error('Notion returned an invalid legacy project-property migration page.');
      }
      for (const page of response.results) {
        const pageProperties = page.properties ?? {};
        const updates: JsonObject = {};
        if (
          legacyId && !richTextProperty(pageProperties[PROJECT_PROPERTIES.jottathingId]).trim()
        ) {
          const idValue = legacyIdName ? richTextProperty(pageProperties[legacyIdName]) : '';
          if (idValue) updates[PROJECT_PROPERTIES.jottathingId] = { rich_text: richText(idValue) };
        }
        if (
          legacyManagedName &&
          checkboxValue(pageProperties[legacyManagedName]) &&
          !checkboxValue(pageProperties[PROJECT_PROPERTIES.managed])
        ) {
          updates[PROJECT_PROPERTIES.managed] = { checkbox: true };
        }
        if (Object.keys(updates).length) {
          await notionRequest(store, `/pages/${page.id}`, {
            method: 'PATCH',
            body: { properties: updates },
          });
        }
      }
      if (response.has_more) {
        const nextCursor = response.next_cursor;
        if (!nextCursor || seenCursors.has(nextCursor)) {
          throw new Error('Notion returned an incomplete legacy project-property migration.');
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } else {
        cursor = undefined;
      }
    } while (cursor);
  }

  /** Adds missing managed views. @param store - Worker state. @param database - Database summary. @returns Completion promise. */
  async function ensureProjectViews(store: WorkerStore, database: JottathingDatabase): Promise<void> {
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

function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}
