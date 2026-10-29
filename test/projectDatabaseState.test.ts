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

describe('project state source cleanup', () => {
  test('deletes a fully orphaned source block and removes its mapping without rereading children', async () => {
    const orphanSource = sourceNode('jottathing_source_v1:{"blockId":"orphan-block"}');
    const remoteBlock = { id: 'remote-source', node: orphanSource };
    const rig = projectStateHarness([remoteBlock]);
    const content = { type: 'doc', content: [orphanSource] };

    await rig.helpers.syncProjectState(rig.store as never, 'project-row', {
      id: 'project-1',
      stateContent: content,
    } as never);

    expect(rig.deleteManagedBlock).toHaveBeenCalledWith(rig.store, 'remote-source');
    expect(rig.store.blockMappings[rig.key]).toEqual([]);
    expect(rig.listAllBlockChildren).toHaveBeenCalledTimes(1);
    expect(rig.replaceManagedBlocks).toHaveBeenCalledWith(
      rig.store,
      rig.key,
      'state-toggle',
      { type: 'doc', content: [] },
      undefined,
    );
  });

  test('updates a source registry when only some referenced blocks remain', async () => {
    const registry = sourceNode(
      'jottathing_sources_v1:{"live-block":{},"orphan-block":{}}',
    );
    const remoteBlock = { id: 'remote-source', node: registry };
    const rig = projectStateHarness([remoteBlock], ['live-block']);
    const replacement = { object: 'block', type: 'code', code: { rich_text: [] } };

    await rig.helpers.syncProjectState(rig.store as never, 'project-row', {
      id: 'project-1',
      stateContent: { type: 'doc', content: [registry] },
    } as never);

    expect(rig.updateManagedBlock).toHaveBeenCalledWith(rig.store, 'remote-source', replacement);
    expect(rig.store.blockMappings[rig.key][0].newState).toEqual(replacement);
    expect(rig.deleteManagedBlock).not.toHaveBeenCalled();
  });

  test('does not prune a reviewed conflict snapshot', async () => {
    const reviewedContent = {
      type: 'doc',
      attrs: { jottathingConflictResolution: true },
      content: [sourceNode('jottathing_source_v1:{"blockId":"orphan-block"}')],
    };
    const rig = projectStateHarness([]);

    await rig.helpers.syncProjectState(rig.store as never, 'project-row', {
      id: 'project-1',
      stateContent: reviewedContent,
    } as never);

    expect(rig.listAllBlockChildren).not.toHaveBeenCalled();
    expect(rig.deleteManagedBlock).not.toHaveBeenCalled();
    expect(rig.replaceManagedBlocks.mock.calls[0][3]).toBe(reviewedContent);
  });
});

const PROJECT_STATE_KEY = 'project-state:project-1';

function sourceNode(text: string) {
  return { type: 'codeBlock', content: [{ type: 'text', text }] };
}

function projectStateHarness(
  remoteBlocks: Array<{ id: string; node: unknown }>,
  activeBlockIds: string[] = [],
) {
  const toggle = {
    id: 'state-toggle',
    type: 'toggle',
    toggle: { rich_text: [{ type: 'text', plain_text: 'Project State' }] },
  };
  const key = PROJECT_STATE_KEY;
  const store = {
    blockMappings: {
      [key]: [{ notionBlockId: 'remote-source', oldState: null, newState: null }],
      'active-page': activeBlockIds.map((jottathingBlockId) => ({ jottathingBlockId })),
    },
    projectBlocks: { [key]: { blockId: toggle.id, title: 'Project State' } },
    notePages: {},
  };
  const listAllBlockChildren = vi.fn(async () => remoteBlocks as never[]);
  const deleteManagedBlock = vi.fn(async () => undefined);
  const updateManagedBlock = vi.fn(async () => undefined);
  const replaceManagedBlocks = vi.fn(async () => ({ createdBlocks: [] }));
  const helpers = createProjectDatabaseStateHelpers({
    importManagedBlocks: vi.fn(async () => null),
    listAllBlockChildren,
    notionBlocksToTiptapDocument: vi.fn((blocks: Array<{ node: unknown }>) => ({
      type: 'doc',
      content: blocks.map(({ node }) => node),
    }) as never),
    notionRequest: vi.fn(async () => toggle as never),
    replaceManagedBlocks,
    deleteManagedBlock,
    updateManagedBlock,
    tiptapDocumentToNotionBlocks: vi.fn(() => [
      { object: 'block', type: 'code', code: { rich_text: [] } },
    ] as never[]),
  });
  return {
    deleteManagedBlock,
    helpers,
    key,
    listAllBlockChildren,
    replaceManagedBlocks,
    store,
    updateManagedBlock,
  };
}
