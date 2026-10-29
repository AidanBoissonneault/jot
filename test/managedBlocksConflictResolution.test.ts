import { describe, expect, it, vi } from 'vitest';
import { applyManagedBlockOps } from '@/apps/worker/src/managedBlockOperations';
import { replaceManagedBlocks } from '@/apps/worker/src/managedBlocks';

function notionParagraph(text: string) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function remoteParagraph(id: string, text: string) {
  return {
    id,
    type: 'paragraph',
    paragraph: {
      rich_text: [{
        type: 'text',
        text: { content: text, link: null },
        plain_text: text,
        href: null,
      }],
    },
  };
}

function localParagraph(id: string, text: string, notionId?: string) {
  return {
    type: 'paragraph',
    attrs: { jottathingBlockId: id, ...(notionId ? { notionBlockId: notionId } : {}) },
    content: [{ type: 'text', text }],
  };
}

function reviewedContent(
  blocks: ReturnType<typeof localParagraph>[],
  deleteIds?: string[],
) {
  return {
    type: 'doc',
    attrs: {
      jottathingConflictResolution: true,
      jottathingPreserveRemoteBlocks: true,
      ...(deleteIds ? { jottathingDeleteNotionBlockIds: deleteIds } : {}),
    },
    content: blocks,
  };
}

function runReviewedMerge({
  content,
  remoteBlocks,
  mappings = [],
  appendManagedBlocks = vi.fn(async () => []),
  deleteManagedBlock = vi.fn(async () => undefined),
  updateManagedBlock = vi.fn(async () => undefined),
}: {
  content: ReturnType<typeof reviewedContent>;
  remoteBlocks: ReturnType<typeof remoteParagraph>[];
  mappings?: Record<string, unknown>[];
  appendManagedBlocks?: ReturnType<typeof vi.fn>;
  deleteManagedBlock?: ReturnType<typeof vi.fn>;
  updateManagedBlock?: ReturnType<typeof vi.fn>;
}) {
  const store = { blockMappings: { 'local-page': mappings } };
  const listAllBlockChildren = vi.fn(async () => remoteBlocks);
  const result = replaceManagedBlocks({
    store: store as never,
    localPageId: 'local-page',
    notionPageId: 'notion-page',
    content,
    listAllBlockChildren,
    appendManagedBlocks,
    deleteManagedBlock,
    updateManagedBlock,
    tiptapDocumentToNotionBlocks: (document) => (document.content ?? []).map((node) =>
      notionParagraph(node.content?.[0]?.text ?? '') as never,
    ),
    kindFromNotionBlock: ({ type }) => type,
    hash: (value) => value,
  });
  return { result, store, listAllBlockChildren, appendManagedBlocks, deleteManagedBlock, updateManagedBlock };
}

function runGranularUpdate({
  localText,
  remoteBlocks,
  conflictResolution = false,
}: {
  localText: string;
  remoteBlocks: ReturnType<typeof remoteParagraph>[];
  conflictResolution?: boolean;
}) {
  const baseState = notionParagraph('Before');
  const localBlock = localParagraph('local-a', localText);
  if (conflictResolution) localBlock.attrs.jottathingConflictResolution = true;
  const store = {
    blockMappings: {
      'local-page': [{
        localPageId: 'local-page',
        jottathingBlockId: 'local-a',
        localNodeId: 'local-a',
        notionBlockId: 'remote-a',
        kind: 'paragraph',
        order: 0,
        lastSyncedHash: 'before-hash',
        oldState: baseState,
        newState: baseState,
      }],
    },
  };
  const updateManagedBlock = vi.fn(async () => undefined);
  const listAllBlockChildren = vi.fn(async () => remoteBlocks);
  const result = applyManagedBlockOps({
    store: store as never,
    localPageId: 'local-page',
    notionPageId: 'notion-page',
    ops: [{
      type: 'block_update',
      jottathingBlockId: 'local-a',
      payload: { block: localBlock },
    }],
    content: { type: 'doc', content: [localBlock] },
    appendManagedBlocks: vi.fn(async () => []),
    deleteManagedBlock: vi.fn(async () => undefined),
    updateManagedBlock,
    replaceManagedBlocks: vi.fn(async () => ({ createdBlocks: [] })),
    listAllBlockChildren,
    tiptapDocumentToNotionBlocks: () => [notionParagraph(localText) as never],
    kindFromNotionBlock: ({ type }) => type,
    hash: () => 'after-hash',
  });
  return { result, store, updateManagedBlock, listAllBlockChildren };
}

