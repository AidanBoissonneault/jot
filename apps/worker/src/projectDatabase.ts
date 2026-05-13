// @ts-nocheck
const INKWELL_DATABASE_TITLE = 'Inkwell';
const PROJECT_STATE_BLOCK_KEY = 'project-state';

const PROJECT_PROPERTIES = {
  title: 'Name',
  status: 'Status',
  category: 'Category',
  created: 'Created',
  updated: 'Updated',
  createdBy: 'Created by',
  lastEditedBy: 'Last edited by',
  inkwellId: 'Inkwell ID',
  managed: 'Managed by Inkwell',
};

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
}) {
  async function ensureProjectDatabase(store, { selectedParentPageId } = {}) {
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

  async function ensureDatabaseParentPage(store, selectedParentPageId) {
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
        appendLog(store, 'database_parent_inaccessible', `${selectedParentPageId}: ${error.message}`);
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

  async function refreshDatabase(store, stored) {
    try {
      const database = await notionRequest(store, `/databases/${stored.databaseId}`);
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
      appendLog(store, 'project_database_lookup_error', error.message);
      return undefined;
    }
  }

  async function findExistingDatabase(store, { parentPageId, ignoredDatabaseIds = new Set() } = {}) {
    const response = await notionRequest(store, '/search', {
      method: 'POST',
      body: {
        query: INKWELL_DATABASE_TITLE,
        page_size: 20,
        filter: {
          property: 'object',
          value: 'database',
        },
      },
    }).catch(() => ({ results: [] }));

    for (const database of response.results ?? []) {
      const dataSourceId = firstDataSourceId(database);

      if (
        !ignoredDatabaseIds.has(database.id) &&
        !isArchivedObject(database) &&
        titleFromDatabase(database) === INKWELL_DATABASE_TITLE &&
        (parentPageId === undefined || parentPageIdFromObject(database) === parentPageId) &&
        dataSourceId
      ) {
        return databaseSummary(database, dataSourceId, parentPageId ?? parentPageIdFromObject(database));
      }
    }

    return undefined;
  }

  async function createProjectDatabaseWithFallback(store, parentPageId, {
    ignoredDatabaseIds = new Set(),
  } = {}) {
    if (parentPageId) {
      return createProjectDatabase(store, parentPageId);
    }

    try {
      return await createProjectDatabase(store);
    } catch (error) {
      appendLog(store, 'project_database_workspace_create_error', error.message);
      const found = await findExistingDatabase(store, { ignoredDatabaseIds });

      if (found) {
        return found;
      }

      const parentPage = await ensureDatabaseParentPage(store);
      return createProjectDatabase(store, parentPage.id);
    }
  }

  async function createProjectDatabase(store, parentPageId) {
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

  async function ensureProjectSchema(store, dataSourceId) {
    const dataSource = await notionRequest(store, `/data_sources/${dataSourceId}`);
    const properties = dataSource.properties ?? {};
    const missing = {};

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

  async function ensureProjectViews(store, database) {
    const existing = await listViews(store, database.databaseId);
    const existingNames = new Set(existing.map((view) => view.name).filter(Boolean));
    const dataSource = await notionRequest(store, `/data_sources/${database.dataSourceId}`).catch(() => ({}));
    const propertyIds = propertyIdMap(dataSource.properties ?? {});
    const views = [
      activeProjectsView(propertyIds),
      byCategoryView(propertyIds),
      allProjectsView(propertyIds),
    ];

    for (const view of views) {
      if (existingNames.has(view.name)) {
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
        appendLog(store, 'project_view_create_error', `${view.name}: ${error.message}`);
        return undefined;
      });

      if (created?.id) {
        store.inkwellDatabase.views = {
          ...(store.inkwellDatabase.views ?? {}),
          [view.name]: created.id,
        };
      }
    }
  }

  async function listViews(store, databaseId) {
    const results = [];
    let cursor;

    do {
      const search = new URLSearchParams();
      search.set('database_id', databaseId);
      if (cursor) search.set('start_cursor', cursor);

      const response = await notionRequest(store, `/views?${search}`).catch(() => ({ results: [] }));
      for (const viewRef of response.results ?? []) {
        if (viewRef.name) {
          results.push(viewRef);
        } else if (viewRef.id) {
          const view = await notionRequest(store, `/views/${viewRef.id}`).catch(() => viewRef);
          results.push(view);
        }
      }
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    return results;
  }

  async function ensureProjectPage(store, project, { selectedParentPageId } = {}) {
    return ensureProjectPageAttempt(store, project, { selectedParentPageId });
  }

  async function ensureProjectPageAttempt(
    store,
    project,
    { selectedParentPageId, retryOnArchivedAncestor = true } = {},
  ) {
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

      const stateSync = await syncProjectState(store, page.id, project);
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
      });
    }
  }

  async function reloadProjectDatabaseFromNotion(store, { selectedParentPageId } = {}) {
    clearSyncMappings(store);
    const requestedParentPageId = selectedParentPageId;
    const database = await ensureProjectDatabase(store, { selectedParentPageId });
    const clearSelectedParentPage = Boolean(
      requestedParentPageId &&
      store.inkwellRootPage?.id &&
      store.inkwellRootPage.id !== requestedParentPageId,
    );
    const rows = await queryManagedProjectRows(store, database.dataSourceId);
    const projects = [];
    const pages = [];
    const activePageIdsByProject = {};

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

  function clearSyncMappings(store) {
    store.projectPages = {};
    store.projectBlocks = {};
    store.threadBlocks = {};
    store.notePages = {};
    store.blockMappings = {};
  }

  function invalidateProjectDatabase(store, databaseId) {
    store.ignoredInkwellDatabaseIds ??= new Set();
    if (databaseId) {
      store.ignoredInkwellDatabaseIds.add(databaseId);
    }
    store.inkwellDatabase = undefined;
    clearSyncMappings(store);
  }

  async function queryManagedProjectRows(store, dataSourceId) {
    const results = [];
    let cursor;

    do {
      const body = {
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

  function projectFromNotionPage(page) {
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

  async function importProjectState(store, projectPage, project, stateBlock) {
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

  async function pageFromThreadBlock(store, project, projectPage, threadBlock) {
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

  async function findProjectPageByInkwellId(store, dataSourceId, projectId) {
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

  async function createProjectDatabasePage(store, dataSourceId, project) {
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

  async function updateProjectDatabasePage(store, pageId, project) {
    const body = {
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

  async function syncProjectState(store, notionPageId, project) {
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

  async function ensureThreadToggle(store, projectPageId, page) {
    return ensureToggleBlock(store, projectPageId, page.title || 'Untitled Page', {
      key: threadKey(page.id),
      mappings: store.threadBlocks,
    });
  }

  async function ensureToggleBlock(store, parentBlockId, title, { key, mappings }) {
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
      mappings[key] = { blockId: matching.id, parentPageId: parentBlockId, title };
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

    mappings[key] = { blockId: created.id, parentPageId: parentBlockId, title };
    return created;
  }

  async function updateToggleTitle(store, blockId, title) {
    return notionRequest(store, `/blocks/${blockId}`, {
      method: 'PATCH',
      body: {
        toggle: {
          rich_text: richText(title || 'Untitled Page'),
        },
      },
    });
  }

  async function updateThreadToggleTitle(store, page) {
    const stored = store.threadBlocks?.[threadKey(page.id)];

    if (!stored?.blockId || stored.title === page.title) {
      return;
    }

    await updateToggleTitle(store, stored.blockId, page.title || 'Untitled Page');
    stored.title = page.title || 'Untitled Page';
  }

  async function archiveThreadToggle(store, page) {
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

  async function importThreadContent(store, page) {
    const stored = store.threadBlocks?.[threadKey(page.id)];

    if (!stored?.blockId) {
      return null;
    }

    const blocks = await listAllBlockChildren(store, stored.blockId);
    return blocks.length ? notionBlocksToTiptapDocument(blocks) : emptyDocument();
  }

  function storeProjectPage(store, database, project, page) {
    store.projectPages[project.id] = {
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
    ensureThreadToggle,
    importThreadContent,
    reloadProjectDatabaseFromNotion,
    projectStateKey,
    threadKey,
    updateThreadToggleTitle,
  };
}

export function projectProperties(project) {
  const createdAt = project.createdAt ?? new Date().toISOString();
  const updatedAt = project.updatedAt ?? createdAt;
  const category = String(project.category ?? '').trim();

  return {
    [PROJECT_PROPERTIES.title]: {
      title: [{ text: { content: project.name || 'Untitled Project' } }],
    },
    [PROJECT_PROPERTIES.status]: {
      select: {
        name: project.status === 'archived' ? 'Archived' : 'Active',
      },
    },
    [PROJECT_PROPERTIES.category]: {
      select: category ? { name: category } : null,
    },
    [PROJECT_PROPERTIES.created]: {
      date: { start: createdAt },
    },
    [PROJECT_PROPERTIES.updated]: {
      date: { start: updatedAt },
    },
    [PROJECT_PROPERTIES.inkwellId]: {
      rich_text: [{ text: { content: project.id } }],
    },
    [PROJECT_PROPERTIES.managed]: {
      checkbox: true,
    },
  };
}

function projectSchema() {
  return {
    [PROJECT_PROPERTIES.title]: { title: {} },
    [PROJECT_PROPERTIES.status]: {
      select: {
        options: [
          { name: 'Active', color: 'green' },
          { name: 'Archived', color: 'gray' },
        ],
      },
    },
    [PROJECT_PROPERTIES.category]: { select: { options: [] } },
    [PROJECT_PROPERTIES.created]: { date: {} },
    [PROJECT_PROPERTIES.updated]: { date: {} },
    [PROJECT_PROPERTIES.createdBy]: { created_by: {} },
    [PROJECT_PROPERTIES.lastEditedBy]: { last_edited_by: {} },
    [PROJECT_PROPERTIES.inkwellId]: { rich_text: {} },
    [PROJECT_PROPERTIES.managed]: { checkbox: {} },
  };
}

function activeProjectsView(propertyIds) {
  return {
    name: 'Active Projects',
    type: 'table',
    filter: {
      property: PROJECT_PROPERTIES.status,
      select: { does_not_equal: 'Archived' },
    },
    sorts: [{ property: PROJECT_PROPERTIES.updated, direction: 'descending' }],
    configuration: tableConfiguration(propertyIds, {
      visible: [
        PROJECT_PROPERTIES.title,
        PROJECT_PROPERTIES.status,
        PROJECT_PROPERTIES.category,
        PROJECT_PROPERTIES.updated,
      ],
    }),
    position: { type: 'start' },
  };
}

function byCategoryView(propertyIds) {
  return {
    name: 'By Category',
    type: 'board',
    filter: {
      property: PROJECT_PROPERTIES.status,
      select: { does_not_equal: 'Archived' },
    },
    sorts: [{ property: PROJECT_PROPERTIES.updated, direction: 'descending' }],
    configuration: {
      type: 'board',
      group_by: propertyIds[PROJECT_PROPERTIES.category]
        ? {
            type: 'select',
            property_id: propertyIds[PROJECT_PROPERTIES.category],
            group_by: 'value',
            sort: { type: 'manual' },
          }
        : undefined,
      card_layout: 'compact',
      properties: propertyVisibility(propertyIds, [
        PROJECT_PROPERTIES.title,
        PROJECT_PROPERTIES.status,
        PROJECT_PROPERTIES.updated,
      ]),
    },
  };
}

function allProjectsView(propertyIds) {
  return {
    name: 'All Projects',
    type: 'table',
    sorts: [{ property: PROJECT_PROPERTIES.updated, direction: 'descending' }],
    configuration: tableConfiguration(propertyIds, {
      visible: Object.values(PROJECT_PROPERTIES),
    }),
  };
}

function tableConfiguration(propertyIds, { visible }) {
  return {
    type: 'table',
    properties: propertyVisibility(propertyIds, visible),
    wrap_cells: false,
  };
}

function propertyVisibility(propertyIds, visibleNames) {
  const visible = new Set(visibleNames);
  return Object.entries(propertyIds).map(([name, property_id]) => ({
    property_id,
    visible: visible.has(name),
  }));
}

function propertyIdMap(properties) {
  return Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [name, property.id ?? name]),
  );
}

function databaseSummary(database, dataSourceId, parentPageId) {
  return {
    databaseId: database.id,
    dataSourceId,
    parentPageId: parentPageId ?? parentPageIdFromObject(database),
    title: titleFromDatabase(database) || INKWELL_DATABASE_TITLE,
    url: database.url,
  };
}

function pageSummaryFromNotionPage(page, database) {
  return {
    id: page.id,
    parentPageId: database.databaseId,
    title: titleFromPage(page),
    url: page.url,
  };
}

function databaseParent(parentPageId) {
  return parentPageId
    ? {
        type: 'page_id',
        page_id: parentPageId,
      }
    : {
        type: 'workspace',
        workspace: true,
      };
}

function firstDataSourceId(database) {
  return database?.data_sources?.[0]?.id ?? database?.initial_data_source?.id;
}

function parentPageIdFromObject(object) {
  return object?.parent?.type === 'page_id' ? object.parent.page_id : undefined;
}

function isArchivedObject(object) {
  return Boolean(object?.archived || object?.in_trash);
}

function isArchivedAncestorError(error) {
  return (
    error?.code === 'validation_error' &&
    /archived ancestor|unarchive the ancestor/i.test(error?.message ?? '')
  );
}

function isBlockNotPageError(error) {
  return (
    error?.code === 'validation_error' &&
    /is a block, not a page|retrieve block API/i.test(error?.message ?? '')
  );
}

function titleFromDatabase(database) {
  return (database?.title ?? []).map((item) => item.plain_text ?? item.text?.content ?? '').join('');
}

function titleFromPage(page) {
  const titleProperty = Object.values(page.properties ?? {}).find(
    (property) => property.type === 'title',
  );
  return titleProperty?.title?.map((item) => item.plain_text ?? item.text?.content ?? '').join('') || page.title || 'Untitled';
}

function richTextProperty(property) {
  return (property?.rich_text ?? []).map((item) => item.plain_text ?? item.text?.content ?? '').join('');
}

function selectProperty(property) {
  return property?.select?.name ?? '';
}

function dateProperty(property) {
  return property?.date?.start;
}

function richText(content) {
  return [{ type: 'text', text: { content } }];
}

function toggleBlock(title) {
  return {
    object: 'block',
    type: 'toggle',
    toggle: {
      rich_text: richText(title || 'Untitled Page'),
      color: 'default',
    },
  };
}

function toggleTitle(block) {
  return block?.toggle?.rich_text?.map((item) => item.plain_text ?? item.text?.content ?? '').join('') ?? '';
}

function emptyDocument() {
  return {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  };
}

export function projectStateKey(projectId) {
  return `${PROJECT_STATE_BLOCK_KEY}:${projectId}`;
}

export function threadKey(pageId) {
  return `thread:${pageId}`;
}
