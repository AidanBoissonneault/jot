import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectDatabaseHelpers, projectProperties } from '../src/projectDatabase.js';

function createHelpers({ calls = [], blocks = {}, responses = {} } = {}) {
  const store = {
    blockMappings: {},
    logs: [],
    notePages: {},
    parentPages: {},
    projectBlocks: {},
    projectPages: {},
    threadBlocks: {},
    tokens: { access_token: 'token' },
  };

  const helpers = createProjectDatabaseHelpers({
    appendLog: (_store, event, message) => calls.push(['log', event, message]),
    createWorkspacePage: async (_store, title) => {
      calls.push(['create-workspace-page', title]);
      return page('parent-page', title);
    },
    hash: (value) => `hash:${value}`,
    isNotionObjectNotFound: (error) => error?.status === 404,
    listAllBlockChildren: async (_store, blockId) => blocks[blockId] ?? [],
    notionBlocksToTiptapDocument: (notionBlocks) => ({
      type: 'doc',
      content: notionBlocks.map(() => ({ type: 'paragraph' })),
    }),
    notionRequest: async (_store, endpoint, init = {}) => {
      calls.push(['notion', endpoint, init.method ?? 'GET', init.body]);

      if (responses[endpoint]) {
        return responses[endpoint](init);
      }

      if (endpoint === '/search') {
        return { results: [] };
      }

      if (endpoint === '/databases') {
        return database('database-1', 'data-source-1', parentPageIdFromRequest(init.body.parent));
      }

      if (endpoint === '/databases/database-1') {
        return database('database-1', 'data-source-1', undefined);
      }

      if (endpoint === '/data_sources/data-source-1') {
        return { id: 'data-source-1', properties: {} };
      }

      if (endpoint.startsWith('/views?')) {
        return { results: [] };
      }

      if (endpoint === '/views') {
        return { id: `view-${init.body.name}` };
      }

      if (endpoint === '/data_sources/data-source-1/query') {
        return { results: [] };
      }

      if (endpoint === '/pages') {
        return page('project-page-1', init.body.properties.Name.title[0].text.content, 'database-1');
      }

      if (endpoint === '/blocks/project-page-1/children' || endpoint === '/blocks/existing-project-page/children') {
        return {
          results: [block('project-state-block', init.body.children[0].toggle.rich_text[0].text.content)],
        };
      }

      if (endpoint === '/blocks/project-state-block/children') {
        return { results: [{ id: 'state-child-1', type: 'paragraph' }] };
      }

      if (endpoint === '/blocks/thread-block/children') {
        return { results: [{ id: 'thread-child-1', type: 'paragraph' }] };
      }

      if (endpoint.startsWith('/blocks/')) {
        return { id: endpoint.replace('/blocks/', ''), type: 'toggle', toggle: { rich_text: [] } };
      }

      return {};
    },
    replaceManagedBlocks: async (_store, key, blockId, content) => {
      calls.push(['replace-managed', key, blockId, content]);
      return { createdBlocks: [] };
    },
    tiptapDocumentToNotionBlocks: () => [],
  });

  return { calls, helpers, store };
}

test('ensureProjectDatabase creates database schema and default views', async () => {
  const { calls, helpers, store } = createHelpers();

  const database = await helpers.ensureProjectDatabase(store);

  assert.equal(database.databaseId, 'database-1');
  assert.equal(database.dataSourceId, 'data-source-1');
  assert.equal(store.jotRootPage, undefined);
  assert.equal(store.jotDatabase.databaseId, 'database-1');
  assert.equal(
    calls.some((call) => call[0] === 'create-workspace-page'),
    false,
  );
  assert.deepEqual(
    calls
      .filter((call) => call[0] === 'notion' && call[1] === '/views')
      .map((call) => call[3].name),
    ['Active Projects', 'By Category', 'All Projects'],
  );
  assert(calls.some((call) =>
    call[0] === 'notion' &&
    call[1] === '/databases' &&
    call[2] === 'POST' &&
    call[3].parent.type === 'workspace' &&
    call[3].initial_data_source.properties.Name,
  ));
});

test('ensureProjectDatabase adopts an accessible Jot database before creating one', async () => {
  const existingDatabase = database('selected-database', 'selected-data-source', undefined);
  const { calls, helpers, store } = createHelpers({
    responses: {
      '/search': () => ({ results: [existingDatabase] }),
      '/databases/selected-database': () => existingDatabase,
      '/data_sources/selected-data-source': () => ({ id: 'selected-data-source', properties: {} }),
    },
  });

  const databaseSummary = await helpers.ensureProjectDatabase(store);

  assert.equal(databaseSummary.databaseId, 'selected-database');
  assert.equal(databaseSummary.dataSourceId, 'selected-data-source');
  assert.equal(store.jotDatabase.databaseId, 'selected-database');
  assert.equal(
    calls.some((call) => call[0] === 'notion' && call[1] === '/databases' && call[2] === 'POST'),
    false,
  );
  assert.equal(
    calls.some((call) => call[0] === 'create-workspace-page'),
    false,
  );
});