describe('reviewed conflict merge block reconciliation', () => {
  it('keeps untouched remote blocks and places new blocks after the selected block', async () => {
    const appendManagedBlocks = vi.fn(async (_store, _pageId, blocks, position) => [
      remoteParagraph('remote-new', blocks[0].paragraph.rich_text[0].text.content),
    ]);
    const { result, store, deleteManagedBlock } = runReviewedMerge({
      content: reviewedContent([
        localParagraph('local-a', 'Keep A', 'remote-a'),
        localParagraph('local-new', 'New block'),
      ]),
      remoteBlocks: [remoteParagraph('remote-a', 'Keep A'), remoteParagraph('remote-b', 'Keep B')],
      appendManagedBlocks,
    });

    await result;
    expect(appendManagedBlocks).toHaveBeenCalledWith(
      store,
      'notion-page',
      [notionParagraph('New block')],
      { type: 'after_block', after_block: { id: 'remote-a' } },
    );
    expect(deleteManagedBlock).not.toHaveBeenCalled();
    expect(store.blockMappings['local-page'].map((mapping) => mapping.notionBlockId)).toEqual([
      'remote-a', 'remote-new',
    ]);
  });

  it('updates a reviewed mapped block in place when its Notion type still matches', async () => {
    const mapping = {
      localPageId: 'local-page',
      jottathingBlockId: 'local-a',
      localNodeId: 'local-a',
      notionBlockId: 'remote-a',
      kind: 'paragraph',
      order: 0,
      lastSyncedHash: 'old-hash',
      oldState: notionParagraph('Before'),
      newState: notionParagraph('Before'),
    };
    const { result, updateManagedBlock, appendManagedBlocks, deleteManagedBlock, store } = runReviewedMerge({
      content: reviewedContent([localParagraph('local-a', 'After')]),
      remoteBlocks: [remoteParagraph('remote-a', 'Before')],
      mappings: [mapping],
    });

    await result;
    expect(updateManagedBlock).toHaveBeenCalledWith(store, 'remote-a', notionParagraph('After'));
    expect(appendManagedBlocks).not.toHaveBeenCalled();
    expect(deleteManagedBlock).not.toHaveBeenCalled();
    expect(store.blockMappings['local-page'][0]).toMatchObject({
      notionBlockId: 'remote-a',
      newState: notionParagraph('After'),
    });
  });

  it("replaces a reviewed block when Notion's current type cannot be updated in place", async () => {
    const mapping = {
      localPageId: 'local-page',
      jottathingBlockId: 'local-a',
      localNodeId: 'local-a',
      notionBlockId: 'remote-a',
      kind: 'heading_1',
      order: 0,
      lastSyncedHash: 'old-hash',
      oldState: { type: 'heading_1' },
      newState: { type: 'heading_1' },
    };
    const operations: string[] = [];
    const appendManagedBlocks = vi.fn(async () => {
      operations.push('append');
      return [remoteParagraph('remote-replacement', 'New paragraph')];
    });
    const deleteManagedBlock = vi.fn(async () => { operations.push('delete'); });
    const { result, store } = runReviewedMerge({
      content: reviewedContent([localParagraph('local-a', 'New paragraph')]),
      remoteBlocks: [{ id: 'remote-a', type: 'heading_1', heading_1: {} } as never],
      mappings: [mapping],
      appendManagedBlocks,
      deleteManagedBlock,
    });

    await result;
    expect(operations).toEqual(['append', 'delete']);
    expect(deleteManagedBlock).toHaveBeenCalledWith(store, 'remote-a');
    expect(store.blockMappings['local-page'][0].notionBlockId).toBe('remote-replacement');
  });

  it('deletes only confirmed, unselected blocks explicitly removed by the user', async () => {
    const { result, deleteManagedBlock, store } = runReviewedMerge({
      content: reviewedContent(
        [localParagraph('local-a', 'Keep A', 'remote-a')],
        ['remote-a', 'remote-b', 'missing'],
      ),
      remoteBlocks: [remoteParagraph('remote-a', 'Keep A'), remoteParagraph('remote-b', 'Remove B')],
    });

    await result;
    expect(deleteManagedBlock).toHaveBeenCalledOnce();
    expect(deleteManagedBlock).toHaveBeenCalledWith(store, 'remote-b');
  });

  it('discovers an appended block after an incomplete Notion append response', async () => {
    let currentBlocks: ReturnType<typeof remoteParagraph>[] = [];
    const createdBlock = remoteParagraph('remote-created', 'New block');
    const listAllBlockChildren = vi.fn(async () => currentBlocks);
    const appendManagedBlocks = vi.fn(async () => {
      currentBlocks = [createdBlock];
      return [];
    });
    const store = { blockMappings: { 'local-page': [] } };
    const result = replaceManagedBlocks({
      store: store as never,
      localPageId: 'local-page',
      notionPageId: 'notion-page',
      content: reviewedContent([localParagraph('local-new', 'New block')]),
      listAllBlockChildren,
      appendManagedBlocks,
      deleteManagedBlock: vi.fn(),
      updateManagedBlock: vi.fn(),
      tiptapDocumentToNotionBlocks: () => [notionParagraph('New block') as never],
      kindFromNotionBlock: ({ type }) => type,
      hash: (value) => value,
    });

    await result;
    expect(listAllBlockChildren).toHaveBeenCalledTimes(2);
    expect(appendManagedBlocks).toHaveBeenCalledOnce();
    expect(store.blockMappings['local-page'][0].notionBlockId).toBe('remote-created');
  });
});

