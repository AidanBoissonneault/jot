import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceManagedBlocks } from '../src/managedBlocks.js';

function createDependencies(overrides = {}) {
  const calls = [];
  const notionBlocks = [
    { type: 'paragraph', paragraph: { rich_text: [] } },
    { type: 'quote', quote: { rich_text: [] } },
  ];

  return {
    calls,
    dependencies: {
      listAllBlockChildren: async () => [
        { id: 'old-block-1' },
        { id: 'old-block-2' },
      ],
      deleteManagedBlock: async (_store, blockId) => {
        calls.push(['delete', blockId]);
      },
      appendManagedBlocks: async (_store, pageId, blocks) => {
        calls.push(['append', pageId, blocks]);
        return [{ id: 'new-block-1' }, { id: 'new-block-2' }];
      },
      tiptapDocumentToNotionBlocks: () => notionBlocks,
      kindFromNotionBlock: (block) => block.type,
      hash: (value) => `hash:${value}`,
      ...overrides,
    },
  };
}

test('replaceManagedBlocks deletes existing blocks before appending current content', async () => {
  const store = { blockMappings: {} };
  const { calls, dependencies } = createDependencies();

  await replaceManagedBlocks({
    store,
    localPageId: 'local-page',
    notionPageId: 'notion-page',
    content: { type: 'doc', content: [] },
    ...dependencies,
  });

  assert.deepEqual(calls, [
    ['delete', 'old-block-1'],
    ['delete', 'old-block-2'],
    [
      'append',
      'notion-page',
      [
        { type: 'paragraph', paragraph: { rich_text: [] } },
        { type: 'quote', quote: { rich_text: [] } },
      ],
    ],
  ]);
  assert.deepEqual(store.blockMappings['local-page'], [
    {
      localPageId: 'local-page',
      localNodeId: 'block-0',
      notionBlockId: 'new-block-1',
      kind: 'paragraph',
      lastSyncedHash: 'hash:{"type":"paragraph","paragraph":{"rich_text":[]}}',
    },
    {
      localPageId: 'local-page',
      localNodeId: 'block-1',
      notionBlockId: 'new-block-2',
      kind: 'quote',
      lastSyncedHash: 'hash:{"type":"quote","quote":{"rich_text":[]}}',
    },
  ]);
});

test('replaceManagedBlocks does not append when deleting an existing block fails', async () => {
  const store = { blockMappings: { 'local-page': [{ notionBlockId: 'previous' }] } };
  const { calls, dependencies } = createDependencies({
    deleteManagedBlock: async (_store, blockId) => {
      calls.push(['delete', blockId]);
      if (blockId === 'old-block-2') {
        throw new Error('Notion refused to delete the block.');
      }
    },
  });

  await assert.rejects(
    replaceManagedBlocks({
      store,
      localPageId: 'local-page',
      notionPageId: 'notion-page',
      content: { type: 'doc', content: [] },
      ...dependencies,
    }),
    /Notion refused/,
  );

  assert.deepEqual(calls, [
    ['delete', 'old-block-1'],
    ['delete', 'old-block-2'],
  ]);
  assert.deepEqual(store.blockMappings['local-page'], [{ notionBlockId: 'previous' }]);
});
