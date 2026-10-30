import { describe, expect, it } from 'vitest';
import { createWorkerStorePersistence } from '@/apps/worker/src/services/workerStorePersistence';
import type { WorkerStore, WorkerSupabaseClient } from '@/apps/worker/src/types';

function fakeSupabase(failOn?: 'ensure' | 'select' | 'write', storedState: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const upserts: Array<{ payload: unknown; options?: unknown }> = [];
  let operation = '';
  const builder: Record<string, unknown> & {
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise<unknown>;
  } = {
    upsert: (payload: unknown, options?: { ignoreDuplicates?: boolean }) => {
      operation = options?.ignoreDuplicates ? 'ensure' : 'write';
      calls.push(operation);
      upserts.push({ payload, options });
      return builder;
    },
    select: () => { operation = 'select'; calls.push(operation); return builder; },
    eq: () => builder,
    single: async () => result(),
    then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
  };

  function result() {
    return {
      data: operation === 'select' ? {
        installation_id: 42,
        note_pages_json: {},
        block_mappings_json: {},
        parent_pages_json: {},
        project_pages_json: {},
        project_blocks_json: {},
        thread_blocks_json: {},
        ...storedState,
      } : null,
      error: failOn === operation ? new Error('database failure') : null,
    };
  }

  return { calls, client: { from: () => builder } as unknown as WorkerSupabaseClient, upserts };
}

const store: WorkerStore = {
  ignoredJottathingDatabaseIds: new Set(),
  installationId: 42,
  parentPages: {},
  projectPages: {},
  projectBlocks: {},
  threadBlocks: {},
  notePages: {},
  blockMappings: {},
  logs: [],
  tokens: undefined,
  jottathingRootPage: undefined,
  jottathingDatabase: undefined,
};

describe('worker sync-state persistence failures', () => {
  it('rejects a failed state read instead of returning an empty store', async () => {
    const { client } = fakeSupabase('select');
    const persistence = createWorkerStorePersistence(client);

    await expect(persistence.readJottathingSyncState(42))
      .rejects.toThrow('Unable to read Jottathing synchronization state.');
  });

  it('rejects a failed state write instead of acknowledging the sync', async () => {
    const { client } = fakeSupabase('write');
    const persistence = createWorkerStorePersistence(client);

    await expect(persistence.writeStore(store))
      .rejects.toThrow('Unable to save Jottathing synchronization state.');
  });

  it('rejects failure to ensure the installation state row', async () => {
    const { client } = fakeSupabase('ensure');
    const persistence = createWorkerStorePersistence(client);

    await expect(persistence.ensureJottathingSyncStateRow(42))
      .rejects.toThrow('Unable to ensure Jottathing synchronization state.');
  });

  it('keeps hostile JSON keys as own metadata keys without changing map prototypes', async () => {
    const hostileMap = JSON.parse(
      '{"__proto__":{"title":"prototype key"},"constructor":{"title":"constructor key"}}',
    ) as WorkerStore['notePages'];
    const { client } = fakeSupabase(undefined, { note_pages_json: hostileMap });
    const persistence = createWorkerStorePersistence(client);
    const state = await persistence.readJottathingSyncState(42);

    expect(Object.getPrototypeOf(state.notePages)).toBeNull();
    expect(Object.keys(state.notePages)).toEqual(['__proto__', 'constructor']);
    expect(state.notePages['__proto__'].title).toBe('prototype key');

    state.notePages['__proto__'] = { ...state.notePages['__proto__'], title: 'saved safely' };

    expect(Object.getPrototypeOf(state.notePages)).toBeNull();
    expect(Object.keys(state.notePages)).toContain('__proto__');
    expect(JSON.parse(JSON.stringify(state.notePages))['__proto__'].title).toBe('saved safely');
    expect(({} as { title?: string }).title).toBeUndefined();
  });

  it('normalizes mapping fields and preserves malformed serialized values', async () => {
    const { client } = fakeSupabase(undefined, {
      block_mappings_json: {
        page: [null, 'invalid', { lastSyncedHash: 42 }],
        malformedCollection: { retained: true },
      },
    });
    const persistence = createWorkerStorePersistence(client);

    const state = await persistence.readJottathingSyncState(42);

    expect(state.blockMappings.page).toEqual([
      null,
      'invalid',
      { lastSyncedHash: '', newState: null, oldState: null },
    ]);
    expect(state.blockMappings.malformedCollection).toEqual({ retained: true });
  });

  it('writes synchronization state with one installation-keyed upsert', async () => {
    const { calls, client, upserts } = fakeSupabase();
    const persistence = createWorkerStorePersistence(client);
    const mapping = (localBaselineAcknowledged: boolean) => ({
      jottathingBlockId: 'block',
      kind: 'paragraph',
      lastSyncedHash: 'hash',
      localPageId: 'page',
      localBaselineAcknowledged,
      newState: { type: 'paragraph' } as never,
      notionBlockId: 'notion-block',
      oldState: { type: 'paragraph' } as never,
      order: 0,
    });

    await persistence.writeStore({
      ...store,
      blockMappings: { page: [mapping(true), mapping(false)] },
    });

    expect(calls).toEqual(['write']);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.options).toEqual({ onConflict: 'installation_id' });
    expect(upserts[0]?.payload).toMatchObject({
      installation_id: 42,
      note_pages_json: {},
      block_mappings_json: {
        page: [
          { jottathingBlockId: 'block', localBaselineAcknowledged: true },
          {
            jottathingBlockId: 'block',
            localBaselineAcknowledged: false,
            lastSyncedHash: 'hash',
            newState: { type: 'paragraph' },
            oldState: { type: 'paragraph' },
          },
        ],
      },
      parent_pages_json: {},
      project_pages_json: {},
      project_blocks_json: {},
      thread_blocks_json: {},
    });
    const payload = upserts[0]?.payload as {
      block_mappings_json: { page: Array<Record<string, unknown>> };
    };
    expect(payload.block_mappings_json.page[0]).not.toHaveProperty('lastSyncedHash');
    expect(payload.block_mappings_json.page[0]).not.toHaveProperty('newState');
    expect(payload.block_mappings_json.page[0]).not.toHaveProperty('oldState');
  });
});
