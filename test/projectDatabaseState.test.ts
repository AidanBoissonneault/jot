import { describe, expect, test, vi } from 'vitest';
import { createProjectDatabaseStateHelpers } from '@/apps/worker/src/projectDatabaseState';

describe('thread content reload identity', () => {
  test('fails the reload when project-state children cannot be read', async () => {
    const readFailure = new Error('Notion is temporarily unavailable');
    const helpers = createProjectDatabaseStateHelpers({
      importManagedBlocks: vi.fn(async () => null),
      listAllBlockChildren: vi.fn(async () => { throw readFailure; }),
      notionBlocksToTiptapDocument: vi.fn(() => ({ type: 'doc', content: [] })),
      notionRequest: vi.fn(),
      replaceManagedBlocks: vi.fn(),
    });

    await expect(helpers.importProjectState(
      { blockMappings: {}, projectBlocks: {} } as never,
      { id: 'project-row' } as never,
      { id: 'project-local', stateContent: { type: 'doc', content: [] } } as never,
      { id: 'state-block', last_edited_time: 'remote-time' } as never,
    )).rejects.toBe(readFailure);
  });

  test('fails the reload when thread children cannot be read', async () => {
    const readFailure = new Error('Notion is temporarily unavailable');
    const helpers = createProjectDatabaseStateHelpers({
      importManagedBlocks: vi.fn(async () => null),
      listAllBlockChildren: vi.fn(async () => { throw readFailure; }),
      notionBlocksToTiptapDocument: vi.fn(() => ({ type: 'doc', content: [] })),
      notionRequest: vi.fn(),
      replaceManagedBlocks: vi.fn(),
    });

    await expect(helpers.pageFromThreadBlock(
      { blockMappings: {}, notePages: {}, threadBlocks: {} } as never,
      { id: 'project-local', updatedAt: 'remote-time' } as never,
      { id: 'project-row' } as never,
      {
        id: 'thread-remote',
        type: 'toggle',
        toggle: { rich_text: [{ type: 'text', plain_text: 'Remote page' }] },
      } as never,
    )).rejects.toBe(readFailure);
  });

  test('restores stable local block IDs and mappings while importing a thread', async () => {
    const children = [{
      id: 'notion-paragraph-1',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', plain_text: 'Professor Information' }] },
    }] as never[];
    const store = { blockMappings: {}, notePages: {}, threadBlocks: {} };
    const importedContent = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        attrs: { jottathingBlockId: 'stable-local-block-1' },
        content: [{ type: 'text', text: 'Professor Information' }],
      }],
    };
    const importManagedBlocks = vi.fn(async (targetStore, page) => {
      targetStore.blockMappings[page.id] = [{
        localPageId: page.id,
        jottathingBlockId: 'stable-local-block-1',
        localNodeId: 'stable-local-block-1',
        notionBlockId: 'notion-paragraph-1',
        kind: 'paragraph',
        order: 0,
        lastSyncedHash: 'remote-hash',
        oldState: null,
        newState: null,
      }];
      return importedContent;
    });
    const helpers = createProjectDatabaseStateHelpers({
      importManagedBlocks,
      listAllBlockChildren: vi.fn(async () => children),
      notionBlocksToTiptapDocument: vi.fn(() => ({ type: 'doc', content: [] })),
      notionRequest: vi.fn(),
      replaceManagedBlocks: vi.fn(),
    });

    const page = await helpers.pageFromThreadBlock(
      store as never,
      { id: 'project-local', updatedAt: '2026-09-28T12:00:00.000Z' } as never,
      { id: 'project-remote' } as never,
      {
        id: 'thread-remote',
        type: 'toggle',
        toggle: { rich_text: [{ type: 'text', plain_text: 'Professor Information' }] },
        last_edited_time: '2026-09-28T12:00:00.000Z',
      } as never,
    );

    expect(page.content).toEqual(importedContent);
    expect(page.content.content[0].attrs?.jottathingBlockId).toBe('stable-local-block-1');
    expect(store.blockMappings[page.id][0].notionBlockId).toBe('notion-paragraph-1');
    expect(importManagedBlocks).toHaveBeenCalledWith(
      store,
      { id: page.id, notionPageId: 'thread-remote' },
      children,
    );
  });
});

describe('thread toggle recovery', () => {
  test('does not rediscover the rejected toggle when Notion lists it as active', async () => {
    const oldToggle = {
      id: 'rejected-toggle',
      type: 'toggle',
      toggle: { rich_text: [{ type: 'text', plain_text: 'Notes' }] },
    };
    const freshToggle = {
      id: 'fresh-toggle',
      type: 'toggle',
      toggle: { rich_text: [{ type: 'text', plain_text: 'Notes' }] },
    };
    const store = {
      blockMappings: {},
      threadBlocks: { 'thread:page-1': { blockId: 'rejected-toggle' } },
    };
    const notionRequest = vi.fn(async (_store: unknown, endpoint: string) => {
      if (endpoint === '/blocks/fresh-toggle') return freshToggle;
      if (endpoint === '/blocks/project-row/children') return { results: [freshToggle] };
      return oldToggle;
    });
    const helpers = createProjectDatabaseStateHelpers({
      importManagedBlocks: vi.fn(async () => null),
      listAllBlockChildren: vi.fn(async () => [oldToggle] as never[]),
      notionBlocksToTiptapDocument: vi.fn(() => ({ type: 'doc', content: [] })),
      notionRequest,
      replaceManagedBlocks: vi.fn(),
    });
    const page = {
      id: 'page-1',
      title: 'Notes',
      content: { type: 'doc', content: [] },
    } as never;

    const recovered = await helpers.ensureThreadToggle(store as never, 'project-row', page, {
      excludedBlockIds: new Set(['rejected-toggle']),
    });
    const repeated = await helpers.ensureThreadToggle(store as never, 'project-row', page, {
      excludedBlockIds: new Set(['rejected-toggle']),
    });

    expect(recovered.id).toBe('fresh-toggle');
    expect(repeated.id).toBe('fresh-toggle');
    expect(notionRequest).toHaveBeenCalledWith(
      store,
      '/blocks/project-row/children',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});