describe('granular conflict resolution races', () => {
  it('stops when Notion changes after the reviewed merge was prepared', async () => {
    const { result, updateManagedBlock } = runGranularUpdate({
      localText: 'Local edit',
      remoteBlocks: [remoteParagraph('remote-a', 'Remote edit')],
    });

    await expect(result).rejects.toMatchObject({
      name: 'UnmappedNotionContentError',
      code: 'unmapped_notion_content',
    });
    expect(updateManagedBlock).not.toHaveBeenCalled();
  });

  it('accepts the current Notion state when the operation carries the reviewed marker', async () => {
    const { result, updateManagedBlock, store } = runGranularUpdate({
      localText: 'Reviewed edit',
      remoteBlocks: [remoteParagraph('remote-a', 'Remote edit')],
      conflictResolution: true,
    });

    await result;
    expect(updateManagedBlock).toHaveBeenCalledWith(
      store,
      'remote-a',
      notionParagraph('Reviewed edit'),
    );
  });

  it('reattaches a missing mapping to an already-present block before updating', async () => {
    const { result, updateManagedBlock, store } = runGranularUpdate({
      localText: 'Recovered edit',
      remoteBlocks: [remoteParagraph('remote-recovered', 'Before')],
    });

    await result;
    expect(updateManagedBlock).toHaveBeenCalledWith(
      store,
      'remote-recovered',
      notionParagraph('Recovered edit'),
    );
    expect(store.blockMappings['local-page'][0].notionBlockId).toBe('remote-recovered');
  });
});
