import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceManagedBlocks } from '../src/managedBlocks.js';

function paragraph(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: text } }],
      color: 'default',
    },
  };
}

function quote(text) {
  return {
    object: 'block',
    type: 'quote',
    quote: {
      rich_text: [{ type: 'text', text: { content: text } }],
      color: 'default',
    },
  };
}

function doc(...nodes) {
  return {
    type: 'doc',
    content: nodes,
  };
}

function node(id, text, type = 'paragraph') {
  return {
    type,
    attrs: { jotBlockId: id },
    content: text ? [{ type: 'text', text }] : undefined,
  };
}

function createDependencies(notionBlocks, overrides = {}) {
  const calls = [];

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
      appendManagedBlocks: async (_store, pageId, blocks, position) => {
        calls.push(['append', pageId, blocks, position]);
        return blocks.map((_block, index) => ({ id: `new-block-${calls.length}-${index}` }));
      },
      updateManagedBlock: async (_store, blockId, block) => {
        calls.push(['update', blockId, block]);
        return { id: blockId };
      },
      tiptapDocumentToNotionBlocks: () => notionBlocks,
      kindFromNotionBlock: (block) => {
        if (block.type === 'quote') return 'quote';
        if (block.type === 'divider') return 'divider';
        return block.type === 'paragraph' ? 'paragraph' : block.type;
      },
      hash: (value) => `hash:${value}`,
      ...overrides,
    },
  };
}

test('replaceManagedBlocks deletes existing blocks before appending current content on first sync', async () => {
  const store = { blockMappings: {} };
  const notionBlocks = [paragraph('One'), quote('Two')];
  const { calls, dependencies } = createDependencies(notionBlocks);

  await replaceManagedBlocks({
    store,
    localPageId: 'local-page',
    notionPageId: 'notion-page',
    content: doc(node('block-a', 'One'), node('block-b', 'Two', 'blockquote')),
    ...dependencies,
  });

  assert.deepEqual(calls, [
    ['delete', 'old-block-1'],
    ['delete', 'old-block-2'],
    ['append', 'notion-page', notionBlocks, undefined],
  ]);
  assert.deepEqual(store.blockMappings['local-page'].map((mapping) => ({
    jotBlockId: mapping.jotBlockId,
    notionBlockId: mapping.notionBlockId,
    kind: mapping.kind,
    order: mapping.order,
  })), [
    { jotBlockId: 'block-a', notionBlockId: 'new-block-3-0', kind: 'paragraph', order: 0 },
    { jotBlockId: 'block-b', notionBlockId: 'new-block-3-1', kind: 'quote', order: 1 },
  ]);
});

