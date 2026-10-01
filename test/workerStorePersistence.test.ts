import { describe, expect, it } from 'vitest';
import { createWorkerStorePersistence } from '@/apps/worker/src/services/workerStorePersistence';
import type { WorkerStore, WorkerSupabaseClient } from '@/apps/worker/src/types';

function fakeSupabase(failOn?: 'upsert' | 'select' | 'update', storedState: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let operation = '';
  const builder: Record<string, unknown> & {
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise<unknown>;
  } = {
    upsert: () => { operation = 'upsert'; calls.push(operation); return builder; },
    select: () => { operation = 'select'; calls.push(operation); return builder; },
    update: () => { operation = 'update'; calls.push(operation); return builder; },
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

  return {
    calls,
    client: { from: () => builder } as unknown as WorkerSupabaseClient,
  };
}

const store: WorkerStore = {
  ignoredInkwellDatabaseIds: new Set(),
  installationId: 42,
  parentPages: {},
  projectPages: {},
  projectBlocks: {},
  threadBlocks: {},
  notePages: {},
  blockMappings: {},
  logs: [],
  tokens: undefined,
  inkwellRootPage: undefined,
  inkwellDatabase: undefined,
};

describe('worker sync-state persistence failures', () => {
  it('rejects a failed state read instead of returning an empty store', async () => {
    const { client } = fakeSupabase('select');
    const persistence = createWorkerStorePersistence(client);

    await expect(persistence.readInkwellSyncState(42))
      .rejects.toThrow('Unable to read Inkwell synchronization state.');
  });

  it('rejects a failed state write instead of acknowledging the sync', async () => {
    const { client } = fakeSupabase('update');
    const persistence = createWorkerStorePersistence(client);

    await expect(persistence.writeStore(store))
      .rejects.toThrow('Unable to save Inkwell synchronization state.');
  });

  it('rejects failure to ensure the installation state row', async () => {
    const { client } = fakeSupabase('upsert');
    const persistence = createWorkerStorePersistence(client);

    await expect(persistence.ensureInkwellSyncStateRow(42))
      .rejects.toThrow('Unable to ensure Inkwell synchronization state.');
  });

  it('keeps hostile JSON keys as own metadata keys without changing map prototypes', async () => {
    const hostileMap = JSON.parse(
      '{"__proto__":{"title":"prototype key"},"constructor":{"title":"constructor key"}}',
    ) as WorkerStore['notePages'];
    const { client } = fakeSupabase(undefined, { note_pages_json: hostileMap });
    const persistence = createWorkerStorePersistence(client);
    const state = await persistence.readInkwellSyncState(42);

    expect(Object.getPrototypeOf(state.notePages)).toBeNull();
    expect(Object.keys(state.notePages)).toEqual(['__proto__', 'constructor']);
    expect(state.notePages['__proto__'].title).toBe('prototype key');

    state.notePages['__proto__'] = { ...state.notePages['__proto__'], title: 'saved safely' };

    expect(Object.getPrototypeOf(state.notePages)).toBeNull();
    expect(Object.keys(state.notePages)).toContain('__proto__');
    expect(JSON.parse(JSON.stringify(state.notePages))['__proto__'].title).toBe('saved safely');
    expect(({} as { title?: string }).title).toBeUndefined();
  });
});
