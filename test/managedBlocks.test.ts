import { describe, expect, test, vi } from 'vitest';
import { applyManagedBlockOps } from '@/apps/worker/src/managedBlockOperations';
import { replaceManagedBlocks } from '@/apps/worker/src/managedBlocks';

describe('managed block snapshot replacement', () => {
  test('applies a reset and its block creates as one ordered queue batch', async () => {
    const store: { blockMappings: Record<string, Array<Record<string, unknown>>> } = {
      blockMappings: { 'local-page': [] },
    };
    const replaceManagedBlocks = vi.fn(async () => ({ createdBlocks: [] }));
    const appendManagedBlocks = vi.fn(async (_store, _pageId, blocks, _position) => [{
      id: `notion-${blocks[0].paragraph.id}`,
    }]);
    const queuedBlock = (id: string, index: number, afterInkwellBlockId?: string) => ({
      type: 'block_create',
      inkwellBlockId: id,
      payload: {
        block: { type: 'paragraph', attrs: { inkwellBlockId: id } },
        index,
        afterInkwellBlockId,
      },
    });

    await applyManagedBlockOps({
      store,
      localPageId: 'local-page',
      notionPageId: 'notion-page',
      ops: [
        { type: 'blocks_reset', payload: {} },
        queuedBlock('first', 0),
        queuedBlock('second', 1, 'first'),
      ],
      content: { type: 'doc', content: [] },
      appendManagedBlocks,
      deleteManagedBlock: vi.fn(),
      updateManagedBlock: vi.fn(),
      replaceManagedBlocks,
      listAllBlockChildren: vi.fn(async () => []),
      tiptapDocumentToNotionBlocks: vi.fn((content) => [{
        type: 'paragraph',
        paragraph: { id: content.content[0].attrs.inkwellBlockId },
      }]),
      kindFromNotionBlock: vi.fn(() => 'paragraph'),
      hash: vi.fn((value) => value),
    });

    expect(replaceManagedBlocks).toHaveBeenCalledWith(
      store,
      'local-page',
      'notion-page',
      {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { inkwellBlockId: 'first' } },
          { type: 'paragraph', attrs: { inkwellBlockId: 'second' } },
        ],
      },
    );
    expect(appendManagedBlocks).not.toHaveBeenCalled();
  });

  test('applies one queued create without dropping unrelated mappings', async () => {
    const store = {
      blockMappings: {
        'local-page': [{
          inkwellBlockId: 'existing',
          notionBlockId: 'notion-existing',
          order: 0,
        }],
      },
    };
    const appendManagedBlocks = vi.fn(async () => [{ id: 'notion-created' }]);

    await applyManagedBlockOps({
      store,
      localPageId: 'local-page',
      notionPageId: 'notion-page',
      ops: [{
        type: 'block_create',
        inkwellBlockId: 'created',
        payload: {
          block: { type: 'paragraph', attrs: { inkwellBlockId: 'created' } },
          index: 1,
          afterInkwellBlockId: 'existing',
        },
      }],
      content: { type: 'doc', content: [] },
      appendManagedBlocks,
      deleteManagedBlock: vi.fn(),
      updateManagedBlock: vi.fn(),
      replaceManagedBlocks: vi.fn(),
      listAllBlockChildren: vi.fn(async () => []),
      tiptapDocumentToNotionBlocks: vi.fn(() => [{ type: 'paragraph', paragraph: {} }]),
      kindFromNotionBlock: vi.fn(() => 'paragraph'),
      hash: vi.fn(() => 'created-hash'),
    });

    expect(store.blockMappings['local-page'].map((mapping) => mapping.inkwellBlockId)).toEqual([
      'existing',
      'created',
    ]);
    expect(appendManagedBlocks).toHaveBeenCalledWith(
      store,
      'notion-page',
      [{ type: 'paragraph', paragraph: {} }],
      { type: 'after_block', after_block: { id: 'notion-existing' } },
    );
  });

  test('recovers a block already written before a queue retry', async () => {
    const store = { blockMappings: { 'local-page': [] } };
    const existingRemoteBlock = {
      id: 'remote-created-before-timeout',
      type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: { content: 'Durable note', link: null },
          plain_text: 'Durable note',
          href: null,
        }],
      },
    } as never;
    const appendManagedBlocks = vi.fn();

    await applyManagedBlockOps({
      store,
      localPageId: 'local-page',
      notionPageId: 'notion-page',
      ops: [{
        type: 'block_create',
        inkwellBlockId: 'durable-note',
        payload: {
          block: { type: 'paragraph', attrs: { inkwellBlockId: 'durable-note' } },
          index: 0,
        },
      }],
      content: { type: 'doc', content: [] },
      appendManagedBlocks,
      deleteManagedBlock: vi.fn(),
      updateManagedBlock: vi.fn(),
      replaceManagedBlocks: vi.fn(),
      listAllBlockChildren: vi.fn(async () => [existingRemoteBlock]),
      tiptapDocumentToNotionBlocks: vi.fn(() => [{
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: 'Durable note' } }] },
      }]),
      kindFromNotionBlock: vi.fn(() => 'paragraph'),
      hash: vi.fn(() => 'durable-hash'),
    });

    expect(appendManagedBlocks).not.toHaveBeenCalled();
    expect(store.blockMappings['local-page'][0].notionBlockId).toBe(
      'remote-created-before-timeout',
    );
  });

  test('ignores an empty replacement snapshot and preserves known mappings', async () => {
    const store = {
      blockMappings: {
        'local-page': [{
          inkwellBlockId: 'block-one',
          notionBlockId: 'duplicated-notion-block',
        }],
      },
    };
    const replaceManagedBlocks = vi.fn(async () => ({ createdBlocks: [] }));

    await applyManagedBlockOps({
      store,
      localPageId: 'local-page',
      notionPageId: 'notion-page',
      ops: [{
        type: 'block_reorder',
        payload: { replaceAll: true },
      }],
      content: { type: 'doc', content: [] },
      appendManagedBlocks: vi.fn(),
      deleteManagedBlock: vi.fn(),
      updateManagedBlock: vi.fn(),
      replaceManagedBlocks,
      listAllBlockChildren: vi.fn(async () => []),
      tiptapDocumentToNotionBlocks: vi.fn(),
      kindFromNotionBlock: vi.fn(),
      hash: vi.fn(),
    });

    expect(store.blockMappings['local-page']).toHaveLength(1);
    expect(replaceManagedBlocks).not.toHaveBeenCalled();
  });
});

