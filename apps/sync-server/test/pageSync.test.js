import assert from 'node:assert/strict';
import test from 'node:test';
import { pushPageToNotionCore } from '../src/pageSync.js';

test('pushPageToNotionCore returns stale before mutating when Notion revision changed', async () => {
  const calls = [];
  const store = {
    blockMappings: {},
    notePages: {
      'page-1': {
        notionPageId: 'notion-page-1',
      },
    },
  };
  const response = await pushPageToNotionCore({
    request: {},
    page: {
      id: 'page-1',
      title: 'Local title',
      content: { type: 'doc', content: [] },
      remoteRevision: 'older-revision',
    },
    project: { id: 'project-1', name: 'Project' },
    selectedParentPageId: 'parent-page',
    dependencies: {
      appendLog: (_store, event, message) => calls.push(['log', event, message]),
      createChildPage: async () => calls.push(['create-child']),
      ensureJotRootPage: async () => ({ id: 'jot-root', title: 'Jot' }),
      ensureProjectRootPage: async () => ({ id: 'project-root', title: 'Project' }),
      notionRequest: async () => ({
        id: 'notion-page-1',
        last_edited_time: 'newer-revision',
      }),
      replaceManagedBlocks: async () => calls.push(['replace-blocks']),
      requireConnectedStore: async () => store,
      updateChildNotePage: async () => calls.push(['update-page']),
      writeStore: async () => calls.push(['write-store']),
    },
  });

  assert.equal(response.status, 'stale');
  assert.equal(response.page.remoteRevision, 'newer-revision');
  assert.deepEqual(calls, [
    ['log', 'sync_stale', 'Local title changed in Notion.'],
    ['write-store'],
  ]);
});
