import assert from 'node:assert/strict';
import test from 'node:test';
import { syncProjectFolder } from '../src/projectSync.js';

function createDependencies(calls) {
  return {
    ensureJotRootPage: async (_store, options) => {
      calls.push(['ensure-root', options.selectedParentPageId]);
      return { id: 'jot-root', title: 'Jot' };
    },
    ensureProjectRootPage: async (store, rootId, project) => {
      calls.push(['ensure-project', rootId, project.name]);
      store.projectPages[project.id] = {
        notionPageId: 'project-page',
        parentPageId: rootId,
        title: project.name,
      };
      return { id: 'project-page', parentPageId: rootId, title: project.name };
    },
    archiveProjectRootPage: async (_store, pageId) => {
      calls.push(['archive-project', pageId]);
    },
    pageSummary: (page) => ({
      id: page.id,
      parentPageId: page.parentPageId,
      title: page.title,
    }),
  };
}

test('syncProjectFolder creates or updates active project folder', async () => {
  const calls = [];
  const store = { projectPages: {} };

  const response = await syncProjectFolder({
    store,
    project: { id: 'project-1', name: 'Research', status: 'active' },
    selectedParentPageId: 'parent-page',
    ...createDependencies(calls),
  });

  assert.deepEqual(calls, [
    ['ensure-root', 'parent-page'],
    ['ensure-project', 'jot-root', 'Research'],
  ]);
  assert.equal(response.status, 'saved');
  assert.deepEqual(store.projectPages['project-1'], {
    notionPageId: 'project-page',
    parentPageId: 'jot-root',
    title: 'Research',
  });
});

test('syncProjectFolder archives mapped project folder', async () => {
  const calls = [];
  const store = {
    projectPages: {
      'project-1': {
        notionPageId: 'project-page',
        parentPageId: 'jot-root',
        title: 'Research',
      },
    },
  };

  const response = await syncProjectFolder({
    store,
    project: { id: 'project-1', name: 'Research', status: 'archived' },
    ...createDependencies(calls),
  });

  assert.deepEqual(calls, [['archive-project', 'project-page']]);
  assert.equal(response.status, 'saved');
  assert.equal(store.projectPages['project-1'], undefined);
});

test('syncProjectFolder treats archived project without Notion folder as saved', async () => {
  const calls = [];
  const store = { projectPages: {} };

  const response = await syncProjectFolder({
    store,
    project: { id: 'project-1', name: 'Research', status: 'archived' },
    ...createDependencies(calls),
  });

  assert.deepEqual(calls, []);
  assert.equal(response.status, 'saved');
});
