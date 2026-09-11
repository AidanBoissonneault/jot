import { describe, expect, test, vi } from 'vitest';
import { createProjectDatabaseHelpers } from '@/apps/worker/src/projectDatabase';

const expectedProperties = {
  Name: {},
  Status: {},
  Category: {},
  Created: {},
  Updated: {},
  'Created by': {},
  'Last edited by': {},
  'Inkwell ID': {},
  'Managed by Inkwell': {},
};

function database(id: string, dataSourceId: string, lastEditedTime: string) {
  return {
    id,
    data_sources: [{ id: dataSourceId }],
    last_edited_time: lastEditedTime,
    parent: { type: 'workspace', workspace: true },
    title: [{ plain_text: 'Inkwell' }],
  };
}

function helpers(notionRequest: ReturnType<typeof vi.fn>) {
  return createProjectDatabaseHelpers({
    appendLog: vi.fn(),
    createWorkspacePage: vi.fn(),
    hash: vi.fn(),
    isNotionObjectNotFound: (error: { status?: number; code?: string }) =>
      error?.status === 404 || error?.code === 'object_not_found',
    listAllBlockChildren: vi.fn(),
    notionBlocksToTiptapDocument: vi.fn(),
    notionRequest,
    replaceManagedBlocks: vi.fn(),
    tiptapDocumentToNotionBlocks: vi.fn(),
  });
}

describe('Inkwell project database selection', () => {
  test('keeps the saved database reference on transient lookup failures', async () => {
    const transientError = Object.assign(new Error('Notion unavailable'), { status: 503 });
    const notionRequest = vi.fn(async (store, endpoint) => {
      if (endpoint === '/databases/db-saved') throw transientError;
      throw new Error(`Unexpected request: ${endpoint}`);
    });
    const store = {
      inkwellDatabase: { databaseId: 'db-saved', dataSourceId: 'ds-saved' },
      logs: [],
    };

    await expect(helpers(notionRequest).ensureProjectDatabase(store)).rejects.toBe(transientError);
    expect(notionRequest).toHaveBeenCalledTimes(1);
    expect(store.inkwellDatabase.databaseId).toBe('db-saved');
  });

  test('searches every result page and adopts the database with the most managed projects', async () => {
    const emptyDatabase = database('db-empty', 'ds-empty', '2026-09-11T12:00:00.000Z');
    const mainDatabase = database('db-main', 'ds-main', '2026-09-10T12:00:00.000Z');
    const notionRequest = vi.fn(async (store, endpoint, init = {}) => {
      if (endpoint === '/search' && !init.body?.start_cursor) {
        return { results: [emptyDatabase], has_more: true, next_cursor: 'next' };
      }
      if (endpoint === '/search' && init.body?.start_cursor === 'next') {
        return { results: [mainDatabase], has_more: false };
      }
      if (endpoint === '/data_sources/ds-empty/query') {
        return { results: [], has_more: false };
      }
      if (endpoint === '/data_sources/ds-main/query') {
        return { results: [{ id: 'one' }, { id: 'two' }, { id: 'three' }], has_more: false };
      }
      if (endpoint === '/data_sources/ds-main') {
        return { properties: expectedProperties };
      }
      if (endpoint === '/views?database_id=db-main') {
        return {
          results: [
            { name: 'Active Projects' },
            { name: 'By Category' },
            { name: 'All Projects' },
          ],
        };
      }
      throw new Error(`Unexpected request: ${endpoint}`);
    });
    const store: { logs: unknown[]; inkwellDatabase?: { databaseId: string } } = { logs: [] };

    const selected = await helpers(notionRequest).ensureProjectDatabase(store);

    expect(selected.databaseId).toBe('db-main');
    expect(store.inkwellDatabase?.databaseId).toBe('db-main');
    const searchCalls = notionRequest.mock.calls.filter(([, endpoint]) => endpoint === '/search');
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls[1][2].body.start_cursor).toBe('next');
  });
});