test('ensureProjectDatabase ignores selected block IDs as parent pages', async () => {
  const blockNotPageError = Object.assign(
    new Error('Provided ID block-id is a block, not a page. Use the retrieve block API instead'),
    { code: 'validation_error', status: 400 },
  );
  const { calls, helpers, store } = createHelpers({
    responses: {
      '/pages/block-id': () => {
        throw blockNotPageError;
      },
    },
  });

  const databaseSummary = await helpers.ensureProjectDatabase(store, {
    selectedParentPageId: 'block-id',
  });

  assert.equal(databaseSummary.databaseId, 'database-1');
  assert.equal(databaseSummary.parentPageId, undefined);
  assert(calls.some((call) =>
    call[0] === 'log' &&
    call[1] === 'database_parent_inaccessible' &&
    call[2].includes('block, not a page'),
  ));
  assert(calls.some((call) =>
    call[0] === 'notion' &&
    call[1] === '/databases' &&
    call[2] === 'POST' &&
    call[3].parent.type === 'workspace',
  ));
});

test('ensureProjectPage creates a database page and project state block', async () => {
  const { calls, helpers, store } = createHelpers();

  const projectPage = await helpers.ensureProjectPage(store, project('project-1', 'Research'), {});

  assert.equal(projectPage.id, 'project-page-1');
  assert.equal(store.projectPages['project-1'].notionPageId, 'project-page-1');
  assert.equal(store.projectBlocks['project-state:project-1'].blockId, 'project-state-block');
  const createPageCall = calls.find((call) => call[0] === 'notion' && call[1] === '/pages');
  assert.equal(createPageCall[3].parent.type, 'data_source_id');
  assert.equal(createPageCall[3].properties.Category.select.name, 'Research');
});

test('ensureProjectPage updates an existing row by Jot ID', async () => {
  const existingProjectPage = page('existing-project-page', 'Research', 'database-1');
  const { calls, helpers, store } = createHelpers({
    responses: {
      '/data_sources/data-source-1/query': () => ({ results: [existingProjectPage] }),
      '/pages/existing-project-page': (init) => ({
        ...existingProjectPage,
        properties: init.body.properties,
      }),
    },
  });

  const projectPage = await helpers.ensureProjectPage(store, project('project-1', 'Research'), {});

  assert.equal(projectPage.id, 'existing-project-page');
  const updateCall = calls.find((call) =>
    call[0] === 'notion' && call[1] === '/pages/existing-project-page',
  );
  assert.equal(Object.hasOwn(updateCall[3], 'archived'), false);
  assert(calls.some((call) =>
    call[0] === 'notion' &&
    call[1] === '/data_sources/data-source-1/query' &&
    call[3].filter.rich_text.equals === 'project-1',
  ));
  assert.equal(calls.some((call) => call[0] === 'notion' && call[1] === '/pages'), false);
});

test('ensureProjectPage clears archived database cache and retries once', async () => {
  const archivedAncestorError = Object.assign(
    new Error("Can't edit page on block with an archived ancestor. You must unarchive the ancestor before editing page."),
    { code: 'validation_error', status: 400 },
  );
  const { calls, helpers, store } = createHelpers({
    responses: {
      '/databases/stale-database': () => database('stale-database', 'stale-source', undefined),
      '/data_sources/stale-source': () => ({ id: 'stale-source', properties: {} }),
      '/data_sources/stale-source/query': () => ({ results: [] }),
      '/pages': (init) => {
        if (init.body.parent.data_source_id === 'stale-source') {
          throw archivedAncestorError;
        }

        return page('project-page-1', init.body.properties.Name.title[0].text.content, 'database-1');
      },
    },
  });
  store.jotDatabase = {
    databaseId: 'stale-database',
    dataSourceId: 'stale-source',
    title: 'Jot',
  };
  store.projectPages = {
    stale: { notionPageId: 'stale-page' },
  };

  const projectPage = await helpers.ensureProjectPage(store, project('project-1', 'Research'), {});

  assert.equal(projectPage.id, 'project-page-1');
  assert.equal(store.jotDatabase.databaseId, 'database-1');
  assert.equal(store.projectPages.stale, undefined);
  assert(calls.some((call) =>
    call[0] === 'log' &&
    call[1] === 'project_database_archived_ancestor',
  ));
  assert.equal(
    calls.filter((call) => call[0] === 'notion' && call[1] === '/databases' && call[2] === 'POST').length,
    1,
  );
});

test('ensureThreadToggle creates collapsible thread blocks and imports their content', async () => {
  const { helpers, store } = createHelpers({
    blocks: {
      'project-page-1': [],
    },
    responses: {
      '/blocks/project-page-1/children': (init) => ({
        results: [block('thread-block', init.body.children[0].toggle.rich_text[0].text.content)],
      }),
    },
  });

  const created = await helpers.ensureThreadToggle(store, 'project-page-1', {
    id: 'page-1',
    title: 'Thread A',
  });
  const content = await helpers.importThreadContent(store, { id: 'page-1' });

  assert.equal(created.id, 'thread-block');
  assert.equal(store.threadBlocks['thread:page-1'].title, 'Thread A');
  assert.deepEqual(content, {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  });
});

