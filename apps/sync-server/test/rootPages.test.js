import assert from 'node:assert/strict';
import test from 'node:test';
import { createRootPageHelpers } from '../src/rootPages.js';

function createPage(id, title, parentPageId) {
  return {
    id,
    parent: parentPageId
      ? { type: 'page_id', page_id: parentPageId }
      : { type: 'workspace', workspace: true },
    properties: {
      title: {
        type: 'title',
        title: [{ plain_text: title }],
      },
    },
    title,
    url: `https://notion.test/${id}`,
  };
}

function createHelpers({ calls = [], pages = {}, children = {}, responses = {} } = {}) {
  return createRootPageHelpers({
    appendLog: (_store, event, message) => calls.push(['log', event, message]),
    createChildPage: async (_store, parentPageId, title) => {
      calls.push(['create-child', parentPageId, title]);
      return createPage(`created-child-${title}`, title, parentPageId);
    },
    createWorkspacePage: async (_store, title) => {
      calls.push(['create-workspace', title]);
      return createPage('workspace-root', title);
    },
    isNotionObjectNotFound: (error) => error?.status === 404,
    listAllBlockChildren: async (_store, blockId) => children[blockId] ?? [],
    notionRequest: async (_store, endpoint) => {
      calls.push(['notion', endpoint]);
      if (responses[endpoint]) {
        return responses[endpoint]();
      }

      const id = endpoint.replace('/pages/', '');
      const page = pages[id];

      if (!page) {
        const error = new Error(`${id} not found`);
        error.status = 404;
        throw error;
      }

      return page;
    },
    titleFromPage: (page) =>
      page.title ??
      Object.values(page.properties ?? {})[0]?.title?.map((item) => item.plain_text).join('') ??
      'Untitled',
    updatePageTitle: async (_store, pageId, title) => {
      calls.push(['update-title', pageId, title]);
    },
  });
}

test('ensureJotRootPage adopts selected page as root without creating a child Jot page', async () => {
  const calls = [];
  const store = { logs: [], projectPages: {} };
  const helpers = createHelpers({
    calls,
    pages: {
      'selected-root': createPage('selected-root', 'Jot'),
    },
  });

  const root = await helpers.ensureJotRootPage(store, {
    selectedParentPageId: 'selected-root',
  });

  assert.deepEqual(root, {
    id: 'selected-root',
    parentPageId: undefined,
    title: 'Jot',
    url: 'https://notion.test/selected-root',
  });
  assert.equal(store.jotRootPage.id, 'selected-root');
  assert.equal(store.jotRootPage.parentPageId, undefined);
  assert.equal(calls.some((call) => call[0] === 'create-child'), false);
});

test('ensureJotRootPage falls back to workspace root when selected page is inaccessible', async () => {
  const calls = [];
  const store = { logs: [], projectPages: {} };
  const helpers = createHelpers({ calls });

  const root = await helpers.ensureJotRootPage(store, {
    selectedParentPageId: 'missing-root',
  });

  assert.equal(root.id, 'workspace-root');
  assert.deepEqual(calls.filter((call) => call[0].startsWith('create')), [
    ['create-workspace', 'Jot'],
  ]);
});

test('ensureJotRootPage falls back when selected id is a block', async () => {
  const calls = [];
  const store = { logs: [], projectPages: {} };
  const helpers = createHelpers({
    calls,
    pages: {},
    responses: {
      '/pages/block-id': () => {
        throw Object.assign(
          new Error('Provided ID block-id is a block, not a page. Use the retrieve block API instead'),
          { code: 'validation_error', status: 400 },
        );
      },
    },
  });

  const root = await helpers.ensureJotRootPage(store, {
    selectedParentPageId: 'block-id',
  });

  assert.equal(root.id, 'workspace-root');
  assert(calls.some((call) =>
    call[0] === 'log' &&
    call[1] === 'root_parent_inaccessible' &&
    call[2].includes('block, not a page'),
  ));
});

test('ensureProjectRootPage reuses existing project child under adopted root by title', async () => {
  const calls = [];
  const store = { logs: [], projectPages: {} };
  const helpers = createHelpers({
    calls,
    children: {
      'selected-root': [
        {
          id: 'existing-project-page',
          type: 'child_page',
          child_page: { title: 'Research' },
        },
      ],
    },
  });

  const projectPage = await helpers.ensureProjectRootPage(
    store,
    'selected-root',
    { id: 'project-1', name: 'Research' },
  );

  assert.equal(projectPage.id, 'existing-project-page');
  assert.deepEqual(store.projectPages['project-1'], {
    notionPageId: 'existing-project-page',
    parentPageId: 'selected-root',
    title: 'Research',
    lastEditedTime: undefined,
  });
  assert.equal(calls.some((call) => call[0] === 'create-child'), false);
});

test('ensureProjectRootPage reuses local page parent hint before title matching', async () => {
  const calls = [];
  const store = { logs: [], projectPages: {} };
  const helpers = createHelpers({
    calls,
    pages: {
      'known-project-page': createPage('known-project-page', 'Research', 'selected-root'),
    },
  });

  const projectPage = await helpers.ensureProjectRootPage(
    store,
    'selected-root',
    { id: 'project-1', name: 'Research' },
    { candidateNotionPageId: 'known-project-page' },
  );

  assert.equal(projectPage.id, 'known-project-page');
  assert.equal(calls.some((call) => call[0] === 'create-child'), false);
});
