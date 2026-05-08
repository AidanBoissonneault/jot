import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { kindFromNotionBlock, tiptapDocumentToNotionBlocks } from '../src/blockConversion.js';
import { importManagedBlocks } from '../src/importManagedBlocks.js';
import { replaceManagedBlocks } from '../src/managedBlocks.js';

function paragraphBlock(id, text) {
  return {
    id,
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        {
          plain_text: text,
          annotations: {},
        },
      ],
      color: 'default',
    },
  };
}

function imageBlock(id, url) {
  return {
    id,
    object: 'block',
    type: 'image',
    image: {
      type: 'file',
      file: {
        url,
      },
    },
  };
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('importManagedBlocks imports a Notion-added image and maps it for unchanged pushes', async () => {
  const children = [
    paragraphBlock('notion-paragraph', 'Existing text'),
    imageBlock('notion-image', 'https://secure.notion-static.com/image.png'),
  ];
  const store = {
    blockMappings: {
      'page-1': [
        {
          localPageId: 'page-1',
          jotBlockId: 'existing-jot-block',
          localNodeId: 'existing-jot-block',
          notionBlockId: 'notion-paragraph',
          kind: 'paragraph',
          order: 0,
          lastSyncedHash: 'old-hash',
        },
      ],
    },
  };

  const imported = await importManagedBlocks({
    hash,
    listAllBlockChildren: async () => children,
    page: {
      id: 'page-1',
      notionPageId: 'notion-page',
    },
    store,
  });

  assert.equal(imported.content.length, 2);
  assert.equal(imported.content[0].attrs.jotBlockId, 'existing-jot-block');
  assert.equal(imported.content[1].type, 'image');
  assert.equal(imported.content[1].attrs.src, 'https://secure.notion-static.com/image.png');
  assert.match(imported.content[1].attrs.jotBlockId, /^jot-block-/);
  assert.deepEqual(store.blockMappings['page-1'].map((mapping) => ({
    jotBlockId: mapping.jotBlockId,
    notionBlockId: mapping.notionBlockId,
    kind: mapping.kind,
    order: mapping.order,
  })), [
    {
      jotBlockId: 'existing-jot-block',
      notionBlockId: 'notion-paragraph',
      kind: 'paragraph',
      order: 0,
    },
    {
      jotBlockId: imported.content[1].attrs.jotBlockId,
      notionBlockId: 'notion-image',
      kind: 'media',
      order: 1,
    },
  ]);

  const calls = [];
  const notionBlocks = tiptapDocumentToNotionBlocks(imported);
  await replaceManagedBlocks({
    store,
    localPageId: 'page-1',
    notionPageId: 'notion-page',
    content: imported,
    listAllBlockChildren: async () => children,
    deleteManagedBlock: async (_store, blockId) => calls.push(['delete', blockId]),
    appendManagedBlocks: async (_store, pageId, blocks, position) => {
      calls.push(['append', pageId, blocks, position]);
      return blocks.map((block, index) => ({ ...block, id: `new-${index}` }));
    },
    updateManagedBlock: async (_store, blockId, block) => calls.push(['update', blockId, block]),
    tiptapDocumentToNotionBlocks,
    kindFromNotionBlock,
    hash,
  });

  assert.deepEqual(notionBlocks.map((block) => block.type), ['paragraph', 'image']);
  assert.deepEqual(calls, []);
});

test('importManagedBlocks returns null when Notion has unsupported child blocks', async () => {
  const store = { blockMappings: {} };
  const imported = await importManagedBlocks({
    listAllBlockChildren: async () => [
      paragraphBlock('notion-paragraph', 'Existing text'),
      {
        id: 'notion-table',
        object: 'block',
        type: 'table',
        table: {},
      },
    ],
    page: {
      id: 'page-1',
      notionPageId: 'notion-page',
    },
    store,
  });

  assert.equal(imported, null);
  assert.deepEqual(store.blockMappings, {});
});
