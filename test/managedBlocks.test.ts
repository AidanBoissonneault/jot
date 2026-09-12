import { describe, expect, test, vi } from 'vitest';
import { applyManagedBlockOps } from '@/apps/worker/src/managedBlocks';

describe('managed block snapshot replacement', () => {
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
