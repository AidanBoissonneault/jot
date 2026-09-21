import { describe, expect, test, vi } from 'vitest';
import { applyManagedBlockOps } from '@/apps/worker/src/managedBlocks';

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
      { type: 'doc', content: [] },
    );
    expect(store.blockMappings['local-page'].map((mapping) => mapping.inkwellBlockId)).toEqual([
      'first',
      'second',
    ]);
    expect(appendManagedBlocks.mock.calls[1][3]).toEqual({
      type: 'after_block',
      after_block: { id: 'notion-first' },
    });
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

  test('clears stale mappings so a full snapshot also removes untracked duplicates', async () => {
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
      tiptapDocumentToNotionBlocks: vi.fn(),
      kindFromNotionBlock: vi.fn(),
      hash: vi.fn(),
    });

    expect(store.blockMappings['local-page']).toEqual([]);
    expect(replaceManagedBlocks).toHaveBeenCalledWith(
      store,
      'local-page',
      'notion-page',
      { type: 'doc', content: [] },
    );
  });
});