test('replaceManagedBlocks does nothing when block hashes are unchanged', async () => {
  const notionBlocks = [paragraph('One'), paragraph('Two')];
  const store = {
    blockMappings: {
      'local-page': notionBlocks.map((block, index) => ({
        localPageId: 'local-page',
        jotBlockId: `block-${index + 1}`,
        localNodeId: `block-${index + 1}`,
        notionBlockId: `notion-${index + 1}`,
        kind: 'paragraph',
        order: index,
        lastSyncedHash: `hash:${JSON.stringify(block)}`,
        newState: block,
      })),
    },
  };
  const { calls, dependencies } = createDependencies(notionBlocks);

  await replaceManagedBlocks({
    store,
    localPageId: 'local-page',
    notionPageId: 'notion-page',
    content: doc(node('block-1', 'One'), node('block-2', 'Two')),
    ...dependencies,
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(store.blockMappings['local-page'].map((mapping) => mapping.notionBlockId), [
    'notion-1',
    'notion-2',
  ]);
});

test('replaceManagedBlocks updates only the changed compatible block', async () => {
  const oldBlocks = [paragraph('One'), paragraph('Two')];
  const nextBlocks = [paragraph('One changed'), paragraph('Two')];
  const store = {
    blockMappings: {
      'local-page': oldBlocks.map((block, index) => ({
        localPageId: 'local-page',
        jotBlockId: `block-${index + 1}`,
        notionBlockId: `notion-${index + 1}`,
        kind: 'paragraph',
        order: index,
        lastSyncedHash: `hash:${JSON.stringify(block)}`,
        newState: block,
      })),
    },
  };
  const { calls, dependencies } = createDependencies(nextBlocks);

  await replaceManagedBlocks({
    store,
    localPageId: 'local-page',
    notionPageId: 'notion-page',
    content: doc(node('block-1', 'One changed'), node('block-2', 'Two')),
    ...dependencies,
  });

  assert.deepEqual(calls, [['update', 'notion-1', nextBlocks[0]]]);
  assert.equal(store.blockMappings['local-page'][0].notionBlockId, 'notion-1');
  assert.equal(store.blockMappings['local-page'][1].notionBlockId, 'notion-2');
});

test('replaceManagedBlocks inserts a new typed block after the previous mapped block', async () => {
  const oldBlocks = [paragraph('One'), paragraph('Three')];
  const nextBlocks = [paragraph('One'), paragraph('Two'), paragraph('Three')];
  const store = {
    blockMappings: {
      'local-page': [
        {
          localPageId: 'local-page',
          jotBlockId: 'block-1',
          notionBlockId: 'notion-1',
          kind: 'paragraph',
          order: 0,
          lastSyncedHash: `hash:${JSON.stringify(oldBlocks[0])}`,
          newState: oldBlocks[0],
        },
        {
          localPageId: 'local-page',
          jotBlockId: 'block-3',
          notionBlockId: 'notion-3',
          kind: 'paragraph',
          order: 1,
          lastSyncedHash: `hash:${JSON.stringify(oldBlocks[1])}`,
          newState: oldBlocks[1],
        },
      ],
    },
  };
  const { calls, dependencies } = createDependencies(nextBlocks);

  await replaceManagedBlocks({
    store,
    localPageId: 'local-page',
    notionPageId: 'notion-page',
    content: doc(node('block-1', 'One'), node('block-2', 'Two'), node('block-3', 'Three')),
    ...dependencies,
  });

  assert.deepEqual(calls, [
    [
      'append',
      'notion-page',
      [nextBlocks[1]],
      { type: 'after_block', after_block: { id: 'notion-1' } },
    ],
  ]);
});

test('replaceManagedBlocks deletes removed blocks', async () => {
  const oldBlocks = [paragraph('One'), paragraph('Two')];
  const nextBlocks = [paragraph('One')];
  const store = {
    blockMappings: {
      'local-page': oldBlocks.map((block, index) => ({
        localPageId: 'local-page',
        jotBlockId: `block-${index + 1}`,
        notionBlockId: `notion-${index + 1}`,
        kind: 'paragraph',
        order: index,
        lastSyncedHash: `hash:${JSON.stringify(block)}`,
        newState: block,
      })),
    },
  };
  const { calls, dependencies } = createDependencies(nextBlocks);

  await replaceManagedBlocks({
    store,
    localPageId: 'local-page',
    notionPageId: 'notion-page',
    content: doc(node('block-1', 'One')),
    ...dependencies,
  });

  assert.deepEqual(calls, [['delete', 'notion-2']]);
});

test('replaceManagedBlocks replaces a block when its Notion kind changes', async () => {
  const oldBlock = paragraph('One');
  const nextBlock = quote('One');
  const store = {
    blockMappings: {
      'local-page': [
        {
          localPageId: 'local-page',
          jotBlockId: 'block-1',
          notionBlockId: 'notion-1',
          kind: 'paragraph',
          order: 0,
          lastSyncedHash: `hash:${JSON.stringify(oldBlock)}`,
          newState: oldBlock,
        },
      ],
    },
  };
  const { calls, dependencies } = createDependencies([nextBlock]);

  await replaceManagedBlocks({
    store,
    localPageId: 'local-page',
    notionPageId: 'notion-page',
    content: doc(node('block-1', 'One', 'blockquote')),
    ...dependencies,
  });

  assert.deepEqual(calls, [
    ['delete', 'notion-1'],
    ['append', 'notion-page', [nextBlock], { type: 'start' }],
  ]);
});

test('replaceManagedBlocks rebuilds the affected range when blocks are reordered', async () => {
  const oldBlocks = [paragraph('A'), paragraph('B'), paragraph('C')];
  const nextBlocks = [paragraph('B'), paragraph('A'), paragraph('C')];
  const store = {
    blockMappings: {
      'local-page': oldBlocks.map((block, index) => ({
        localPageId: 'local-page',
        jotBlockId: ['a', 'b', 'c'][index],
        notionBlockId: `notion-${['a', 'b', 'c'][index]}`,
        kind: 'paragraph',
        order: index,
        lastSyncedHash: `hash:${JSON.stringify(block)}`,
        newState: block,
      })),
    },
  };
  const { calls, dependencies } = createDependencies(nextBlocks);

  await replaceManagedBlocks({
    store,
    localPageId: 'local-page',
    notionPageId: 'notion-page',
    content: doc(node('b', 'B'), node('a', 'A'), node('c', 'C')),
    ...dependencies,
  });

  assert.deepEqual(calls, [
    ['delete', 'notion-a'],
    ['delete', 'notion-b'],
    ['append', 'notion-page', [nextBlocks[0], nextBlocks[1]], { type: 'start' }],
  ]);
  assert.deepEqual(store.blockMappings['local-page'].map((mapping) => mapping.jotBlockId), [
    'b',
    'a',
    'c',
  ]);
});