test('reloadProjectDatabaseFromNotion imports active managed projects and thread pages', async () => {
  const projectRow = managedProjectPage('project-page-1', 'Research', {
    category: 'Notes',
    jotId: 'project-1',
  });
  const archivedRow = managedProjectPage('project-page-archived', 'Old', {
    jotId: 'project-old',
    status: 'Archived',
  });
  const unmanagedRow = managedProjectPage('project-page-unmanaged', 'Unmanaged', {
    jotId: '',
  });
  const stateBlock = block('project-state-block', 'Project State');
  const threadBlock = block('thread-block', 'Thread A');
  const deletedThreadBlock = block('thread-deleted-block', 'Deleted locally should not survive');
  const { helpers, store } = createHelpers({
    blocks: {
      'project-page-1': [stateBlock, threadBlock],
      'project-state-block': [{ id: 'state-child-1', type: 'paragraph' }],
      'thread-block': [{ id: 'thread-child-1', type: 'paragraph' }],
      'project-page-archived': [deletedThreadBlock],
    },
    responses: {
      '/data_sources/data-source-1/query': () => ({
        results: [projectRow, archivedRow, unmanagedRow],
      }),
    },
  });
  store.projectPages = { stale: { notionPageId: 'stale-project' } };
  store.threadBlocks = { stale: { blockId: 'stale-thread' } };
  store.notePages = { stale: { notionPageId: 'stale-thread' } };

  const result = await helpers.reloadProjectDatabaseFromNotion(store, {});

  assert.deepEqual(result.projects.map((project) => project.id), ['project-1']);
  assert.deepEqual(result.pages.map((page) => page.title), ['Thread A']);
  assert.equal(result.pages[0].id, 'page-project-1-thread-block');
  assert.equal(result.activePageIdsByProject['project-1'], result.pages[0].id);
  assert.equal(result.projects[0].stateRemoteRevision, stateBlock.last_edited_time);
  assert.equal(store.projectPages['project-1'].notionPageId, 'project-page-1');
  assert.equal(store.projectBlocks['project-state:project-1'].blockId, 'project-state-block');
  assert.equal(store.threadBlocks['thread:page-project-1-thread-block'].blockId, 'thread-block');
  assert.equal(store.notePages['page-project-1-thread-block'].notionPageId, 'thread-block');
  assert.equal(store.projectPages.stale, undefined);
});

test('projectProperties writes core project metadata only', () => {
  const properties = projectProperties(project('project-1', 'Research'));

  assert.equal(properties.Name.title[0].text.content, 'Research');
  assert.equal(properties.Status.select.name, 'Active');
  assert.equal(properties.Category.select.name, 'Research');
  assert.equal(properties['Jot ID'].rich_text[0].text.content, 'project-1');
  assert.equal(properties['Managed by Jot'].checkbox, true);
});

function project(id, name) {
  return {
    id,
    name,
    category: 'Research',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    stateContent: { type: 'doc', content: [{ type: 'paragraph' }] },
    status: 'active',
    tags: [],
  };
}

function database(id, dataSourceId, parentPageId) {
  return {
    id,
    parent: parentPageId
      ? { type: 'page_id', page_id: parentPageId }
      : { type: 'workspace', workspace: true },
    title: [{ plain_text: 'Jot' }],
    data_sources: [{ id: dataSourceId }],
    url: `https://notion.test/${id}`,
  };
}

function parentPageIdFromRequest(parent) {
  return parent?.type === 'page_id' ? parent.page_id : undefined;
}

function page(id, title, parentPageId) {
  return {
    id,
    last_edited_time: '2026-01-02T00:00:00.000Z',
    parent: parentPageId
      ? { type: 'page_id', page_id: parentPageId }
      : { type: 'workspace', workspace: true },
    properties: {
      Name: {
        type: 'title',
        title: [{ plain_text: title }],
      },
    },
    url: `https://notion.test/${id}`,
  };
}

function managedProjectPage(id, title, {
  category = '',
  jotId,
  status = 'Active',
} = {}) {
  return {
    ...page(id, title, 'database-1'),
    created_time: '2026-01-01T00:00:00.000Z',
    last_edited_time: '2026-01-03T00:00:00.000Z',
    properties: {
      Name: {
        type: 'title',
        title: [{ plain_text: title }],
      },
      Status: {
        type: 'select',
        select: { name: status },
      },
      Category: {
        type: 'select',
        select: category ? { name: category } : null,
      },
      Created: {
        type: 'date',
        date: { start: '2026-01-01T00:00:00.000Z' },
      },
      Updated: {
        type: 'date',
        date: { start: '2026-01-03T00:00:00.000Z' },
      },
      'Jot ID': {
        type: 'rich_text',
        rich_text: jotId ? [{ plain_text: jotId }] : [],
      },
      'Managed by Jot': {
        type: 'checkbox',
        checkbox: true,
      },
    },
  };
}

function block(id, title) {
  return {
    id,
    last_edited_time: '2026-01-04T00:00:00.000Z',
    type: 'toggle',
    toggle: {
      rich_text: [{ plain_text: title }],
    },
  };
}
