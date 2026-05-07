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

test('pushPageToNotionCore returns Notion file URL for uploaded image content', async () => {
  const store = {
    blockMappings: {},
    notePages: {},
  };
  const pageContent = {
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: {
          src: 'blob:chrome-extension://preview',
          notionFileUploadId: 'upload-id',
          uploadState: 'uploading',
        },
      },
    ],
  };
  const response = await pushPageToNotionCore({
    request: {},
    page: {
      id: 'page-1',
      title: 'Local title',
      content: pageContent,
    },
    project: { id: 'project-1', name: 'Project' },
    selectedParentPageId: 'parent-page',
    dependencies: {
      appendLog: () => undefined,
      createChildPage: async () => ({
        id: 'notion-page-1',
        last_edited_time: 'created-revision',
      }),
      ensureJotRootPage: async () => ({ id: 'jot-root', title: 'Jot' }),
      ensureProjectRootPage: async () => ({ id: 'project-root', title: 'Project' }),
      notionRequest: async () => ({
        id: 'notion-page-1',
        last_edited_time: 'synced-revision',
      }),
      replaceManagedBlocks: async () => ({
        createdBlocks: [
          {
            id: 'block-1',
            type: 'image',
            image: {
              type: 'file',
              file: {
                url: 'https://secure.notion-static.com/image.png',
              },
            },
          },
        ],
      }),
      requireConnectedStore: async () => store,
      updateChildNotePage: async () => undefined,
      writeStore: async () => undefined,
    },
  });

  assert.equal(response.status, 'saved');
  assert.deepEqual(response.page.content.content[0].attrs, {
    src: 'https://secure.notion-static.com/image.png',
    notionFileUploadId: 'upload-id',
    uploadState: 'done',
  });
});

test('pushPageToNotionCore returns Notion file URL for uploaded audio content', async () => {
  const store = {
    blockMappings: {},
    notePages: {},
  };
  const pageContent = {
    type: 'doc',
    content: [
      {
        type: 'audio',
        attrs: {
          src: 'blob:chrome-extension://recording',
          notionFileUploadId: 'audio-upload-id',
          uploadState: 'uploading',
        },
      },
    ],
  };
  const response = await pushPageToNotionCore({
    request: {},
    page: {
      id: 'page-1',
      title: 'Local title',
      content: pageContent,
    },
    project: { id: 'project-1', name: 'Project' },
    selectedParentPageId: 'parent-page',
    dependencies: {
      appendLog: () => undefined,
      createChildPage: async () => ({
        id: 'notion-page-1',
        last_edited_time: 'created-revision',
      }),
      ensureJotRootPage: async () => ({ id: 'jot-root', title: 'Jot' }),
      ensureProjectRootPage: async () => ({ id: 'project-root', title: 'Project' }),
      notionRequest: async () => ({
        id: 'notion-page-1',
        last_edited_time: 'synced-revision',
      }),
      replaceManagedBlocks: async () => ({
        createdBlocks: [
          {
            id: 'block-1',
            type: 'audio',
            audio: {
              type: 'file',
              file: {
                url: 'https://secure.notion-static.com/recording.mp3',
              },
            },
          },
        ],
      }),
      requireConnectedStore: async () => store,
      updateChildNotePage: async () => undefined,
      writeStore: async () => undefined,
    },
  });

  assert.equal(response.status, 'saved');
  assert.deepEqual(response.page.content.content[0].attrs, {
    src: 'https://secure.notion-static.com/recording.mp3',
    notionFileUploadId: 'audio-upload-id',
    uploadState: 'done',
  });
});