describe('managed block replacement safety', () => {
  test('an empty snapshot never deletes existing Notion content', async () => {
    const existingMapping = {
      inkwellBlockId: 'block-one',
      localNodeId: 'block-one',
      localPageId: 'local-page',
      notionBlockId: 'notion-block-one',
      kind: 'paragraph',
      order: 0,
      lastSyncedHash: 'known-hash',
      oldState: null,
      newState: null,
    };
    const store = { blockMappings: { 'local-page': [existingMapping] } };
    const deleteManagedBlock = vi.fn();

    await replaceManagedBlocks({
      store,
      localPageId: 'local-page',
      notionPageId: 'notion-page',
      content: { type: 'doc', content: [] },
      listAllBlockChildren: vi.fn(async () => []),
      deleteManagedBlock,
      appendManagedBlocks: vi.fn(),
      updateManagedBlock: vi.fn(),
      tiptapDocumentToNotionBlocks: vi.fn(() => []),
      kindFromNotionBlock: vi.fn(() => 'paragraph'),
      hash: vi.fn(() => 'hash'),
    });

    expect(deleteManagedBlock).not.toHaveBeenCalled();
    expect(store.blockMappings['local-page']).toEqual([existingMapping]);
  });

  test('adopts an already-written ordered snapshot without deleting or duplicating it', async () => {
    const existingBlocks = [
      { id: 'remote-one', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'First', link: null }, plain_text: 'First', href: null }] } },
      { id: 'remote-two', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'Second', link: null }, plain_text: 'Second', href: null }] } },
    ] as never[];
    const store = { blockMappings: {} };
    const appendManagedBlocks = vi.fn();
    const deleteManagedBlock = vi.fn();

    await replaceManagedBlocks({
      store,
      localPageId: 'local-page',
      notionPageId: 'notion-page',
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { inkwellBlockId: 'first' }, content: [{ type: 'text', text: 'First' }] },
          { type: 'paragraph', attrs: { inkwellBlockId: 'second' }, content: [{ type: 'text', text: 'Second' }] },
        ],
      },
      listAllBlockChildren: vi.fn(async () => existingBlocks),
      deleteManagedBlock,
      appendManagedBlocks,
      updateManagedBlock: vi.fn(),
      tiptapDocumentToNotionBlocks: vi.fn((_content) => [
        { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'First' } }] } },
        { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'Second' } }] } },
      ]),
      kindFromNotionBlock: vi.fn(() => 'paragraph'),
      hash: vi.fn((value) => value),
    });

    expect(appendManagedBlocks).not.toHaveBeenCalled();
    expect(deleteManagedBlock).not.toHaveBeenCalled();
    expect(store.blockMappings['local-page'].map((mapping) => mapping.notionBlockId)).toEqual([
      'remote-one',
      'remote-two',
    ]);
  });

  test('stops safely when unmapped remote content does not match the local snapshot', async () => {
    const existingBlocks = [{
      id: 'unmapped-user-content',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: 'Keep this note' } }] },
    }] as never[];
    const deleteManagedBlock = vi.fn();
    const appendManagedBlocks = vi.fn();

    await expect(replaceManagedBlocks({
      store: { blockMappings: {} },
      localPageId: 'local-page',
      notionPageId: 'notion-page',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Different local note' }] }],
      },
      listAllBlockChildren: vi.fn(async () => existingBlocks),
      deleteManagedBlock,
      appendManagedBlocks,
      updateManagedBlock: vi.fn(),
      tiptapDocumentToNotionBlocks: vi.fn(() => [{
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: 'Different local note' } }] },
      }]),
      kindFromNotionBlock: vi.fn(() => 'paragraph'),
      hash: vi.fn(() => 'hash'),
    })).rejects.toThrow('Existing content was preserved');

    expect(deleteManagedBlock).not.toHaveBeenCalled();
    expect(appendManagedBlocks).not.toHaveBeenCalled();
  });

  test('stages reordered blocks before deleting the old range', async () => {
    const oldBlocks = [
      { id: 'old-a', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'A' } }] } },
      { id: 'old-b', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'B' } }] } },
    ] as never[];
    const store = {
      blockMappings: {
        'local-page': [
          { inkwellBlockId: 'a', localNodeId: 'a', localPageId: 'local-page', notionBlockId: 'old-a', kind: 'paragraph', order: 0, lastSyncedHash: 'a', oldState: null, newState: null },
          { inkwellBlockId: 'b', localNodeId: 'b', localPageId: 'local-page', notionBlockId: 'old-b', kind: 'paragraph', order: 1, lastSyncedHash: 'b', oldState: null, newState: null },
        ],
      },
    };
    const operations: string[] = [];
    const deleteManagedBlock = vi.fn(async (_store, blockId) => {
      operations.push(`delete:${blockId}`);
      const index = oldBlocks.findIndex((block) => block.id === blockId);
      if (index >= 0) oldBlocks.splice(index, 1);
    });
    let nextRemoteId = 0;
    const appendManagedBlocks = vi.fn(async (_store, _pageId, blocks, position) => {
      operations.push('append');
      const created = {
        id: `new-${++nextRemoteId}`,
        type: blocks[0].type,
        [blocks[0].type]: blocks[0][blocks[0].type],
      };
      void position;
      return [created];
    });

    await replaceManagedBlocks({
      store,
      localPageId: 'local-page',
      notionPageId: 'notion-page',
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { inkwellBlockId: 'b' }, content: [{ type: 'text', text: 'B' }] },
          { type: 'paragraph', attrs: { inkwellBlockId: 'a' }, content: [{ type: 'text', text: 'A' }] },
        ],
      },
      listAllBlockChildren: vi.fn(async () => oldBlocks),
      deleteManagedBlock,
      appendManagedBlocks,
      updateManagedBlock: vi.fn(),
      tiptapDocumentToNotionBlocks: vi.fn((content) => content.content.map((node) => ({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: node.content[0].text } }] },
      }))),
      kindFromNotionBlock: vi.fn(() => 'paragraph'),
      hash: vi.fn((value) => value),
    });

    expect(operations[0]).toBe('append');
    expect(operations.indexOf('delete:old-a')).toBeGreaterThan(operations.indexOf('append'));
    expect(operations.indexOf('delete:old-b')).toBeGreaterThan(operations.indexOf('append'));
    expect(oldBlocks.map((block) => block.paragraph.rich_text[0].text.content)).toEqual(['B', 'A']);
  });
});
